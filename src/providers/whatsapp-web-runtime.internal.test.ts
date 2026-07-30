import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  createAuth,
  parseAuth,
  type WrenchAuth,
} from "../auth";
import type { OperationInput, WebSessionRecipe } from "../model";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "../operation-deadline";
import {
  executeWhatsAppWebOperation,
  pairWhatsAppAuth,
  planWhatsAppPairing,
  planWhatsAppReadCommand,
  planWhatsAppSyncOnce,
  probeWhatsAppWebSubject,
  syncWhatsAppAuthOnce,
  validateWhatsAppStoreDirectory,
  type WacliInvocation,
  type WhatsAppWebRuntimeDependencies,
} from "./whatsapp-web-runtime";

const ACCOUNT_JID = "15551234567@s.whatsapp.net";
const CHAT_JID = "15557654321@s.whatsapp.net";
const MESSAGE_ID = "3EB0SYNTHETICMESSAGE";
const ZERO_TIME = "0001-01-01T00:00:00Z";

class FakeMonotonicClock implements OperationDeadlineClock {
  #nowMs = 0;
  #nextId = 1;
  readonly #scheduled = new Map<number, {
    readonly at: number;
    readonly callback: () => void;
  }>();

  readonly now = (): number => this.#nowMs;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#scheduled.set(id, { at: this.#nowMs + delayMs, callback });
    return () => {
      this.#scheduled.delete(id);
    };
  };

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, value]) => value.at <= this.#nowMs)
        .sort((left, right) =>
          left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }
}

function success(data: unknown): unknown {
  return { success: true, data, error: null };
}

function chat(): unknown {
  return {
    jid: CHAT_JID,
    kind: "dm",
    name: "Fixture",
    last_message_ts: "2026-07-23T12:00:00Z",
    archived: false,
    pinned: false,
    muted_until: 0,
    unread: false,
    unread_count: 0,
  };
}

function message(overrides: Record<string, unknown> = {}): unknown {
  return {
    ChatJID: CHAT_JID,
    ChatName: "Fixture",
    MsgID: MESSAGE_ID,
    SenderJID: ACCOUNT_JID,
    SenderName: "Sender",
    Timestamp: "2026-07-23T12:00:00.123Z",
    FromMe: false,
    Text: "hello",
    DisplayText: "hello",
    IsForwarded: false,
    ForwardingScore: 0,
    ReactionToID: "",
    ReactionEmoji: "",
    MediaType: "",
    MediaCaption: "",
    Filename: "",
    MimeType: "",
    DirectPath: "",
    LocalPath: "",
    DownloadedAt: ZERO_TIME,
    Starred: false,
    StarredAt: ZERO_TIME,
    Revoked: false,
    DeletedForMe: false,
    Snippet: "",
    ...overrides,
  };
}

function privateDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "wrench-whatsapp-store."));
  chmodSync(path, 0o700);
  return realpathSync(path);
}

function auth(path: string, subject?: string): WrenchAuth {
  return {
    schemaVersion: 1,
    id: "whatsapp-test",
    kind: "linked-device-store",
    provider: "whatsapp",
    path,
    ...(subject === undefined ? {} : { subject }),
  };
}

function recipe(action: WebSessionRecipe["action"]): WebSessionRecipe {
  return {
    site: "whatsapp",
    action,
    contractVersion: 1,
    timeoutMs: 1_000,
    maxOutputBytes: 1024 * 1024,
  };
}

function runner(
  calls: WacliInvocation[],
  response: (invocation: WacliInvocation) => unknown,
): NonNullable<WhatsAppWebRuntimeDependencies["run"]> {
  return (invocation) => {
    calls.push(invocation);
    invocation.onSpawn?.();
    const value = response(invocation);
    return Promise.resolve({
      exitCode: 0,
      stdout: typeof value === "string"
        ? value
        : `${JSON.stringify(value)}\n`,
      stderr: "",
    });
  };
}

