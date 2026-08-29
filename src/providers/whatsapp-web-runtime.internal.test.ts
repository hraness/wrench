import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

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
  WebSessionCleanupUnverifiedError,
  runWebSessionOperationWithDeadline,
} from "../web-session-execution";
import {
  WhatsAppContactProjectionCleanupUnverifiedError,
  containsWhatsAppContactProjectionCleanupUnverified,
  executeWhatsAppWebOperation,
  pairWhatsAppAuth,
  planWhatsAppPairing,
  planWhatsAppReadCommand,
  planWhatsAppSyncOnce,
  probeWhatsAppWebSubject,
  runWhatsAppMessageExportSessionHelperChild,
  syncWhatsAppAuthOnce,
  validateWhatsAppStoreDirectory,
  type WacliInvocation,
  type WhatsAppContactProjectionHelperResult,
  type WhatsAppWebRuntimeDependencies,
} from "./whatsapp-web-runtime";

const ACCOUNT_JID = "15551234567@s.whatsapp.net";
const CHAT_JID = "15557654321@s.whatsapp.net";
const FIRST_CONTACT_JID = "15550000001@s.whatsapp.net";
const SECOND_CONTACT_JID = "222222222222222@lid";
const GROUP_CONTACT_JID = "120363123456789012@g.us";
const MESSAGE_ID = "3EB0SYNTHETICMESSAGE";
const ZERO_TIME = "0001-01-01T00:00:00Z";
const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;
const TEST_OPERATION_TIMEOUT_MS = 90_000;

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

