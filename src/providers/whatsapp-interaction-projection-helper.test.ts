import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { projectWhatsAppMessageExportSessionFromBoundCwd } from "./whatsapp-interaction-projection-helper";

import {
  runWhatsAppContactProjectionHelperChild,
  runWhatsAppMessageExportSessionHelperChild,
  type WhatsAppContactProjectionHelperResult,
  type WhatsAppMessageExportSessionHelperResult,
} from "./whatsapp-web-runtime";
import {
  WHATSAPP_INTERACTION_PROJECTION_MAX_STDIN_BYTES,
  WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
  parseWhatsAppInteractionProjectionResponse,
  type WhatsAppInteractionProjectionRequest,
} from "./whatsapp-interaction-projection-protocol";
import {
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
  parseWhatsAppMessageExportProjectionResponse,
  type WhatsAppMessageExportProjectionRequest,
} from "./whatsapp-message-export-projection-protocol";

const OWNER_JID = "15551234567:3@s.whatsapp.net";
const helper = join(import.meta.dir, "whatsapp-interaction-projection-helper.ts");
const config = join(import.meta.dir, "../state-helper.bunfig.toml");

async function consumeSessionFrames(
  result: WhatsAppMessageExportSessionHelperResult,
): Promise<readonly unknown[]> {
  const frames: unknown[] = [];
  try {
    for await (const value of result.spool.replay((frame) => frame.value)) frames.push(value);
    return Object.freeze(frames);
  } finally {
    await result.spool.close();
  }
}

function privateDirectory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wrench-wa-interactions-")));
  chmodSync(path, 0o700);
  return path;
}

function createStore(options: {
  readonly extraMessageColumn?: boolean;
  readonly journalMode?: "DELETE" | "WAL";
} = {}): string {
  const path = privateDirectory();
  const session = new Database(join(path, "session.db"), { create: true, strict: true });
  try {
    session.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON");
    session.exec(`
      CREATE TABLE whatsmeow_device (jid TEXT PRIMARY KEY, lid TEXT);
      CREATE TABLE whatsmeow_contacts (
        our_jid TEXT, their_jid TEXT, first_name TEXT, full_name TEXT,
        push_name TEXT, business_name TEXT, redacted_phone TEXT,
        PRIMARY KEY (our_jid, their_jid),
        FOREIGN KEY (our_jid) REFERENCES whatsmeow_device(jid)
          ON DELETE CASCADE ON UPDATE CASCADE
      );
    `);
    session.query("INSERT INTO whatsmeow_device (jid, lid) VALUES (?1, ?2)")
      .run(OWNER_JID, "999999999999999@lid");
  } finally {
    session.close();
  }
  const messages = new Database(join(path, "wacli.db"), { create: true, strict: true });
  try {
    messages.exec(`PRAGMA journal_mode = ${options.journalMode ?? "DELETE"}; PRAGMA foreign_keys = ON`);
    messages.exec(`
      CREATE TABLE chats (
        jid TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT,
        last_message_ts INTEGER, archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0, muted_until INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0, unread_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, chat_jid TEXT NOT NULL,
        chat_name TEXT, msg_id TEXT NOT NULL, sender_jid TEXT, sender_name TEXT,
        ts INTEGER NOT NULL, from_me INTEGER NOT NULL, text TEXT, display_text TEXT,
        quoted_msg_id TEXT, quoted_sender_jid TEXT,
        is_forwarded INTEGER NOT NULL DEFAULT 0,
        forwarding_score INTEGER NOT NULL DEFAULT 0, reaction_to_id TEXT,
        reaction_emoji TEXT, media_type TEXT, media_caption TEXT, filename TEXT,
        mime_type TEXT, direct_path TEXT, media_key BLOB, file_sha256 BLOB,
        file_enc_sha256 BLOB, file_length INTEGER, local_path TEXT,
        downloaded_at INTEGER, media_unavailable_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0, deleted_for_me INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER, deletion_reason TEXT, payload_purged_at INTEGER,
        edited INTEGER NOT NULL DEFAULT 0, edited_ts INTEGER NOT NULL DEFAULT 0,
        buttons TEXT${options.extraMessageColumn === true ? ", private_unreviewed TEXT" : ""},
        UNIQUE(chat_jid, msg_id),
        FOREIGN KEY(chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
      );
      CREATE INDEX idx_messages_chat_ts ON messages(chat_jid, ts);
      CREATE INDEX idx_messages_ts ON messages(ts);
    `);
    const insertChat = messages.query("INSERT INTO chats(jid, kind) VALUES (?1, ?2)");
    insertChat.run("15557654321@s.whatsapp.net", "dm");
    insertChat.run("120363123456789012@g.us", "group");
    const insertMessage = messages.query(`
      INSERT INTO messages(chat_jid, msg_id, sender_jid, ts, from_me, text)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `);
    insertMessage.run(
      "15557654321@s.whatsapp.net", "MSG-1", "15557654321:2@s.whatsapp.net",
      1_776_513_600, 0, "private body never projected",
    );
    insertMessage.run(
      "120363123456789012@g.us", "MSG-2", OWNER_JID,
      1_776_513_601, 1, "other private body",
    );
    insertMessage.run(
      "15557654321@s.whatsapp.net", "MSG-3", null,
      1_776_513_602, 0, "third private body",
    );
  } finally {
    if (options.journalMode === "WAL") {
      try {
        messages.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // close still runs; the fixture cleanup below remains authoritative.
      }
    }
    messages.close();
  }
  if (options.journalMode === "WAL") {
    rmSync(join(path, "wacli.db-wal"), { force: true });
    rmSync(join(path, "wacli.db-shm"), { force: true });
  }
  chmodSync(join(path, "session.db"), 0o600);
  chmodSync(join(path, "wacli.db"), 0o600);
  return path;
}