async function expectRejected(
  promise: Promise<unknown>,
  messageFragment: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  if (!(rejection instanceof Error)) {
    throw new Error("expected operation to reject with an Error");
  }
  expect(rejection.message).toContain(messageFragment);
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ESRCH"
      ) return;
      throw error;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`WhatsApp fixture process ${pid} survived cancellation`);
}

describe("WhatsApp linked-device auth storage", () => {
  test("creates and parses a realm that is distinct from browser cookies", () => {
    const path = privateDirectory();
    try {
      const created = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: path,
        subject: "whatsapp:pn:15551234567",
      });
      expect(created).toMatchObject({
        schemaVersion: 1,
        id: "whatsapp-main",
        kind: "linked-device-store",
        provider: "whatsapp",
        path,
        subject: "whatsapp:pn:15551234567",
      });
      if (created.kind !== "linked-device-store") {
        throw new Error("created WhatsApp auth has the wrong kind");
      }
      expect(created.realmKey).toMatch(/^[a-f0-9]{64}$/u);
      expect(parseAuth(created)).toEqual(created);
      expect(JSON.stringify(created)).not.toContain("cookie");
      expect(JSON.stringify(created)).not.toContain("browser");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("enforces owned private real stores and private database files", async () => {
    const path = privateDirectory();
    try {
      writeFileSync(join(path, "session.db"), "");
      writeFileSync(join(path, "wacli.db"), "");
      chmodSync(join(path, "session.db"), 0o600);
      chmodSync(join(path, "wacli.db"), 0o600);
      expect(await validateWhatsAppStoreDirectory(path, "projection")).toBe(path);
      chmodSync(join(path, "session.db"), 0o644);
      await expectRejected(
        validateWhatsAppStoreDirectory(path, "projection"),
        "group or world",
      );
      chmodSync(join(path, "session.db"), 0o600);
      symlinkSync(join(path, "session.db"), join(path, "alias.db"));
      await expectRejected(
        validateWhatsAppStoreDirectory(path, "probe"),
        "unsafe entry",
      );
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("pairing creates a mode-0700 store and emits one fixed onboarding plan", async () => {
    const root = privateDirectory();
    const path = join(root, "new-linked-device");
    const calls: WacliInvocation[] = [];
    try {
      const plan = await planWhatsAppPairing(auth(path), {
        phone: "+15551234567",
        dependencies: {
          binaryPath: "/fixture/wacli",
          run: runner(calls, () => "0.13.0\n"),
        },
      });
      expect(lstatSync(path).mode & 0o777).toBe(0o700);
      expect(plan).toMatchObject({
        binary: "/fixture/wacli",
        store: path,
        arguments: [
          "--store",
          path,
          "--timeout",
          "10m",
          "auth",
          "--idle-exit",
          "30s",
          "--qr-format",
          "terminal",
          "--phone",
          "+15551234567",
        ],
      });
      expect(plan.environment).toMatchObject({
        WACLI_SYNC_MAX_MESSAGES: "200000",
        WACLI_SYNC_MAX_DB_SIZE: "2GB",
      });
      expect(plan.environment).not.toHaveProperty("WACLI_READONLY");
      expect(calls.map((call) => call.arguments)).toEqual([["version"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("awaits the durable attempt boundary before interactive pairing", async () => {
    const root = privateDirectory();
    const path = join(root, "new-linked-device");
    const calls: WacliInvocation[] = [];
    const events: string[] = [];
    try {
      const subject = await pairWhatsAppAuth(auth(path), {
        dependencies: {
          binaryPath: "/fixture/wacli",
          run: runner(calls, (invocation) => {
            if (invocation.arguments[0] === "version") {
              events.push("read-only-version");
              return "0.13.0\n";
            }
            events.push("read-only-status");
            return success({
              authenticated: true,
              linked_jid: ACCOUNT_JID,
              phone: "15551234567",
            });
          }),
          runInteractive: () => {
            events.push("external-pair");
            return Promise.resolve(0);
          },
        },
        attempt: {
          journalId: "00000000-0000-4000-8000-000000000001",
          beforeExternalBegin: async () => {
            await Promise.resolve();
            events.push("journal-durable");
          },
        },
      });

      expect(subject).toBe("whatsapp:pn:15551234567");
      expect(events).toEqual([
        "read-only-version",
        "journal-durable",
        "external-pair",
        "read-only-version",
        "read-only-status",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps pairing preflight outside the attempt and blocks pairing when the boundary fails", async () => {
    const root = privateDirectory();
    const path = join(root, "new-linked-device");
    let boundaryCalls = 0;
    let interactiveCalls = 0;
    try {
      await expectRejected(
        pairWhatsAppAuth(auth(path), {
          dependencies: {
            binaryPath: "/fixture/wacli",
            run: runner([], () => "unexpected-version\n"),
            runInteractive: () => {
              interactiveCalls += 1;
              return Promise.resolve(0);
            },
          },
          attempt: {
            journalId: "00000000-0000-4000-8000-000000000002",
            beforeExternalBegin: () => {
              boundaryCalls += 1;
              return Promise.resolve();
            },
          },
        }),
        "version",
      );
      expect(boundaryCalls).toBe(0);
      expect(interactiveCalls).toBe(0);

      await expectRejected(
        pairWhatsAppAuth(auth(path), {
          dependencies: {
            binaryPath: "/fixture/wacli",
            run: runner([], () => "0.13.0\n"),
            runInteractive: () => {
              interactiveCalls += 1;
              return Promise.resolve(0);
            },
          },
          attempt: {
            journalId: "00000000-0000-4000-8000-000000000003",
            beforeExternalBegin: () => {
              boundaryCalls += 1;
              return Promise.reject(new Error("journal boundary unavailable"));
            },
          },
        }),
        "journal boundary unavailable",
      );
      expect(boundaryCalls).toBe(1);
      expect(interactiveCalls).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("WhatsApp zero-network read plans", () => {
  test("maps only bounded semantic inputs to fixed local projection commands", () => {
    expect(planWhatsAppReadCommand("messaging.list", {
      folder: "archived",
      limit: 25,
    })).toEqual({
      action: "messaging.list",
      folder: "archived",
      limit: 25,
      command: ["chats", "list", "--limit", "25", "--archived"],
    });
    expect(planWhatsAppReadCommand("messaging.read", {
      conversation_jid: CHAT_JID,
      limit: 75,
    })).toEqual({
      action: "messaging.read",
      conversationJid: CHAT_JID,
      limit: 75,
      command: [
        "messages",
        "list",
        "--chat",
        CHAT_JID,
        "--limit",
        "75",
      ],
    });
    expect(planWhatsAppReadCommand("media.read", {
      conversation_jid: CHAT_JID,
      message_id: "MSG-1",
    })).toEqual({
      action: "media.read",
      conversationJid: CHAT_JID,
      messageId: "MSG-1",
      command: [
        "messages",
        "show",
        "--chat",
        CHAT_JID,
        "--id",
        "MSG-1",
      ],
    });
  });

  test("rejects arbitrary selectors, unsafe identifiers, and unbounded pages", () => {
    const cases: readonly [
      Parameters<typeof planWhatsAppReadCommand>[0],
      OperationInput,
    ][] = [
      ["messaging.list", { folder: "requests" }],
      ["messaging.list", { limit: 101 }],
      ["messaging.read", {
        conversation_jid: "--store=/tmp/escape",
      }],
      ["media.read", {
        conversation_jid: CHAT_JID,
        message_id: "../session.db",
      }],
    ];
    for (const [action, input] of cases) {
      expect(() => planWhatsAppReadCommand(action, input)).toThrow();
    }
  });

  test("current-account probe uses only exact read-only status argv and env", async () => {
    const path = privateDirectory();
    const calls: WacliInvocation[] = [];
    try {
      const subject = await probeWhatsAppWebSubject(auth(path), {
        dependencies: {
          binaryPath: "/fixture/wacli",
          run: runner(calls, (invocation) =>
            invocation.arguments[0] === "version"
              ? "0.13.0\n"
              : {
                success: true,
                data: {
                  authenticated: true,
                  linked_jid: ACCOUNT_JID,
                  phone: "15551234567",
                },
                error: null,
              }),
        },
        timeoutMs: 1_000,
      });
      expect(subject).toBe("whatsapp:pn:15551234567");
      expect(calls).toHaveLength(2);
      const statusInvocation = calls[1];
      if (statusInvocation === undefined) {
        throw new Error("expected the WhatsApp current-account status invocation");
      }
      const statusTimeout = statusInvocation.arguments[6];
      if (statusTimeout === undefined) {
        throw new Error("expected the WhatsApp current-account timeout argument");
      }
      expect(statusInvocation.arguments).toEqual([
        "--store",
        path,
        "--read-only",
        "--json",
        "--full",
        "--timeout",
        statusTimeout,
        "auth",
        "status",
      ]);
      expect(statusTimeout).toMatch(/^[1-9]\d*ms$/u);
      const statusTimeoutMs = Number.parseInt(statusTimeout, 10);
      expect(statusTimeoutMs).toBeGreaterThan(0);
      expect(statusTimeoutMs).toBeLessThanOrEqual(1_000);
      expect(statusInvocation.timeoutMs).toBe(statusTimeoutMs);
      expect(statusInvocation.environment).toEqual({
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        WACLI_READONLY: "1",
      });
      expect(JSON.stringify(calls)).not.toContain("cookie");
      expect(JSON.stringify(calls)).not.toContain("browser");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("does not spawn a protocol child for an already-cancelled web operation", async () => {
    const caller = new AbortController();
    caller.abort("private cancellation reason");
    const operationDeadline = new OperationDeadline(1_000, {
      signal: caller.signal,
    });
    const calls: WacliInvocation[] = [];
    try {
      await expectRejected(
        executeWhatsAppWebOperation(
          recipe("messaging.list"),
          { limit: 1 },
          auth("/does/not/exist", "whatsapp:pn:15551234567"),
          {
            operationDeadline,
            dependencies: {
              binaryPath: "/fixture/wacli",
              run: runner(calls, () => {
                throw new Error("cancelled operation must not spawn");
              }),
            },
          },
        ),
        "was cancelled",
      );
      expect(calls).toEqual([]);
    } finally {
      operationDeadline.dispose();
    }
  });

  test("shares one descending timeout budget across version, auth, and projection children", async () => {
    const path = privateDirectory();
    const clock = new FakeMonotonicClock();
    const operationDeadline = new OperationDeadline(100, { clock });
    const calls: WacliInvocation[] = [];
    try {
      writeFileSync(join(path, "session.db"), "");
      writeFileSync(join(path, "wacli.db"), "");
      chmodSync(join(path, "session.db"), 0o600);
      chmodSync(join(path, "wacli.db"), 0o600);
      const result = await executeWhatsAppWebOperation(
        recipe("messaging.list"),
        { limit: 1 },
        auth(path, "whatsapp:pn:15551234567"),
        {
          operationDeadline,
          dependencies: {
            binaryPath: "/fixture/wacli",
            run: runner(calls, (invocation) => {
              expect(invocation.signal).toBe(operationDeadline.signal);
              if (invocation.arguments[0] === "version") {
                clock.advance(15);
                return "0.13.0\n";
              }
              if (invocation.arguments.includes("status")) {
                clock.advance(25);
                return success({
                  authenticated: true,
                  linked_jid: ACCOUNT_JID,
                  phone: "15551234567",
                });
              }
              if (invocation.arguments.includes("chats")) {
                clock.advance(20);
                return success([chat()]);
              }
              throw new Error("unexpected WhatsApp fixture command");
            }),
          },
        },
      );

      expect(result.status).toBe("succeeded");
      expect(calls.map((call) => call.timeoutMs)).toEqual([100, 85, 60]);
      expect(calls[1]?.arguments).toContain("85ms");
      expect(calls[2]?.arguments).toContain("60ms");
      expect(operationDeadline.remainingTimeMs()).toBe(40);
    } finally {
      operationDeadline.dispose();
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("does not launch auth or projection children after the shared deadline expires", async () => {
    const path = privateDirectory();
    const clock = new FakeMonotonicClock();
    const operationDeadline = new OperationDeadline(50, { clock });
    const calls: WacliInvocation[] = [];
    try {
      writeFileSync(join(path, "session.db"), "");
      writeFileSync(join(path, "wacli.db"), "");
      chmodSync(join(path, "session.db"), 0o600);
      chmodSync(join(path, "wacli.db"), 0o600);
      await expectRejected(
        executeWhatsAppWebOperation(
          recipe("messaging.list"),
          { limit: 1 },
          auth(path, "whatsapp:pn:15551234567"),
          {
            operationDeadline,
            dependencies: {
              binaryPath: "/fixture/wacli",
              run: runner(calls, (invocation) => {
                if (invocation.arguments[0] !== "version") {
                  throw new Error("expired operation launched a later child");
                }
                clock.advance(50);
                return "0.13.0\n";
              }),
            },
          },
        ),
        "timed out",
      );
      expect(calls.map((call) => call.arguments)).toEqual([["version"]]);
    } finally {
      operationDeadline.dispose();
      rmSync(path, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "kills a running protocol child when the shared operation is cancelled",
    async () => {
      const path = privateDirectory();
      const fixture = join(path, "blocking-wacli");
      const pidPath = `${fixture}.pid`;
      const caller = new AbortController();
      const operationDeadline = new OperationDeadline(10_000, {
        signal: caller.signal,
      });
      let pid: number | null = null;
      try {
        writeFileSync(join(path, "session.db"), "");
        writeFileSync(join(path, "wacli.db"), "");
        writeFileSync(
          fixture,
          [
            "#!/bin/sh",
            "/bin/sleep 30 &",
            "descendant=$!",
            `printf '%s %s\\n' "$$" "$descendant" > ${JSON.stringify(pidPath)}`,
            "wait \"$descendant\"",
            "",
          ].join("\n"),
        );
        chmodSync(join(path, "session.db"), 0o600);
        chmodSync(join(path, "wacli.db"), 0o600);
        chmodSync(fixture, 0o700);
        const execution = executeWhatsAppWebOperation(
          {
            ...recipe("messaging.list"),
            timeoutMs: 10_000,
          },
          { limit: 1 },
          auth(path, "whatsapp:pn:15551234567"),
          {
            operationDeadline,
            dependencies: { binaryPath: fixture },
          },
        );

        await waitForFile(pidPath);
        const processIds = readFileSync(pidPath, "utf8")
          .trim()
          .split(" ")
          .map(Number);
        const parentProcessId = processIds[0];
        const descendantProcessId = processIds[1];
        if (
          parentProcessId === undefined
          || descendantProcessId === undefined
        ) throw new Error("WhatsApp fixture omitted its process identities");
        expect(
          Number.isSafeInteger(parentProcessId) && parentProcessId > 0,
        ).toBeTrue();
        expect(
          Number.isSafeInteger(descendantProcessId) && descendantProcessId > 0,
        ).toBeTrue();
        pid = parentProcessId;
        caller.abort();
        await expectRejected(execution, "was cancelled");
        await waitForProcessExit(parentProcessId);
        await waitForProcessExit(descendantProcessId);
      } finally {
        caller.abort();
        operationDeadline.dispose();
        if (pid !== null) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // The deadline path already terminated and reaped the process.
          }
        }
        rmSync(path, { recursive: true, force: true });
      }
    },
  );

  test("executes paired chat, message, and media reads through read-only local projections", async () => {
    const path = privateDirectory();
    const calls: WacliInvocation[] = [];
    try {
      writeFileSync(join(path, "session.db"), "");
      writeFileSync(join(path, "wacli.db"), "");
      chmodSync(join(path, "session.db"), 0o600);
      chmodSync(join(path, "wacli.db"), 0o600);
      const dependencies = {
        binaryPath: "/fixture/wacli",
        run: runner(calls, (invocation) => {
          if (invocation.arguments[0] === "version") return "0.13.0\n";
          if (invocation.arguments.includes("status")) {
            return success({
              authenticated: true,
              linked_jid: ACCOUNT_JID,
              phone: "15551234567",
            });
          }
          if (invocation.arguments.includes("chats")) return success([chat()]);
          if (invocation.arguments.includes("show")) {
            return success(message({
              MediaType: "image",
              Filename: "fixture.jpg",
              MimeType: "image/jpeg",
              DirectPath: "/v/t62.7118-24/private-token",
              LocalPath: "/private/store/media/fixture.jpg",
              DownloadedAt: "2026-07-23T12:00:01Z",
            }));
          }
          if (invocation.arguments.includes("messages")) {
            return success({ messages: [message()], fts: true });
          }
          throw new Error("unexpected WhatsApp fixture command");
        }),
      } satisfies WhatsAppWebRuntimeDependencies;
      const list = await executeWhatsAppWebOperation(
        recipe("messaging.list"),
        { limit: 1 },
        auth(path, "whatsapp:pn:15551234567"),
        { dependencies },
      );
      const read = await executeWhatsAppWebOperation(
        recipe("messaging.read"),
        { conversation_jid: CHAT_JID, limit: 1 },
        auth(path, "whatsapp:pn:15551234567"),
        { dependencies },
      );
      const media = await executeWhatsAppWebOperation(
        recipe("media.read"),
        { conversation_jid: CHAT_JID, message_id: MESSAGE_ID },
        auth(path, "whatsapp:pn:15551234567"),
        { dependencies },
      );
      for (const result of [list, read, media]) {
        expect(result.status).toBe("succeeded");
        expect(result.dispatchStarted).toBe(false);
        expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      }
      expect(list.output).toMatchObject({
        accountSubject: "whatsapp:pn:15551234567",
        projection: "local-store",
        chats: [{ jid: CHAT_JID }],
      });
      expect(read.output).toMatchObject({
        accountSubject: "whatsapp:pn:15551234567",
        projection: "local-store",
        conversationJid: CHAT_JID,
        messages: [{ chatJid: CHAT_JID, messageId: MESSAGE_ID }],
      });
      expect(media.output).toMatchObject({
        accountSubject: "whatsapp:pn:15551234567",
        projection: "local-store",
        conversationJid: CHAT_JID,
        messageId: MESSAGE_ID,
        media: {
          type: "image",
          filename: "fixture.jpg",
          mimeType: "image/jpeg",
          downloaded: true,
        },
      });
      expect(JSON.stringify(media.output)).not.toContain("private-token");
      expect(JSON.stringify(media.output)).not.toContain("/private/store");
      expect(calls).toHaveLength(9);
      for (const call of calls.filter((entry) => entry.arguments[0] !== "version")) {
        expect(call.arguments).toContain("--read-only");
        expect(call.environment.WACLI_READONLY).toBe("1");
      }
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("all capture-required operations fail before binary, store, or dispatch", async () => {
    const calls: WacliInvocation[] = [];
    let beforeDispatch = 0;
    for (const [action, input] of [
      ["reactions.set", {
        conversation_jid: CHAT_JID,
        message_id: "MSG-1",
        reaction: "👍",
      }],
      ["content.save", {
        conversation_jid: CHAT_JID,
        message_id: "MSG-1",
        saved: true,
      }],
      ["messaging.send", {
        conversation_jid: CHAT_JID,
        body: "must not dispatch",
      }],
      ["content.edit", {
        conversation_jid: CHAT_JID,
        message_id: "MSG-1",
        body: "must not dispatch",
      }],
      ["content.share", {
        source_conversation_jid: CHAT_JID,
        message_id: "MSG-1",
        destination_jid: CHAT_JID,
      }],
    ] as const) {
      await expectRejected(
        executeWhatsAppWebOperation(
          recipe(action),
          input,
          auth("/does/not/exist", "whatsapp:pn:15551234567"),
          {
            beforeDispatch: () => {
              beforeDispatch += 1;
              return Promise.resolve();
            },
            dependencies: {
              binaryPath: "/fixture/wacli",
              run: runner(calls, () => {
                throw new Error("must not run");
              }),
            },
          },
        ),
        "capture-required",
      );
    }
    expect(calls).toEqual([]);
    expect(beforeDispatch).toBe(0);
  });
});

describe("WhatsApp explicit synchronization", () => {
  test("plans bounded quiet one-shot sync and labels unavoidable acknowledgements", async () => {
    const path = privateDirectory();
    const calls: WacliInvocation[] = [];
    try {
      writeFileSync(join(path, "session.db"), "");
      chmodSync(join(path, "session.db"), 0o600);
      const plan = await planWhatsAppSyncOnce(auth(path), {
        dependencies: {
          binaryPath: "/fixture/wacli",
          run: runner(calls, () => "0.13.0\n"),
        },
      });
      expect(plan.emitsProtocolAcknowledgements).toBe(true);
      expect(plan.arguments).toEqual([
        "--store",
        path,
        "--json",
        "--full",
        "--timeout",
        "5m",
        "sync",
        "--once",
        "--presence-mode",
        "quiet",
        "--idle-exit",
        "30s",
        "--max-reconnect",
        "1m",
        "--max-messages",
        "200000",
        "--max-db-size",
        "2GB",
      ]);
      expect(plan.arguments).not.toContain("--download-media");
      expect(plan.environment).not.toHaveProperty("WACLI_READONLY");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("awaits the durable attempt boundary before acknowledgement-capable sync", async () => {
    const path = privateDirectory();
    const calls: WacliInvocation[] = [];
    const events: string[] = [];
    try {
      writeFileSync(join(path, "session.db"), "");
      chmodSync(join(path, "session.db"), 0o600);
      const result = await syncWhatsAppAuthOnce(
        auth(path, "whatsapp:pn:15551234567"),
        {
          dependencies: {
            binaryPath: "/fixture/wacli",
            run: runner(calls, (invocation) => {
              if (invocation.arguments[0] === "version") {
                events.push("read-only-version");
                return "0.13.0\n";
              }
              if (invocation.arguments.includes("status")) {
                events.push("read-only-status");
                return success({
                  authenticated: true,
                  linked_jid: ACCOUNT_JID,
                  phone: "15551234567",
                });
              }
              if (invocation.arguments.includes("sync")) {
                events.push("external-sync");
                return success({ synced: true, messages_stored: 7 });
              }
              throw new Error("unexpected WhatsApp fixture command");
            }),
          },
          attempt: {
            journalId: "00000000-0000-4000-8000-000000000004",
            beforeExternalBegin: async () => {
              await Promise.resolve();
              events.push("journal-durable");
            },
          },
        },
      );

      expect(result).toEqual({ messagesStored: 7 });
      expect(events).toEqual([
        "read-only-version",
        "read-only-status",
        "read-only-version",
        "journal-durable",
        "external-sync",
        "read-only-version",
        "read-only-status",
      ]);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("does not start sync when its durable attempt boundary fails", async () => {
    const path = privateDirectory();
    const calls: WacliInvocation[] = [];
    try {
      writeFileSync(join(path, "session.db"), "");
      chmodSync(join(path, "session.db"), 0o600);
      await expectRejected(
        syncWhatsAppAuthOnce(
          auth(path, "whatsapp:pn:15551234567"),
          {
            dependencies: {
              binaryPath: "/fixture/wacli",
              run: runner(calls, (invocation) => {
                if (invocation.arguments[0] === "version") return "0.13.0\n";
                if (invocation.arguments.includes("status")) {
                  return success({
                    authenticated: true,
                    linked_jid: ACCOUNT_JID,
                    phone: "15551234567",
                  });
                }
                throw new Error("sync must not run before its boundary");
              }),
            },
            attempt: {
              journalId: "00000000-0000-4000-8000-000000000005",
              beforeExternalBegin: () =>
                Promise.reject(new Error("journal boundary unavailable")),
            },
          },
        ),
        "journal boundary unavailable",
      );
      expect(calls.some((call) => call.arguments.includes("sync"))).toBe(false);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