function createContactStore(): string {
  const path = privateDirectory();
  const databasePath = join(path, "session.db");
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE whatsmeow_device (
        jid TEXT PRIMARY KEY,
        lid TEXT
      );
      CREATE TABLE whatsmeow_contacts (
        our_jid TEXT,
        their_jid TEXT,
        first_name TEXT,
        full_name TEXT,
        push_name TEXT,
        business_name TEXT,
        redacted_phone TEXT,
        PRIMARY KEY (our_jid, their_jid),
        FOREIGN KEY (our_jid) REFERENCES whatsmeow_device(jid)
          ON DELETE CASCADE
          ON UPDATE CASCADE
      );
    `);
    database.query(
      "INSERT INTO whatsmeow_device (jid, lid) VALUES (?1, ?2)",
    ).run("15551234567:3@s.whatsapp.net", "999999999999999@lid");
    const insertContact = database.query(`
      INSERT INTO whatsmeow_contacts (
        our_jid, their_jid, first_name, full_name,
        push_name, business_name, redacted_phone
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `);
    insertContact.run(
      "15551234567:3@s.whatsapp.net",
      FIRST_CONTACT_JID,
      "Ada",
      "Ada Full",
      "Ada Push",
      null,
      "+1 ••• ••• 0001",
    );
    insertContact.run(
      "15551234567:3@s.whatsapp.net",
      SECOND_CONTACT_JID,
      "Lin",
      null,
      "Lin Push",
      "Lin Business",
      null,
    );
    insertContact.run(
      "15551234567:3@s.whatsapp.net",
      GROUP_CONTACT_JID,
      null,
      "Excluded Group",
      null,
      null,
      null,
    );
  } finally {
    database.close();
  }
  chmodSync(databasePath, 0o600);
  return path;
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
    contractVersion: action === "contacts.list" ? 2 : 1,
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

function emptyContactHelperResult(): WhatsAppContactProjectionHelperResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify({
      schemaVersion: 1,
      status: "succeeded",
      contacts: [],
      nextCursor: null,
      localContactTablePageComplete: true,
    })}\n`,
    stderr: "",
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
  const deadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
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
          run: runner(calls, () => "0.15.0\n"),
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
              return "0.15.0\n";
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
            run: runner([], () => "0.15.0\n"),
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
              ? "0.15.0\n"
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
      expect(statusInvocation.timeoutMs).toBeGreaterThan(0);
      expect(statusInvocation.timeoutMs).toBeLessThanOrEqual(statusTimeoutMs);
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
                return "0.15.0\n";
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
                return "0.15.0\n";
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
      const pendingPidPath = `${pidPath}.pending`;
      const caller = new AbortController();
      const operationDeadline = new OperationDeadline(
        TEST_OPERATION_TIMEOUT_MS,
        {
          signal: caller.signal,
        },
      );
      let pid: number | null = null;
      try {
        writeFileSync(join(path, "session.db"), "");
        writeFileSync(join(path, "wacli.db"), "");
        writeFileSync(
          fixture,
          [
            "#!/bin/sh",
            "if [ \"$1\" = \"version\" ]; then",
            "  printf '0.15.0\\n'",
            "  exit 0",
            "fi",
            "/bin/sleep 120 &",
            "descendant=$!",
            "cleanup() {",
            '  kill "$descendant" 2>/dev/null || true',
            '  wait "$descendant" 2>/dev/null || true',
            "  exit 143",
            "}",
            "trap cleanup TERM INT HUP QUIT",
            `printf '%s %s\\n' "$$" "$descendant" > ${JSON.stringify(pendingPidPath)}`,
            `/bin/mv ${JSON.stringify(pendingPidPath)} ${JSON.stringify(pidPath)}`,
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
            timeoutMs: TEST_OPERATION_TIMEOUT_MS,
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

  test("projects account-bound Whatsmeow contacts with unavailable message statistics", async () => {
    const path = createContactStore();
    try {
      const firstPage = await executeWhatsAppWebOperation(
        recipe("contacts.list"),
        { limit: 1 },
        auth(path, "whatsapp:pn:15551234567"),
      );
      expect(firstPage.status).toBe("succeeded");
      expect(firstPage.dispatchStarted).toBe(false);
      expect(firstPage.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      expect(firstPage.output).toEqual({
        provider: "whatsapp",
        operation: "contacts.list",
        accountSubject: "whatsapp:pn:15551234567",
        projection: "quiescent-account-bound-session-store",
        contacts: [{
          providerId: FIRST_CONTACT_JID,
          jidKind: "user",
          phone: "15550000001",
          redactedPhone: "+1 ••• ••• 0001",
          firstName: "Ada",
          fullName: "Ada Full",
          pushName: "Ada Push",
          businessName: null,
          displayName: "Ada Full",
          displayNameBasis: "full-name",
          alias: null,
          tags: [],
          updatedAt: null,
          localProjectionStatsComplete: false,
          sentCount: null,
          sentCountComplete: false,
          sentCountLowerBound: false,
          sentCountTruncated: false,
          receivedCount: null,
          receivedCountComplete: false,
          receivedCountLowerBound: false,
          receivedCountTruncated: false,
          lastSentAt: null,
          lastSentAtComplete: false,
          lastSentAtBasis: "unavailable",
          sentStatsIncompleteReasons: [
            "whatsapp-message-store-account-owner-unavailable",
          ],
          lastReceivedAt: null,
          lastReceivedAtComplete: false,
          lastReceivedAtBasis: "unavailable",
          receivedStatsIncompleteReasons: [
            "whatsapp-message-store-account-owner-unavailable",
          ],
        }],
        nextCursor: FIRST_CONTACT_JID,
        localContactTablePageComplete: false,
        remoteContactSetComplete: false,
        contactSetIncompleteReasons: [
          "linked-device-contact-sync-coverage-unknown",
        ],
        statsScope: "unavailable",
        statsCompleteness: "unavailable",
      });

      const secondPage = await executeWhatsAppWebOperation(
        recipe("contacts.list"),
        { limit: 1, cursor: FIRST_CONTACT_JID },
        auth(path, "whatsapp:lid:999999999999999"),
      );
      expect(secondPage.output).toEqual({
        provider: "whatsapp",
        operation: "contacts.list",
        accountSubject: "whatsapp:lid:999999999999999",
        projection: "quiescent-account-bound-session-store",
        contacts: [{
          providerId: SECOND_CONTACT_JID,
          jidKind: "lid",
          phone: null,
          redactedPhone: null,
          firstName: "Lin",
          fullName: null,
          pushName: "Lin Push",
          businessName: "Lin Business",
          displayName: "Lin Push",
          displayNameBasis: "push-name",
          alias: null,
          tags: [],
          updatedAt: null,
          localProjectionStatsComplete: false,
          sentCount: null,
          sentCountComplete: false,
          sentCountLowerBound: false,
          sentCountTruncated: false,
          receivedCount: null,
          receivedCountComplete: false,
          receivedCountLowerBound: false,
          receivedCountTruncated: false,
          lastSentAt: null,
          lastSentAtComplete: false,
          lastSentAtBasis: "unavailable",
          sentStatsIncompleteReasons: [
            "whatsapp-message-store-account-owner-unavailable",
          ],
          lastReceivedAt: null,
          lastReceivedAtComplete: false,
          lastReceivedAtBasis: "unavailable",
          receivedStatsIncompleteReasons: [
            "whatsapp-message-store-account-owner-unavailable",
          ],
        }],
        nextCursor: null,
        localContactTablePageComplete: true,
        remoteContactSetComplete: false,
        contactSetIncompleteReasons: [
          "linked-device-contact-sync-coverage-unknown",
        ],
        statsScope: "unavailable",
        statsCompleteness: "unavailable",
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("projects interaction pages with an exact durable message-store generation", async () => {
    const path = createContactStore();
    try {
      writeFileSync(join(path, "wacli.db"), "fixed-test-message-store");
      chmodSync(join(path, "wacli.db"), 0o600);
      let helperStarts = 0;
      const projected = await executeWhatsAppWebOperation(
        recipe("contacts.list"),
        { collection: "interactions", cursor: "41", cursor_anchor: "c".repeat(64), limit: 1 },
        auth(path, "whatsapp:pn:15551234567"),
        {
          dependencies: {
            runInteractionProjectionHelper: (invocation) => {
              helperStarts += 1;
              const request = JSON.parse(invocation.stdin) as {
                readonly messageStoreIdentity: { readonly dev: string; readonly ino: string };
              };
              return Promise.resolve({
                exitCode: 0,
                stderr: "",
                stdout: `${JSON.stringify({
                  schemaVersion: 1,
                  status: "succeeded",
                  projectionGeneration: {
                    messageStoreIdentity: request.messageStoreIdentity,
                    schemaFingerprint:
                      "sha256:994b5024bc2479a269866060ea14a06230532b5aba8365d31b1f94113df3bc57",
                  },
                  accountJidAliases: {
                    pnJid: "15551234567@s.whatsapp.net",
                    lidJid: null,
                  },
                  interactions: [{
                    rowid: "42",
                    chatJid: CHAT_JID,
                    messageId: MESSAGE_ID,
                    senderJid: "15557654321:2@s.whatsapp.net",
                    timestamp: "2026-08-18T12:00:00.000Z",
                    fromMe: false,
                    chatKind: "dm",
                  }],
                  nextCursor: null,
                  localInsertPageComplete: true,
                  checkpoint: {
                    cursor: "42",
                    anchor: "fe7e30e794b222aa753855e9aed905e6fbc53b6b2bd5f09b75caeb2747950d12",
                  },
                })}\n`,
              });
            },
          },
        },
      );
      const messageStore = lstatSync(join(path, "wacli.db"), { bigint: true });
      expect(helperStarts).toBe(1);
      expect(projected.output).toEqual({
        provider: "whatsapp",
        operation: "contacts.list",
        accountSubject: "whatsapp:pn:15551234567",
        contactCollection: "interactions",
        projection: "quiescent-account-bound-local-message-inserts",
        projectionGeneration: {
          messageStoreIdentity: {
            dev: messageStore.dev.toString(),
            ino: messageStore.ino.toString(),
          },
          schemaFingerprint:
            "sha256:994b5024bc2479a269866060ea14a06230532b5aba8365d31b1f94113df3bc57",
        },
        interactions: [{
          rowid: "42",
          chatJid: CHAT_JID,
          messageId: MESSAGE_ID,
          senderJid: "15557654321:2@s.whatsapp.net",
          timestamp: "2026-08-18T12:00:00.000Z",
          fromMe: false,
          chatKind: "dm",
        }],
        nextCursor: null,
        localInsertPageComplete: true,
        checkpoint: {
          cursor: "42",
          anchor: "fe7e30e794b222aa753855e9aed905e6fbc53b6b2bd5f09b75caeb2747950d12",
        },
        remoteHistoryComplete: false,
        incompleteReasons: [
          "linked-device-history-coverage-unknown",
          "rowid-cursor-discovers-inserts-only",
        ],
      });

      for (const input of [
        { collection: "interactions", cursor: "041", limit: 1 },
        { collection: "interactions", cursor: "41", limit: 1 },
        { collection: "interactions", cursor: "0", limit: 1_001 },
        { collection: "messages", cursor: "0", limit: 1 },
      ]) {
        await expectRejected(
          executeWhatsAppWebOperation(
            recipe("contacts.list"), input,
            auth(path, "whatsapp:pn:15551234567"),
            { dependencies: { runInteractionProjectionHelper: () => {
              helperStarts += 1;
              return Promise.resolve(emptyContactHelperResult());
            } } },
          ),
          "input.",
        );
      }
      expect(helperStarts).toBe(1);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("binds contact projection to exactly one session database owner", async () => {
    const path = createContactStore();
    try {
      let message = "";
      try {
        await executeWhatsAppWebOperation(
          recipe("contacts.list"),
          { limit: 1 },
          auth(path, "whatsapp:pn:19999999999"),
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("owner-mismatch");
      expect(message).not.toContain(path);
      expect(message).not.toContain(FIRST_CONTACT_JID);
      expect(message).not.toContain("Ada Full");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("parent revalidation discards helper output after session path replacement", async () => {
    const path = createContactStore();
    const replacement = createContactStore();
    try {
      let output: unknown;
      let rejection: unknown;
      try {
        output = await executeWhatsAppWebOperation(
          recipe("contacts.list"),
          { limit: 1 },
          auth(path, "whatsapp:pn:15551234567"),
          {
            dependencies: {
              runContactProjectionHelper: () => {
                renameSync(
                  join(path, "session.db"),
                  join(path, "session.db.original"),
                );
                renameSync(
                  join(replacement, "session.db"),
                  join(path, "session.db"),
                );
                return Promise.resolve(emptyContactHelperResult());
              },
            },
          },
        );
      } catch (error) {
        rejection = error;
      }
      expect(output).toBeUndefined();
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain(
        "parent binding changed",
      );
      expect((rejection as Error).message).not.toContain(path);
    } finally {
      rmSync(path, { recursive: true, force: true });
      rmSync(replacement, { recursive: true, force: true });
    }
  });

  test("rejects malformed contact inputs before helper execution", async () => {
    let helperStarts = 0;
    const path = createContactStore();
    try {
      for (const input of [
        { limit: 0 },
        { cursor: GROUP_CONTACT_JID },
        { cursor_anchor: "c".repeat(64), limit: 1 },
        { limit: 1, unreviewed: true },
      ]) {
        await expectRejected(
          executeWhatsAppWebOperation(
            recipe("contacts.list"),
            input,
            auth(path, "whatsapp:pn:15551234567"),
            {
              dependencies: {
                runContactProjectionHelper: () => {
                  helperStarts += 1;
                  return Promise.resolve(emptyContactHelperResult());
                },
              },
            },
          ),
          "input",
        );
      }
      await expectRejected(
        executeWhatsAppWebOperation(
          recipe("contacts.list"),
          { limit: 1 },
          auth(path, "whatsapp:pn:not-digits"),
          {
            dependencies: {
              runContactProjectionHelper: () => {
                helperStarts += 1;
                return Promise.resolve(emptyContactHelperResult());
              },
            },
          },
        ),
        "auth subject",
      );
      const privateMarker = `${path}-private-input-key`;
      let privateInputRejection: unknown;
      try {
        await executeWhatsAppWebOperation(
          recipe("contacts.list"),
          { limit: 1, [privateMarker]: true },
          auth(path, "whatsapp:pn:15551234567"),
          {
            dependencies: {
              runContactProjectionHelper: () => {
                helperStarts += 1;
                return Promise.resolve(emptyContactHelperResult());
              },
            },
          },
        );
      } catch (error) {
        privateInputRejection = error;
      }
      expect(privateInputRejection).toBeInstanceOf(Error);
      expect((privateInputRejection as Error).message).toContain(
        "unsupported fields",
      );
      expect((privateInputRejection as Error).message).not.toContain(
        privateMarker,
      );
      expect((privateInputRejection as Error).message).not.toContain(path);
      expect(helperStarts).toBe(0);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("does not spawn when cleanup-barrier registration is rejected", async () => {
    const path = createContactStore();
    let helperStarts = 0;
    try {
      await expectRejected(
        executeWhatsAppWebOperation(
          recipe("contacts.list"),
          { limit: 1 },
          auth(path, "whatsapp:pn:15551234567"),
          {
            registerCleanupBarrier: () => {
              throw new Error("cleanup registrar unavailable");
            },
            dependencies: {
              runContactProjectionHelper: () => {
                helperStarts += 1;
                return Promise.resolve(emptyContactHelperResult());
              },
            },
          },
        ),
        "cleanup registrar unavailable",
      );
      expect(helperStarts).toBe(0);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("ordinary helper failure fulfills its cleanup barrier", async () => {
    const path = createContactStore();
    let barrier: Promise<void> | undefined;
    try {
      const execution = executeWhatsAppWebOperation(
        recipe("contacts.list"),
        { limit: 1 },
        auth(path, "whatsapp:pn:15551234567"),
        {
          registerCleanupBarrier: (value) => {
            barrier = value;
          },
          dependencies: {
            runContactProjectionHelper: () =>
              Promise.reject(new Error("ordinary schema failure")),
          },
        },
      );
      await expectRejected(execution, "ordinary schema failure");
      if (barrier === undefined) throw new Error("cleanup barrier was not registered");
      await barrier;
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("operation deadline waits for helper exit and stream settlement", async () => {
    const path = createContactStore();
    const clock = new FakeMonotonicClock();
    let resolveHelper:
      | ((value: WhatsAppContactProjectionHelperResult) => void)
      | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    try {
      const execution = runWebSessionOperationWithDeadline(
        recipe("contacts.list"),
        { deadlineClock: clock },
        (options) => executeWhatsAppWebOperation(
          recipe("contacts.list"),
          { limit: 1 },
          auth(path, "whatsapp:pn:15551234567"),
          {
            ...options,
            dependencies: {
              runContactProjectionHelper: () => {
                markStarted?.();
                return new Promise((resolve) => {
                  resolveHelper = resolve;
                });
              },
            },
          },
        ),
      );
      await started;
      let settled = false;
      void execution.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      clock.advance(recipe("contacts.list").timeoutMs);
      await Promise.resolve();
      expect(settled).toBeFalse();

      resolveHelper?.(emptyContactHelperResult());
      await expectRejected(execution, "timed out");
      expect(settled).toBeTrue();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("cleanup-unverified helper state maps to the kernel cleanup error", async () => {
    const path = createContactStore();
    try {
      let rejection: unknown;
      try {
        await runWebSessionOperationWithDeadline(
          recipe("contacts.list"),
          {},
          (options) => executeWhatsAppWebOperation(
            recipe("contacts.list"),
            { limit: 1 },
            auth(path, "whatsapp:pn:15551234567"),
            {
              ...options,
              dependencies: {
                runContactProjectionHelper: () => Promise.reject(
                  new WhatsAppContactProjectionCleanupUnverifiedError(),
                ),
              },
            },
          ),
        );
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(WebSessionCleanupUnverifiedError);
      expect((rejection as Error).message).toContain(
        "cleanup could not be verified",
      );
      expect((rejection as Error).message).not.toContain(
        "WhatsApp contact projection helper",
      );
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("cleanup uncertainty outranks simultaneous parent-store drift", async () => {
    const path = createContactStore();
    const replacement = createContactStore();
    try {
      let rejection: unknown;
      try {
        await runWebSessionOperationWithDeadline(
          recipe("contacts.list"),
          {},
          (options) => executeWhatsAppWebOperation(
            recipe("contacts.list"),
            { limit: 1 },
            auth(path, "whatsapp:pn:15551234567"),
            {
              ...options,
              dependencies: {
                runContactProjectionHelper: () => {
                  renameSync(
                    join(path, "session.db"),
                    join(path, "session.db.original"),
                  );
                  renameSync(
                    join(replacement, "session.db"),
                    join(path, "session.db"),
                  );
                  return Promise.reject(
                    new WhatsAppContactProjectionCleanupUnverifiedError(),
                  );
                },
              },
            },
          ),
        );
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(WebSessionCleanupUnverifiedError);
      expect((rejection as Error).message).toContain(
        "cleanup could not be verified",
      );
      expect((rejection as Error).message).not.toContain("parent binding");
    } finally {
      rmSync(path, { recursive: true, force: true });
      rmSync(replacement, { recursive: true, force: true });
    }
  });

  test("pre-abort prevents session spawn and timeout hard-kills a SIGTERM-ignoring helper", async () => {
    const path = privateDirectory();
    try {
      const preAborted = new AbortController();
      preAborted.abort();
      await expect(runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", "process.exit(99)"],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 100,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
        signal: preAborted.signal,
      })).rejects.toThrow("cancelled");

      const started = performance.now();
      await expect(runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", [
          "process.on('SIGTERM', () => undefined);",
          "setInterval(() => undefined, 1000);",
        ].join("")],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 20,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
      })).rejects.toThrow("timed out");
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("spools canonical stdout privately and applies the same inclusive newline bound", async () => {
    const path = privateDirectory();
    const prefix = "wrench-whatsapp-stdout-";
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)));
    const output = "{\"a\":1}\n";
    let spoolDirectory: string | undefined;
    const captured: unknown[] = [];
    try {
      const result = await runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 1_000,
        maxOutputBytes: Buffer.byteLength(output),
        maxStderrBytes: 1024,
        onSpawned: () => {
          const created = readdirSync(tmpdir())
            .filter((name) => name.startsWith(prefix) && !before.has(name));
          expect(created).toHaveLength(1);
          spoolDirectory = join(tmpdir(), created[0]!);
          expect(lstatSync(spoolDirectory).mode & 0o777).toBe(0o700);
          // The 0600 stdout inode is already anonymous and reachable only by
          // the parent-held descriptor before any helper code executes.
          expect(readdirSync(spoolDirectory)).toEqual([]);
        },
        onCanonicalFrame: (frame) => captured.push(frame.value),
      });
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect("frames" in result).toBeFalse();
      expect(result.spool).toMatchObject({ frameCount: 1, totalBytes: output.length });
      expect(captured).toEqual([{ a: 1 }]);
      const replayed: unknown[] = [];
      for await (const value of result.spool.replay((frame) => frame.value)) replayed.push(value);
      expect(replayed).toEqual([{ a: 1 }]);
      await result.spool.close();
      expect(spoolDirectory === undefined ? true : existsSync(spoolDirectory)).toBeFalse();

      await expect(runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 1_000,
        maxOutputBytes: Buffer.byteLength(output) - 1,
        maxStderrBytes: 1024,
      })).rejects.toThrow("frame exceeded its bound");
    } finally {
      rmSync(path, { recursive: true, force: true });
      if (spoolDirectory !== undefined) rmSync(spoolDirectory, { recursive: true, force: true });
    }
  });

  test("rejects noncanonical, unterminated, and over-count stdout without retaining frames", async () => {
    const path = privateDirectory();
    try {
      for (const output of ["{\"b\":1,\"a\":2}\n", "{\"a\":1}"]) {
        await expect(runWhatsAppMessageExportSessionHelperChild({
          command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`],
          cwd: path,
          environment: { PATH: "/usr/bin:/bin" },
          stdin: "{}\n",
          timeoutMs: 1_000,
          maxOutputBytes: 1024,
          maxStderrBytes: 1024,
        })).rejects.toThrow();
      }
      const exactMaximum = "{}\n".repeat(1_001);
      const exact = await runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(exactMaximum)})`],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
      });
      let frameCount = 0;
      for await (const _frame of exact.spool.replay(() => undefined)) frameCount += 1;
      expect(frameCount).toBe(1_001);
      await exact.spool.close();

      const tooMany = "{}\n".repeat(1_002);
      await expect(runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(tooMany)})`],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 1_000,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
      })).rejects.toThrow("frame exceeded its bound");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("bounds callback failure and recursively reaps an unexpected process group", async () => {
    const path = privateDirectory();
    try {
      const spawnCallbackStarted = performance.now();
      await expect(runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", "setInterval(() => undefined, 1000)"],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
        onSpawned: () => { throw new Error("synthetic spawn rejection"); },
      })).rejects.toThrow("synthetic spawn rejection");
      expect(performance.now() - spawnCallbackStarted).toBeLessThan(3_000);

      const callbackStarted = performance.now();
      await expect(runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", [
          "process.on('SIGTERM', () => undefined);",
          "process.stdout.write('{}\\n');",
          "setInterval(() => undefined, 1000);",
        ].join("")],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
        onCanonicalFrame: () => { throw new Error("synthetic frame rejection"); },
      })).rejects.toThrow("synthetic frame rejection");
      expect(performance.now() - callbackStarted).toBeLessThan(3_000);

      let descendantPid: number | undefined;
      const descendantReady = join(path, "descendant.ready");
      const descendantStarted = performance.now();
      await expect(runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "-e", [
          "const { existsSync } = require('node:fs');",
          "void (async () => {",
          `const child = Bun.spawn([${JSON.stringify(process.execPath)}, '-e',`,
          `  ${JSON.stringify(`const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => undefined); writeFileSync(${JSON.stringify(descendantReady)}, "ready\\n"); setInterval(() => undefined, 1000);`)}],`,
          "  { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });",
          `while (!existsSync(${JSON.stringify(descendantReady)})) await Bun.sleep(5);`,
          "process.stdout.write(JSON.stringify({ pid: child.pid }) + '\\n', () => process.exit(0));",
          "})();",
        ].join("\n")],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin" },
        stdin: "{}\n",
        timeoutMs: 10_000,
        maxOutputBytes: 1024,
        maxStderrBytes: 1024,
        onCanonicalFrame: (frame) => {
          descendantPid = (frame.value as { pid: number }).pid;
        },
      })).rejects.toThrow("unexpected descendant");
      expect(performance.now() - descendantStarted).toBeLessThan(3_000);
      expect(descendantPid).toBeNumber();
      expect(() => process.kill(descendantPid!, 0)).toThrow();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("finds cleanup uncertainty through AggregateError causes without looping on cycles", () => {
    const cleanup = new WhatsAppContactProjectionCleanupUnverifiedError();
    expect(containsWhatsAppContactProjectionCleanupUnverified(
      new AggregateError([], "wrapped", { cause: new Error("middle", { cause: cleanup }) }),
    )).toBeTrue();

    const errors: unknown[] = [];
    const cycle = new AggregateError(errors, "cycle");
    errors.push(cycle);
    Object.defineProperty(cycle, "cause", { value: cycle, enumerable: false });
    expect(containsWhatsAppContactProjectionCleanupUnverified(cycle)).toBeFalse();
  });

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
          if (invocation.arguments[0] === "version") return "0.15.0\n";
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
          run: runner(calls, () => "0.15.0\n"),
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
                return "0.15.0\n";
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
                if (invocation.arguments[0] === "version") return "0.15.0\n";
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