function request(
  path: string,
  overrides: Partial<WhatsAppInteractionProjectionRequest> = {},
): WhatsAppInteractionProjectionRequest {
  const store = lstatSync(path, { bigint: true });
  const session = lstatSync(join(path, "session.db"), { bigint: true });
  const messages = lstatSync(join(path, "wacli.db"), { bigint: true });
  return {
    schemaVersion: 1,
    operation: "contacts.interactions.list",
    accountSubject: "whatsapp:pn:15551234567",
    cursor: "0",
    cursorAnchor: null,
    limit: 2,
    storeIdentity: { dev: store.dev.toString(), ino: store.ino.toString() },
    sessionIdentity: { dev: session.dev.toString(), ino: session.ino.toString() },
    messageStoreIdentity: { dev: messages.dev.toString(), ino: messages.ino.toString() },
    ...overrides,
  };
}

async function invoke(path: string, value: unknown): Promise<WhatsAppContactProjectionHelperResult> {
  return runWhatsAppContactProjectionHelperChild({
    command: [process.execPath, "--no-env-file", "--no-install", "--no-macros",
      "--no-addons", `--config=${config}`, helper],
    cwd: path,
    environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
    stdin: typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    timeoutMs: 10_000,
    maxOutputBytes: 1024 * 1024,
    maxStderrBytes: 16 * 1024,
  });
}

async function response(path: string, value: WhatsAppInteractionProjectionRequest) {
  const result = await invoke(path, value);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return parseWhatsAppInteractionProjectionResponse(
    JSON.parse(result.stdout) as unknown,
    value,
  );
}

function messageRequest(
  path: string,
  overrides: Partial<WhatsAppMessageExportProjectionRequest> = {},
): WhatsAppMessageExportProjectionRequest {
  const store = lstatSync(path, { bigint: true });
  const session = lstatSync(join(path, "session.db"), { bigint: true });
  const messages = lstatSync(join(path, "wacli.db"), { bigint: true });
  return {
    schemaVersion: 1,
    operation: "message-like-me.export",
    accountSubject: "whatsapp:pn:15551234567",
    cursor: "0",
    cursorAnchor: null,
    limit: 10,
    expectedGeneration: null,
    storeIdentity: { dev: store.dev.toString(), ino: store.ino.toString() },
    sessionIdentity: { dev: session.dev.toString(), ino: session.ino.toString() },
    messageStoreIdentity: { dev: messages.dev.toString(), ino: messages.ino.toString() },
    ...overrides,
  };
}

async function messageResponse(path: string, value: WhatsAppMessageExportProjectionRequest) {
  const result = await invoke(path, value);
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return parseWhatsAppMessageExportProjectionResponse(
    JSON.parse(result.stdout) as unknown,
    value,
  );
}

