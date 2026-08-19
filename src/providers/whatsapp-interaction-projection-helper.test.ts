import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  runWhatsAppContactProjectionHelperChild,
  type WhatsAppContactProjectionHelperResult,
} from "./whatsapp-web-runtime";
import {
  WHATSAPP_INTERACTION_PROJECTION_MAX_STDIN_BYTES,
  WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
  parseWhatsAppInteractionProjectionResponse,
  type WhatsAppInteractionProjectionRequest,
} from "./whatsapp-interaction-projection-protocol";

const OWNER_JID = "15551234567:3@s.whatsapp.net";
const helper = join(import.meta.dir, "whatsapp-interaction-projection-helper.ts");
const config = join(import.meta.dir, "../state-helper.bunfig.toml");

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