describe("WhatsApp content-free interaction projection helper", () => {
  test("pages all locally stored inserts by rowid without projecting content", async () => {
    const path = createStore();
    try {
      const firstRequest = request(path);
      const first = await response(path, firstRequest);
      expect(first).toEqual({
        schemaVersion: 1,
        status: "succeeded",
        projectionGeneration: {
          messageStoreIdentity: firstRequest.messageStoreIdentity,
          schemaFingerprint: WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
        },
        accountJidAliases: {
          pnJid: "15551234567@s.whatsapp.net",
          lidJid: "999999999999999@lid",
        },
        interactions: [{
          rowid: "1", chatJid: "15557654321@s.whatsapp.net", messageId: "MSG-1",
          senderJid: "15557654321:2@s.whatsapp.net",
          timestamp: "2026-04-18T12:00:00.000Z", fromMe: false, chatKind: "dm",
        }, {
          rowid: "2", chatJid: "120363123456789012@g.us", messageId: "MSG-2",
          senderJid: OWNER_JID,
          timestamp: "2026-04-18T12:00:01.000Z", fromMe: true, chatKind: "group",
        }],
        nextCursor: "2",
        localInsertPageComplete: false,
        checkpoint: {
          cursor: "2",
          anchor: "9b3696d9798827b7928cdf98b5e83fba917a606aabefa7140b2d4dbad09152ad",
        },
      });
      expect(JSON.stringify(first)).not.toContain("private body");
      expect(await response(path, request(path, {
        cursor: "2",
        cursorAnchor: "9b3696d9798827b7928cdf98b5e83fba917a606aabefa7140b2d4dbad09152ad",
      }))).toMatchObject({
        interactions: [{ rowid: "3", messageId: "MSG-3", senderJid: null }],
        nextCursor: null,
        localInsertPageComplete: true,
        checkpoint: {
          cursor: "3",
          anchor: "a86ecbd8b98eb6466c2b584a5b3d3ca0458230bbd6ecc86981d57ca4aaa81830",
        },
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("rejects a stale or restored cursor row before advancing", async () => {
    const path = createStore();
    try {
      expect(await response(path, request(path, {
        cursor: "2",
        cursorAnchor: "f".repeat(64),
      }))).toMatchObject({ status: "failed", errorCode: "projection-invalid" });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("reads a quiescent WAL-mode message store without creating sidecars", async () => {
    const path = createStore({ journalMode: "WAL" });
    try {
      expect(await response(path, request(path, { limit: 1 }))).toMatchObject({
        status: "succeeded",
        interactions: [{ rowid: "1", messageId: "MSG-1" }],
      });
      expect(() => lstatSync(join(path, "wacli.db-wal"))).toThrow();
      expect(() => lstatSync(join(path, "wacli.db-shm"))).toThrow();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("projects the fixed system sentinel as an unsupported interaction", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query("INSERT INTO chats(jid, kind) VALUES (?1, ?2)")
          .run("0@s.whatsapp.net", "dm");
        database.query(`
          INSERT INTO messages(chat_jid,msg_id,sender_jid,ts,from_me)
          VALUES (?1,?2,NULL,?3,?4)
        `).run("0@s.whatsapp.net", "SYSTEM-1", 1_776_513_603, 0);
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      expect(await response(path, request(path, {
        cursor: "3",
        cursorAnchor: "a86ecbd8b98eb6466c2b584a5b3d3ca0458230bbd6ecc86981d57ca4aaa81830",
        limit: 1,
      }))).toMatchObject({
        status: "succeeded",
        interactions: [{
          rowid: "4",
          chatJid: "0@s.whatsapp.net",
          chatKind: "unknown",
        }],
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("preserves rowids above JavaScript's safe-integer range", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query(`
          INSERT INTO messages(rowid,chat_jid,msg_id,sender_jid,ts,from_me)
          VALUES (?1,?2,?3,?4,?5,?6)
        `).run(
          9_007_199_254_740_993n,
          "15557654321@s.whatsapp.net",
          "MSG-LARGE-ROWID",
          "15557654321:2@s.whatsapp.net",
          1_776_513_604,
          0,
        );
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      expect(await response(path, request(path, {
        cursor: "3",
        cursorAnchor: "a86ecbd8b98eb6466c2b584a5b3d3ca0458230bbd6ecc86981d57ca4aaa81830",
        limit: 1,
      }))).toMatchObject({
        status: "succeeded",
        interactions: [{
          rowid: "9007199254740993",
          messageId: "MSG-LARGE-ROWID",
        }],
        checkpoint: { cursor: "9007199254740993" },
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("fails closed on schema drift, owner mismatch, and SQLite sidecars", async () => {
    const schema = createStore({ extraMessageColumn: true });
    const owner = createStore();
    const sidecar = createStore();
    try {
      expect(await response(schema, request(schema))).toMatchObject({
        status: "failed", errorCode: "schema-mismatch",
      });
      expect(await response(owner, request(owner, {
        accountSubject: "whatsapp:pn:19999999999",
      }))).toMatchObject({ status: "failed", errorCode: "owner-mismatch" });
      writeFileSync(join(sidecar, "wacli.db-wal"), "private sidecar contents");
      chmodSync(join(sidecar, "wacli.db-wal"), 0o600);
      expect(await response(sidecar, request(sidecar))).toMatchObject({
        status: "failed", errorCode: "message-store-sidecar-present",
      });
    } finally {
      for (const path of [schema, owner, sidecar]) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  test("bounds input and returns only redacted categorical failures", async () => {
    const path = createStore();
    try {
      const privateMarker = `${path}/private-message-body`;
      const result = await invoke(
        path,
        `${privateMarker}${"x".repeat(WHATSAPP_INTERACTION_PROJECTION_MAX_STDIN_BYTES)}\n`,
      );
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(result.stdout).toContain('"errorCode":"request-invalid"');
      expect(result.stdout).not.toContain(path);
      expect(result.stdout).not.toContain("private-message-body");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe("WhatsApp Message Like Me fixed projection helper", () => {
  test("pages full DM/group rows while excluding non-conversation surfaces and private storage fields", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query(`
          UPDATE messages
          SET display_text = ?1, quoted_msg_id = ?2, quoted_sender_jid = ?3,
              media_type = ?4, media_caption = ?5, filename = ?6,
              mime_type = ?7, file_length = ?8, direct_path = ?9,
              local_path = ?10, media_key = ?11
          WHERE msg_id = 'MSG-1'
        `).run(
          "display body", "QUOTED-1", OWNER_JID, "image", "caption", "photo.jpg",
          "image/jpeg", 42, "/private/provider/url", "/private/local/file", Buffer.from("secret-key"),
        );
        database.query(`
          UPDATE messages SET edited = 1, edited_ts = ts + 5 WHERE msg_id = 'MSG-2'
        `).run();
        database.query(`
          UPDATE messages
          SET revoked = 1, deleted_at = ts + 2, deletion_reason = 'remote-revoke',
              payload_purged_at = ts + 3
          WHERE msg_id = 'MSG-3'
        `).run();
        database.query(`
          INSERT INTO messages(chat_jid,msg_id,sender_jid,ts,from_me,reaction_to_id,reaction_emoji)
          VALUES (?1,?2,?3,?4,0,?5,?6)
        `).run(
          "15557654321@s.whatsapp.net", "REACTION-1", "15557654321:2@s.whatsapp.net",
          1_776_513_603, "MSG-1", "👍",
        );
        database.query("INSERT INTO chats(jid, kind) VALUES (?1, ?2)")
          .run("status@broadcast", "broadcast");
        database.query(`
          INSERT INTO messages(chat_jid,msg_id,ts,from_me,text)
          VALUES ('status@broadcast','STATUS-1',1776513604,0,'excluded status body')
        `).run();
        database.query("INSERT INTO chats(jid, kind) VALUES (?1, ?2)")
          .run("12345@broadcast", "broadcast");
        database.query(`
          INSERT INTO messages(chat_jid,msg_id,ts,from_me,text)
          VALUES ('12345@broadcast','BROADCAST-1',1776513605,0,'excluded broadcast body')
        `).run();
        database.query("INSERT INTO chats(jid, kind) VALUES (?1, ?2)")
          .run("12345@newsletter", "newsletter");
        database.query(`
          INSERT INTO messages(chat_jid,msg_id,ts,from_me,text)
          VALUES ('12345@newsletter','NEWSLETTER-1',1776513606,0,'excluded newsletter body')
        `).run();
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      const requestValue = messageRequest(path);
      const projected = await messageResponse(path, requestValue);
      expect(projected).toMatchObject({
        schemaVersion: 1,
        status: "succeeded",
        nonConversationChatsExcluded: true,
        localInsertPageComplete: true,
        nextCursor: null,
        projectionGeneration: {
          messageStoreIdentity: requestValue.messageStoreIdentity,
          schemaFingerprint: WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
        },
        accountJidAliases: {
          pnJid: "15551234567@s.whatsapp.net",
          lidJid: "999999999999999@lid",
        },
        messages: [{
          rowid: "1",
          chatJid: "15557654321@s.whatsapp.net",
          chatKind: "dm",
          messageId: "MSG-1",
          text: "private body never projected",
          displayText: "display body",
          quotedMessageId: "QUOTED-1",
          mediaType: "image",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          fileLength: 42,
        }, {
          rowid: "2",
          chatKind: "group",
          edited: true,
          editedAt: "2026-04-18T12:00:06.000Z",
        }, {
          rowid: "3",
          revoked: true,
          deletedAt: "2026-04-18T12:00:04.000Z",
          payloadPurgedAt: "2026-04-18T12:00:05.000Z",
        }, {
          rowid: "4",
          reactionToMessageId: "MSG-1",
          reactionEmoji: "👍",
        }],
      });
      const encoded = JSON.stringify(projected);
      expect(encoded).not.toContain("excluded status body");
      expect(encoded).not.toContain("excluded broadcast body");
      expect(encoded).not.toContain("excluded newsletter body");
      expect(encoded).not.toContain("/private/provider/url");
      expect(encoded).not.toContain("/private/local/file");
      expect(encoded).not.toContain("secret-key");
      expect(encoded).not.toContain("deletion_reason");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("serves every cursor from one integrity-checked helper session", async () => {
    const path = createStore();
    try {
      const initial = messageRequest(path, { limit: 1 });
      const result = await runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "--no-env-file", "--no-install", "--no-macros",
          "--no-addons", `--config=${config}`, helper],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        stdin: `${JSON.stringify({
          operation: "message-like-me.export-session",
          request: initial,
        })}\n`,
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
        maxStderrBytes: 16 * 1024,
      });
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      const frames = await consumeSessionFrames(result);
      expect(frames).toHaveLength(4);
      const pages = frames.slice(0, -1);
      expect(pages).toHaveLength(3);
      let requestValue = initial;
      const projected = pages.map((page) => {
        const frame = page as Readonly<Record<string, unknown>>;
        const selfJids = frame.selfJids as readonly string[];
        const parsed = parseWhatsAppMessageExportProjectionResponse({
          schemaVersion: 1,
          status: "succeeded",
          projectionGeneration: frame.projectionGeneration,
          accountJidAliases: {
            pnJid: selfJids.find((jid) => jid.endsWith("@s.whatsapp.net")),
            lidJid: selfJids.find((jid) => jid.endsWith("@lid")) ?? null,
          },
          nonConversationChatsExcluded: frame.nonConversationChatsExcluded,
          messages: frame.messages,
          nextCursor: frame.terminal ? null : (frame.checkpoint as { cursor: string }).cursor,
          localInsertPageComplete: frame.terminal,
          checkpoint: frame.checkpoint,
        }, requestValue);
        if (parsed.status !== "succeeded") {
          throw new Error("expected a successful session page");
        }
        requestValue = {
          ...requestValue,
          cursor: parsed.checkpoint.cursor,
          cursorAnchor: parsed.checkpoint.anchor,
          expectedGeneration: parsed.projectionGeneration,
        };
        return parsed;
      });
      expect(projected.map((page) => page.messages[0]?.messageId)).toEqual([
        "MSG-1",
        "MSG-2",
        "MSG-3",
      ]);
      expect(projected.at(-1)).toMatchObject({
        localInsertPageComplete: true,
        nextCursor: null,
      });
      expect(frames.at(-1)).toMatchObject({
        kind: "seal",
        pages: 3,
        messages: 3,
        framesSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("streams 501 rows in two pages with one snapshot integrity proof", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        const insert = database.query(`
          INSERT INTO messages(chat_jid, msg_id, sender_jid, ts, from_me, text)
          VALUES (?1, ?2, ?3, ?4, 0, ?5)
        `);
        database.transaction(() => {
          for (let index = 4; index <= 501; index += 1) {
            insert.run(
              "15557654321@s.whatsapp.net",
              `MSG-${String(index)}`,
              "15557654321:2@s.whatsapp.net",
              1_776_513_600 + index,
              `body-${String(index)}`,
            );
          }
        })();
      } finally {
        database.close();
      }
      const initial = messageRequest(path, { limit: 500 });
      const result = await runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "--no-env-file", "--no-install", "--no-macros",
          "--no-addons", `--config=${config}`, helper],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        stdin: `${JSON.stringify({ operation: "message-like-me.export-session", request: initial })}\n`,
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
        maxStderrBytes: 16 * 1024,
      });
      expect(result.exitCode).toBe(0);
      const frames = await consumeSessionFrames(result);
      expect(frames).toHaveLength(3);
      expect(frames.slice(0, 2).map((frame) =>
        (frame as { messages: readonly unknown[] }).messages.length)).toEqual([500, 1]);
      expect(frames.at(-1)).toMatchObject({
        kind: "seal",
        pages: 2,
        messages: 501,
        integrityChecks: 1,
      });

      const priorCwd = process.cwd();
      let exclusionScans = 0;
      const directFrames: unknown[] = [];
      try {
        process.chdir(path);
        const summary = projectWhatsAppMessageExportSessionFromBoundCwd(
          initial,
          (frame) => directFrames.push(frame),
          {
            hasExcludedNonConversationMessagesForTest: () => {
              exclusionScans += 1;
              return false;
            },
          },
        );
        expect(summary).toMatchObject({ pages: 2, messages: 501, integrityChecks: 1 });
      } finally {
        process.chdir(priorCwd);
      }
      expect(directFrames).toHaveLength(2);
      expect(exclusionScans).toBe(1);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("uses lookahead so an exact 500-row multiple is terminal without an empty page", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        const insert = database.query(`
          INSERT INTO messages(chat_jid, msg_id, sender_jid, ts, from_me, text)
          VALUES (?1, ?2, ?3, ?4, 0, ?5)
        `);
        database.transaction(() => {
          for (let index = 4; index <= 500; index += 1) {
            insert.run(
              "15557654321@s.whatsapp.net",
              `MSG-${String(index)}`,
              "15557654321:2@s.whatsapp.net",
              1_776_513_600 + index,
              `body-${String(index)}`,
            );
          }
        })();
      } finally {
        database.close();
      }
      const initial = messageRequest(path, { limit: 500 });
      const result = await runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "--no-env-file", "--no-install", "--no-macros",
          "--no-addons", `--config=${config}`, helper],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        stdin: `${JSON.stringify({ operation: "message-like-me.export-session", request: initial })}\n`,
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
        maxStderrBytes: 16 * 1024,
      });
      const frames = await consumeSessionFrames(result);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({
        kind: "page",
        index: 1,
        terminal: true,
      });
      expect((frames[0] as { messages: readonly unknown[] }).messages).toHaveLength(500);
      expect(frames[1]).toMatchObject({ kind: "seal", pages: 1, messages: 500 });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("holds and revalidates the exact session database through every page", () => {
    const path = createStore();
    const priorCwd = process.cwd();
    const frames: unknown[] = [];
    try {
      const initial = messageRequest(path, { limit: 1 });
      process.chdir(path);
      expect(() => projectWhatsAppMessageExportSessionFromBoundCwd(
        initial,
        (frame) => {
          frames.push(frame);
          if (frames.length !== 1) return;
          renameSync("session.db", "session.db.original");
          writeFileSync("session.db", "replacement");
          chmodSync("session.db", 0o600);
        },
      )).toThrow();
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ kind: "page", index: 1 });
    } finally {
      process.chdir(priorCwd);
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("filters exact PN and LID self chats before stdout and binds sorted aliases", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query("INSERT INTO chats(jid, kind) VALUES (?1, 'dm')")
          .run("15551234567@s.whatsapp.net");
        database.query("INSERT INTO chats(jid, kind) VALUES (?1, 'dm')")
          .run("999999999999999@lid");
        const insert = database.query(`
          INSERT INTO messages(chat_jid, msg_id, sender_jid, ts, from_me, text)
          VALUES (?1, ?2, ?3, ?4, 1, ?5)
        `);
        insert.run(
          "15551234567@s.whatsapp.net", "SELF-PN", OWNER_JID,
          1_776_513_700, "must-not-cross-stdout-pn",
        );
        insert.run(
          "999999999999999@lid", "SELF-LID", "999999999999999@lid",
          1_776_513_701, "must-not-cross-stdout-lid",
        );
      } finally {
        database.close();
      }
      const initial = messageRequest(path, { limit: 500 });
      const result = await runWhatsAppMessageExportSessionHelperChild({
        command: [process.execPath, "--no-env-file", "--no-install", "--no-macros",
          "--no-addons", `--config=${config}`, helper],
        cwd: path,
        environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        stdin: `${JSON.stringify({ operation: "message-like-me.export-session", request: initial })}\n`,
        timeoutMs: 10_000,
        maxOutputBytes: 8 * 1024 * 1024,
        maxStderrBytes: 16 * 1024,
      });
      const frames = await consumeSessionFrames(result);
      const encoded = JSON.stringify(frames);
      expect(encoded).not.toContain("must-not-cross-stdout");
      expect(frames[0]).toMatchObject({
        selfJids: ["15551234567@s.whatsapp.net", "999999999999999@lid"],
        selfChatsExcluded: "present-excluded",
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("excludes the fixed system chat and reports only a categorical condition", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query("INSERT INTO chats(jid, kind) VALUES (?1, ?2)")
          .run("0@s.whatsapp.net", "dm");
        database.query(`
          INSERT INTO messages(chat_jid,msg_id,sender_jid,ts,from_me,text)
          VALUES (?1,?2,NULL,?3,0,?4)
        `).run("0@s.whatsapp.net", "SYSTEM-1", 1_776_513_603, "private system body");
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      const projected = await messageResponse(path, messageRequest(path));
      expect(projected).toMatchObject({
        status: "succeeded",
        nonConversationChatsExcluded: true,
        messages: [
          { rowid: "1", messageId: "MSG-1" },
          { rowid: "2", messageId: "MSG-2" },
          { rowid: "3", messageId: "MSG-3" },
        ],
        nextCursor: null,
        localInsertPageComplete: true,
      });
      const encoded = JSON.stringify(projected);
      expect(encoded).not.toContain("0@s.whatsapp.net");
      expect(encoded).not.toContain("SYSTEM-1");
      expect(encoded).not.toContain("private system body");
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("reports unsupported chat JIDs excluded by the exact message filter", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        const unsupported = [
          ["unsupported@example.invalid", "dm"],
          ["00000@s.whatsapp.net", "dm"],
          ["1234567890123456@s.whatsapp.net", "dm"],
          ["14445556666:3@s.whatsapp.net", "dm"],
          ["00000@lid", "dm"],
          ["123456789012345678901@lid", "dm"],
          ["999999999999999:2@lid", "dm"],
          ["00000@g.us", "group"],
          ["12345-0@g.us", "group"],
        ] as const;
        for (const [index, [jid, kind]] of unsupported.entries()) {
          database.query("INSERT INTO chats(jid, kind) VALUES (?1, ?2)")
            .run(jid, kind);
          database.query(`
            INSERT INTO messages(chat_jid,msg_id,sender_jid,ts,from_me,text)
            VALUES (?1,?2,NULL,?3,0,?4)
          `).run(
            jid,
            `UNSUPPORTED-${String(index + 1)}`,
            1_776_513_603,
            `private unsupported body ${String(index + 1)}`,
          );
        }
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      const projected = await messageResponse(path, messageRequest(path));
      expect(projected).toMatchObject({
        status: "succeeded",
        nonConversationChatsExcluded: true,
        messages: [
          { rowid: "1", messageId: "MSG-1" },
          { rowid: "2", messageId: "MSG-2" },
          { rowid: "3", messageId: "MSG-3" },
        ],
      });
      const encoded = JSON.stringify(projected);
      for (const privateValue of [
        "unsupported@example.invalid",
        "00000@s.whatsapp.net",
        "1234567890123456@s.whatsapp.net",
        "14445556666:3@s.whatsapp.net",
        "00000@lid",
        "123456789012345678901@lid",
        "999999999999999:2@lid",
        "00000@g.us",
        "12345-0@g.us",
        "UNSUPPORTED-",
        "private unsupported body",
      ]) expect(encoded).not.toContain(privateValue);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("binds subsequent pages to both content anchors and the exact file generation", async () => {
    const path = createStore();
    try {
      const firstRequest = messageRequest(path, { limit: 1 });
      const first = await messageResponse(path, firstRequest);
      expect(first.status).toBe("succeeded");
      if (first.status !== "succeeded") throw new Error("expected successful first page");
      expect(await messageResponse(path, messageRequest(path, {
        cursor: first.checkpoint.cursor,
        cursorAnchor: "f".repeat(64),
        expectedGeneration: first.projectionGeneration,
        limit: 1,
      }))).toMatchObject({ status: "failed", errorCode: "projection-invalid" });

      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query("UPDATE messages SET text = 'changed after page one' WHERE rowid = 2").run();
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      expect(await messageResponse(path, messageRequest(path, {
        cursor: first.checkpoint.cursor,
        cursorAnchor: first.checkpoint.anchor,
        expectedGeneration: first.projectionGeneration,
        limit: 1,
      }))).toMatchObject({ status: "failed", errorCode: "generation-mismatch" });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("fails closed on contradictory direction, reaction, deletion, and purge rows", async () => {
    const mutations = [
      "UPDATE messages SET sender_jid = '15551234567@s.whatsapp.net' WHERE msg_id = 'MSG-1'",
      "UPDATE messages SET sender_jid = '15557654321@s.whatsapp.net' WHERE msg_id = 'MSG-2'",
      "UPDATE messages SET reaction_emoji = '👍', reaction_to_id = NULL WHERE msg_id = 'MSG-1'",
      "UPDATE messages SET deleted_at = ts + 1 WHERE msg_id = 'MSG-1'",
      "UPDATE messages SET revoked = 1, deleted_at = ts - 1 WHERE msg_id = 'MSG-1'",
      "UPDATE messages SET payload_purged_at = ts - 1 WHERE msg_id = 'MSG-1'",
    ] as const;
    for (const mutation of mutations) {
      const path = createStore();
      try {
        const database = new Database(join(path, "wacli.db"), { strict: true });
        try {
          database.exec(mutation);
        } finally {
          database.close();
        }
        chmodSync(join(path, "wacli.db"), 0o600);
        expect(await messageResponse(path, messageRequest(path))).toMatchObject({
          status: "failed",
          errorCode: "projection-invalid",
        });
      } finally {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });

  test("retains flag-only deletion and target-only reaction-removal evidence", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query(`
          UPDATE messages SET revoked = 1, deleted_at = NULL WHERE msg_id = 'MSG-1'
        `).run();
        database.query(`
          UPDATE messages
          SET reaction_to_id = 'MSG-1', reaction_emoji = NULL, text = NULL
          WHERE msg_id = 'MSG-3'
        `).run();
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      expect(await messageResponse(path, messageRequest(path))).toMatchObject({
        status: "succeeded",
        messages: [
          { messageId: "MSG-1", revoked: true, deletedAt: null },
          { messageId: "MSG-2" },
          { messageId: "MSG-3", reactionToMessageId: "MSG-1", reactionEmoji: null },
        ],
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("binds LID-owned outgoing direction to both exact session-proved aliases", async () => {
    const path = createStore();
    try {
      const database = new Database(join(path, "wacli.db"), { strict: true });
      try {
        database.query(`
          UPDATE messages SET sender_jid = '999999999999999:4@lid' WHERE msg_id = 'MSG-2'
        `).run();
      } finally {
        database.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      const lidProjection = await messageResponse(path, messageRequest(path, {
        accountSubject: "whatsapp:lid:999999999999999",
      }));
      expect(lidProjection).toMatchObject({ status: "succeeded" });
      if (lidProjection.status !== "succeeded") throw new Error("expected LID projection");
      expect(lidProjection.messages[1]).toMatchObject({
        messageId: "MSG-2",
        senderJid: "999999999999999:4@lid",
        fromMe: true,
      });

      const changed = new Database(join(path, "wacli.db"), { strict: true });
      try {
        changed.query(`
          UPDATE messages
          SET sender_jid = '15551234567:5@s.whatsapp.net'
          WHERE msg_id = 'MSG-2'
        `).run();
      } finally {
        changed.close();
      }
      chmodSync(join(path, "wacli.db"), 0o600);
      const pnAliasProjection = await messageResponse(path, messageRequest(path, {
        accountSubject: "whatsapp:lid:999999999999999",
      }));
      expect(pnAliasProjection).toMatchObject({ status: "succeeded" });
      if (pnAliasProjection.status !== "succeeded") throw new Error("expected PN alias projection");
      expect(pnAliasProjection.messages[1]).toMatchObject({
        senderJid: "15551234567:5@s.whatsapp.net",
        fromMe: true,
      });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
