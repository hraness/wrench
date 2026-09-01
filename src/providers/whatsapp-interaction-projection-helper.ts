import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { createHash } from "node:crypto";

import { Database, constants as sqliteConstants } from "bun:sqlite";

import {
  WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
  isExactWhatsAppContactProjectionMode,
} from "./whatsapp-contact-projection-protocol";
import { projectWhatsAppContactsFromBoundCwd } from "./whatsapp-contact-projection-helper";
import {
  WHATSAPP_INTERACTION_PROJECTION_MAX_STDIN_BYTES,
  WHATSAPP_INTERACTION_PROJECTION_MAX_STDOUT_BYTES,
  WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
  WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
  createWhatsAppInteractionProjectionFailure,
  parseWhatsAppInteractionProjectionRequest,
  type WhatsAppInteractionProjectionErrorCode,
  type WhatsAppInteractionProjectionItem,
  type WhatsAppInteractionProjectionRequest,
  type WhatsAppInteractionProjectionResponse,
  type WhatsAppInteractionProjectionSuccess,
} from "./whatsapp-interaction-projection-protocol";
import {
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDIN_BYTES,
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDOUT_BYTES,
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
  createWhatsAppMessageExportProjectionFailure,
  parseWhatsAppMessageExportProjectionRequest,
  type WhatsAppMessageExportProjectionItem,
  type WhatsAppMessageExportProjectionRequest,
  type WhatsAppMessageExportProjectionResponse,
  type WhatsAppMessageExportProjectionSuccess,
} from "./whatsapp-message-export-projection-protocol";

const MESSAGE_DATABASE_NAME = "wacli.db";
const IMMUTABLE_MESSAGE_DATABASE_URI = `file:${MESSAGE_DATABASE_NAME}?mode=ro&immutable=1`;
const IMMUTABLE_MESSAGE_DATABASE_FLAGS = sqliteConstants.SQLITE_OPEN_READONLY
  | sqliteConstants.SQLITE_OPEN_URI
  | sqliteConstants.SQLITE_OPEN_NOFOLLOW
  | sqliteConstants.SQLITE_OPEN_PRIVATECACHE
  | sqliteConstants.SQLITE_OPEN_EXRESCODE;
const MAX_MESSAGE_DATABASE_BYTES = 2n * 1024n * 1024n * 1024n;
const SQLITE_CACHE_KIB = 4_096;
const MAX_UNIX_SECONDS = 253_402_300_799n;
const SYSTEM_SENTINEL_JID = "0@s.whatsapp.net";

type BoundMessageStoreRequest = Pick<
  WhatsAppInteractionProjectionRequest,
  "accountSubject" | "storeIdentity" | "sessionIdentity" | "messageStoreIdentity"
>;

class HelperFailure extends Error {
  readonly code: WhatsAppInteractionProjectionErrorCode;

  constructor(code: WhatsAppInteractionProjectionErrorCode) {
    super("WhatsApp interaction projection helper failed");
    this.name = "WhatsAppInteractionProjectionHelperFailure";
    this.code = code;
  }
}

function fail(code: WhatsAppInteractionProjectionErrorCode): never {
  throw new HelperFailure(code);
}

function errorCode(error: unknown): WhatsAppInteractionProjectionErrorCode {
  return error instanceof HelperFailure ? error.code : "database-invalid";
}

function isNoEntry(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function currentUid(): bigint | null {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function matchesIdentity(
  stats: BigIntStats,
  identity: BoundMessageStoreRequest["messageStoreIdentity"],
): boolean {
  return stats.dev.toString() === identity.dev && stats.ino.toString() === identity.ino;
}

function assertBoundCwd(request: BoundMessageStoreRequest, initial?: BigIntStats): BigIntStats {
  let cwd: string;
  let pathStats: BigIntStats;
  let dotStats: BigIntStats;
  try {
    cwd = process.cwd();
    pathStats = lstatSync(cwd, { bigint: true });
    dotStats = lstatSync(".", { bigint: true });
    if (realpathSync(".") !== cwd) fail("store-binding-invalid");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("store-binding-invalid");
  }
  const uid = currentUid();
  if (
    !pathStats.isDirectory()
    || !dotStats.isDirectory()
    || pathStats.isSymbolicLink()
    || (uid !== null && (pathStats.uid !== uid || dotStats.uid !== uid))
    || !isExactWhatsAppContactProjectionMode(pathStats.mode, 0o700)
    || !sameSnapshot(pathStats, dotStats)
    || !matchesIdentity(pathStats, request.storeIdentity)
    || (initial !== undefined && !sameSnapshot(initial, pathStats))
  ) fail("store-binding-invalid");
  return pathStats;
}

function assertNoMessageSidecars(): void {
  for (const suffix of ["-journal", "-wal", "-shm"] as const) {
    try {
      lstatSync(`${MESSAGE_DATABASE_NAME}${suffix}`);
    } catch (error) {
      if (isNoEntry(error)) continue;
      return fail("message-store-sidecar-state-unverified");
    }
    fail("message-store-sidecar-present");
  }
}

function assertMessageFile(
  stats: BigIntStats,
  request: BoundMessageStoreRequest,
): void {
  const uid = currentUid();
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1n
    || (uid !== null && stats.uid !== uid)
    || !isExactWhatsAppContactProjectionMode(stats.mode, 0o600)
    || !matchesIdentity(stats, request.messageStoreIdentity)
  ) fail("message-store-file-invalid");
  if (stats.size < 1n || stats.size > MAX_MESSAGE_DATABASE_BYTES) {
    fail("message-store-file-too-large");
  }
}

function exactMessagePathSnapshot(
  initial: BigIntStats,
  request: BoundMessageStoreRequest,
): void {
  let pathStats: BigIntStats;
  try {
    pathStats = lstatSync(MESSAGE_DATABASE_NAME, { bigint: true });
  } catch {
    return fail("message-store-file-invalid");
  }
  assertMessageFile(pathStats, request);
  if (!sameSnapshot(initial, pathStats)) fail("message-store-file-invalid");
}

type SqliteRow = Readonly<Record<string, unknown>>;

function rows(
  value: Iterable<unknown>,
  maximum: number,
  failureCode: WhatsAppInteractionProjectionErrorCode = "schema-mismatch",
): readonly SqliteRow[] {
  const result: SqliteRow[] = [];
  for (const item of value) {
    if (result.length >= maximum) fail(failureCode);
    if (
      typeof item !== "object"
      || item === null
      || Array.isArray(item)
      || Object.getPrototypeOf(item) !== Object.prototype
    ) fail(failureCode);
    result.push(item as SqliteRow);
  }
  return result;
}

function exactRowKeys(row: SqliteRow, expected: readonly string[]): void {
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("schema-mismatch");
  }
}

function pragmaInteger(value: unknown, expected: bigint): boolean {
  return value === expected || value === Number(expected);
}

function singlePragmaInteger(database: Database, sql: string): bigint {
  const result = rows(database.query(sql).iterate(), 1, "database-invalid");
  if (result.length !== 1 || Object.values(result[0]!).length !== 1) fail("database-invalid");
  const value = Object.values(result[0]!)[0];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return fail("database-invalid");
}

function configureDatabase(database: Database): void {
  try {
    database.exec(`
      PRAGMA query_only = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA cell_size_check = ON;
      PRAGMA recursive_triggers = OFF;
      PRAGMA writable_schema = OFF;
      PRAGMA ignore_check_constraints = OFF;
      PRAGMA automatic_index = OFF;
      PRAGMA mmap_size = 0;
      PRAGMA cache_size = -${SQLITE_CACHE_KIB};
    `);
    for (const [sql, expected] of [
      ["PRAGMA query_only", 1n],
      ["PRAGMA trusted_schema", 0n],
      ["PRAGMA foreign_keys", 1n],
      ["PRAGMA temp_store", 2n],
      ["PRAGMA cell_size_check", 1n],
      ["PRAGMA recursive_triggers", 0n],
      ["PRAGMA writable_schema", 0n],
      ["PRAGMA ignore_check_constraints", 0n],
      ["PRAGMA automatic_index", 0n],
      ["PRAGMA cache_size", BigInt(-SQLITE_CACHE_KIB)],
    ] as const) {
      if (singlePragmaInteger(database, sql) !== expected) fail("database-invalid");
    }
    const mmap = rows(database.query("PRAGMA mmap_size").iterate(), 1, "database-invalid");
    if (mmap.length === 1 && !pragmaInteger(Object.values(mmap[0]!)[0], 0n)) {
      fail("database-invalid");
    }
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    fail("database-invalid");
  }
}

function assertIntegrity(database: Database): void {
  try {
    const integrity = rows(
      database.query("PRAGMA integrity_check(1)").iterate(),
      1,
      "database-integrity-failed",
    );
    if (
      integrity.length !== 1
      || Object.values(integrity[0]!).length !== 1
      || Object.values(integrity[0]!)[0] !== "ok"
      || rows(
        database.query("PRAGMA foreign_key_check").iterate(),
        1,
        "database-integrity-failed",
      ).length !== 0
    ) fail("database-integrity-failed");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    fail("database-integrity-failed");
  }
}

const MESSAGE_COLUMNS = Object.freeze([
  ["rowid", "INTEGER", 0n, null, 1n], ["chat_jid", "TEXT", 1n, null, 0n],
  ["chat_name", "TEXT", 0n, null, 0n], ["msg_id", "TEXT", 1n, null, 0n],
  ["sender_jid", "TEXT", 0n, null, 0n], ["sender_name", "TEXT", 0n, null, 0n],
  ["ts", "INTEGER", 1n, null, 0n], ["from_me", "INTEGER", 1n, null, 0n],
  ["text", "TEXT", 0n, null, 0n], ["display_text", "TEXT", 0n, null, 0n],
  ["quoted_msg_id", "TEXT", 0n, null, 0n], ["quoted_sender_jid", "TEXT", 0n, null, 0n],
  ["is_forwarded", "INTEGER", 1n, "0", 0n], ["forwarding_score", "INTEGER", 1n, "0", 0n],
  ["reaction_to_id", "TEXT", 0n, null, 0n], ["reaction_emoji", "TEXT", 0n, null, 0n],
  ["media_type", "TEXT", 0n, null, 0n], ["media_caption", "TEXT", 0n, null, 0n],
  ["filename", "TEXT", 0n, null, 0n], ["mime_type", "TEXT", 0n, null, 0n],
  ["direct_path", "TEXT", 0n, null, 0n], ["media_key", "BLOB", 0n, null, 0n],
  ["file_sha256", "BLOB", 0n, null, 0n], ["file_enc_sha256", "BLOB", 0n, null, 0n],
  ["file_length", "INTEGER", 0n, null, 0n], ["local_path", "TEXT", 0n, null, 0n],
  ["downloaded_at", "INTEGER", 0n, null, 0n], ["media_unavailable_at", "INTEGER", 0n, null, 0n],
  ["revoked", "INTEGER", 1n, "0", 0n], ["deleted_for_me", "INTEGER", 1n, "0", 0n],
  ["deleted_at", "INTEGER", 0n, null, 0n], ["deletion_reason", "TEXT", 0n, null, 0n],
  ["payload_purged_at", "INTEGER", 0n, null, 0n],
  ["edited", "INTEGER", 1n, "0", 0n], ["edited_ts", "INTEGER", 1n, "0", 0n],
  ["buttons", "TEXT", 0n, null, 0n],
] as const);

const CHAT_COLUMNS = Object.freeze([
  ["jid", "TEXT", 0n, null, 1n], ["kind", "TEXT", 1n, null, 0n],
  ["name", "TEXT", 0n, null, 0n], ["last_message_ts", "INTEGER", 0n, null, 0n],
  ["archived", "INTEGER", 1n, "0", 0n], ["pinned", "INTEGER", 1n, "0", 0n],
  ["muted_until", "INTEGER", 1n, "0", 0n], ["unread", "INTEGER", 1n, "0", 0n],
  ["unread_count", "INTEGER", 1n, "0", 0n],
] as const);

function assertColumns(database: Database, table: "messages" | "chats", expected: typeof MESSAGE_COLUMNS | typeof CHAT_COLUMNS): void {
  const actual = rows(database.query(`PRAGMA table_xinfo('${table}')`).iterate(), expected.length);
  if (actual.length !== expected.length) fail("schema-mismatch");
  for (const [index, tuple] of expected.entries()) {
    const row = actual[index]!;
    exactRowKeys(row, ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"]);
    const [name, type, notnull, defaultValue, pk] = tuple;
    if (
      !pragmaInteger(row.cid, BigInt(index))
      || row.name !== name
      || row.type !== type
      || !pragmaInteger(row.notnull, notnull)
      || row.dflt_value !== defaultValue
      || !pragmaInteger(row.pk, pk)
      || !pragmaInteger(row.hidden, 0n)
    ) fail("schema-mismatch");
  }
}

function assertIndexes(database: Database): void {
  const indexes = rows(database.query("PRAGMA index_list('messages')").iterate(), 3);
  if (indexes.length !== 3) fail("schema-mismatch");
  const expected = new Map<string, readonly [bigint, string]>([
    ["idx_messages_ts", [0n, "c"]],
    ["idx_messages_chat_ts", [0n, "c"]],
    ["sqlite_autoindex_messages_1", [1n, "u"]],
  ] as const);
  for (const row of indexes) {
    exactRowKeys(row, ["seq", "name", "unique", "origin", "partial"]);
    const specification = typeof row.name === "string" ? expected.get(row.name) : undefined;
    if (
      specification === undefined
      || !pragmaInteger(row.unique, specification[0])
      || row.origin !== specification[1]
      || !pragmaInteger(row.partial, 0n)
    ) fail("schema-mismatch");
  }
  for (const [name, columns] of [
    ["idx_messages_ts", ["ts"]],
    ["idx_messages_chat_ts", ["chat_jid", "ts"]],
  ] as const) {
    const indexColumns = rows(
      database.query(`PRAGMA index_xinfo('${name}')`).iterate(),
      columns.length + 1,
    );
    if (indexColumns.length !== columns.length + 1) fail("schema-mismatch");
    for (const [index, column] of columns.entries()) {
      const row = indexColumns[index]!;
      exactRowKeys(row, ["seqno", "cid", "name", "desc", "coll", "key"]);
      if (
        !pragmaInteger(row.seqno, BigInt(index))
        || row.name !== column
        || !pragmaInteger(row.desc, 0n)
        || row.coll !== "BINARY"
        || !pragmaInteger(row.key, 1n)
      ) fail("schema-mismatch");
    }
    const rowid = indexColumns.at(-1)!;
    exactRowKeys(rowid, ["seqno", "cid", "name", "desc", "coll", "key"]);
    if (
      rowid.name !== null
      || !pragmaInteger(rowid.cid, -1n)
      || !pragmaInteger(rowid.key, 0n)
    ) fail("schema-mismatch");
  }
  const uniqueColumns = rows(
    database.query("PRAGMA index_xinfo('sqlite_autoindex_messages_1')").iterate(),
    3,
  );
  if (
    uniqueColumns.length !== 3
    || uniqueColumns[0]?.name !== "chat_jid"
    || uniqueColumns[1]?.name !== "msg_id"
    || !pragmaInteger(uniqueColumns[0]?.key, 1n)
    || !pragmaInteger(uniqueColumns[1]?.key, 1n)
    || !pragmaInteger(uniqueColumns[2]?.key, 0n)
  ) fail("schema-mismatch");
  const chatIndexes = rows(database.query("PRAGMA index_list('chats')").iterate(), 1);
  if (
    chatIndexes.length !== 1
    || chatIndexes[0]?.name !== "sqlite_autoindex_chats_1"
    || chatIndexes[0]?.origin !== "pk"
    || !pragmaInteger(chatIndexes[0]?.unique, 1n)
    || !pragmaInteger(chatIndexes[0]?.partial, 0n)
  ) fail("schema-mismatch");
}

function assertForeignKey(database: Database): void {
  const foreignKeys = rows(database.query("PRAGMA foreign_key_list('messages')").iterate(), 1);
  const row = foreignKeys[0];
  if (foreignKeys.length !== 1 || row === undefined) fail("schema-mismatch");
  exactRowKeys(row, ["id", "seq", "table", "from", "to", "on_update", "on_delete", "match"]);
  if (
    !pragmaInteger(row.id, 0n)
    || !pragmaInteger(row.seq, 0n)
    || row.table !== "chats"
    || row.from !== "chat_jid"
    || row.to !== "jid"
    || row.on_update !== "NO ACTION"
    || row.on_delete !== "CASCADE"
    || row.match !== "NONE"
  ) fail("schema-mismatch");
}

function assertPinnedSchema(database: Database): void {
  try {
    const tables = rows(database.query(`
      SELECT schema, name, type, ncol, wr, strict
      FROM pragma_table_list
      WHERE schema = 'main' AND name IN ('messages', 'chats')
      LIMIT 3
    `).iterate(), 3);
    for (const [name, count] of [["messages", 36n], ["chats", 9n]] as const) {
      const matches = tables.filter((row) => row.name === name);
      if (matches.length === 1) {
        exactRowKeys(matches[0]!, ["schema", "name", "type", "ncol", "wr", "strict"]);
      }
      if (
        matches.length !== 1
        || matches[0]?.type !== "table"
        || !pragmaInteger(matches[0]?.ncol, count)
        || !pragmaInteger(matches[0]?.wr, 0n)
        || !pragmaInteger(matches[0]?.strict, 0n)
      ) fail("schema-mismatch");
    }
    assertColumns(database, "messages", MESSAGE_COLUMNS);
    assertColumns(database, "chats", CHAT_COLUMNS);
    assertIndexes(database);
    assertForeignKey(database);
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    fail("schema-mismatch");
  }
}

function sqliteBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/u.test(value)) {
    return BigInt(value);
  }
  return fail("projection-invalid");
}

function projectedJid(value: unknown, nullable = false): string | null {
  if (nullable && (value === null || value === "")) return null;
  if (
    typeof value !== "string"
    || value.length < 9
    || value.length > 96
    || !(
      value === SYSTEM_SENTINEL_JID
      || /^[0-9]{5,20}(?::[0-9]{1,5})?@s\.whatsapp\.net$/u.test(value)
      || /^[0-9]{5,32}(?::[0-9]{1,5})?@lid$/u.test(value)
      || /^[0-9]{5,32}(?:-[0-9]{5,20})?@g\.us$/u.test(value)
      || /^[0-9]{5,32}@newsletter$/u.test(value)
      || /^(?:status|[0-9]{5,32})@broadcast$/u.test(value)
    )
  ) fail("projection-invalid");
  return value;
}

function projectItem(row: SqliteRow): WhatsAppInteractionProjectionItem {
  exactRowKeys(row, ["rowid", "chat_jid", "msg_id", "sender_jid", "ts", "from_me", "chat_kind"]);
  const rowid = sqliteBigInt(row.rowid);
  const seconds = sqliteBigInt(row.ts);
  const fromMe = sqliteBigInt(row.from_me);
  if (
    rowid < 1n
    || seconds < 0n
    || seconds > MAX_UNIX_SECONDS
    || (fromMe !== 0n && fromMe !== 1n)
    || typeof row.msg_id !== "string"
    || !/^[A-Za-z0-9._~:-]{1,256}$/u.test(row.msg_id)
    || (row.chat_kind !== "dm"
      && row.chat_kind !== "group"
      && row.chat_kind !== "broadcast"
      && row.chat_kind !== "newsletter"
      && row.chat_kind !== "unknown")
  ) fail("projection-invalid");
  const chatJid = projectedJid(row.chat_jid)! as string;
  return Object.freeze({
    rowid: rowid.toString(),
    chatJid,
    messageId: row.msg_id,
    senderJid: projectedJid(row.sender_jid, true),
    timestamp: new Date(Number(seconds) * 1_000).toISOString(),
    fromMe: fromMe === 1n,
    chatKind: chatJid === SYSTEM_SENTINEL_JID ? "unknown" : row.chat_kind,
  });
}

function interactionAnchor(item: WhatsAppInteractionProjectionItem): string {
  return createHash("sha256")
    .update(item.rowid)
    .update("\0")
    .update(item.chatJid)
    .update("\0")
    .update(item.messageId)
    .digest("hex");
}

function assertCursorAnchor(
  database: Database,
  request: WhatsAppInteractionProjectionRequest,
): void {
  if (request.cursor === "0") return;
  let projected: readonly SqliteRow[];
  try {
    projected = rows(database.query(`
      SELECT
        CAST(m.rowid AS TEXT) AS rowid, m.chat_jid, m.msg_id, m.sender_jid,
        CAST(m.ts AS TEXT) AS ts, CAST(m.from_me AS TEXT) AS from_me,
        c.kind AS chat_kind
      FROM messages m
      JOIN chats c ON c.jid = m.chat_jid
      WHERE m.rowid = ?1
      LIMIT 2
    `).iterate(BigInt(request.cursor)), 2, "projection-invalid");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("projection-invalid");
  }
  if (
    projected.length !== 1
    || interactionAnchor(projectItem(projected[0]!)) !== request.cursorAnchor
  ) fail("projection-invalid");
}

function projectInteractions(
  database: Database,
  request: WhatsAppInteractionProjectionRequest,
): WhatsAppInteractionProjectionSuccess {
  let projectedRows: readonly SqliteRow[];
  try {
    projectedRows = rows(database.query(`
      SELECT
        CAST(m.rowid AS TEXT) AS rowid,
        m.chat_jid,
        m.msg_id,
        m.sender_jid,
        CAST(m.ts AS TEXT) AS ts,
        CAST(m.from_me AS TEXT) AS from_me,
        c.kind AS chat_kind
      FROM messages m
      JOIN chats c ON c.jid = m.chat_jid
      WHERE m.rowid > ?1
      ORDER BY m.rowid ASC
      LIMIT ?2
    `).iterate(BigInt(request.cursor), request.limit + 1), request.limit + 1, "projection-invalid");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("projection-invalid");
  }
  const projected = projectedRows.map(projectItem);
  for (let index = 0; index < projected.length; index += 1) {
    const previous = index === 0 ? request.cursor : projected[index - 1]?.rowid;
    if (previous === undefined || BigInt(projected[index]!.rowid) <= BigInt(previous)) {
      fail("projection-invalid");
    }
  }
  const hasMore = projected.length > request.limit;
  const interactions = Object.freeze(projected.slice(0, request.limit));
  const last = interactions.at(-1);
  const checkpoint = last === undefined
    ? Object.freeze({ cursor: request.cursor, anchor: request.cursorAnchor })
    : Object.freeze({ cursor: last.rowid, anchor: interactionAnchor(last) });
  return Object.freeze({
    schemaVersion: WHATSAPP_INTERACTION_PROJECTION_PROTOCOL_VERSION,
    status: "succeeded",
    projectionGeneration: Object.freeze({
      messageStoreIdentity: request.messageStoreIdentity,
      schemaFingerprint: WHATSAPP_INTERACTION_PROJECTION_SCHEMA_FINGERPRINT,
    }),
    interactions,
    nextCursor: hasMore ? interactions.at(-1)?.rowid ?? null : null,
    localInsertPageComplete: !hasMore,
    checkpoint,
  });
}

function messageExportGeneration(
  stats: BigIntStats,
): WhatsAppMessageExportProjectionSuccess["projectionGeneration"] {
  return Object.freeze({
    messageStoreIdentity: Object.freeze({
      dev: stats.dev.toString(),
      ino: stats.ino.toString(),
    }),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    schemaFingerprint: WHATSAPP_MESSAGE_EXPORT_PROJECTION_SCHEMA_FINGERPRINT,
  });
}

function sameMessageExportGeneration(
  left: WhatsAppMessageExportProjectionSuccess["projectionGeneration"],
  right: WhatsAppMessageExportProjectionSuccess["projectionGeneration"],
): boolean {
  return left.messageStoreIdentity.dev === right.messageStoreIdentity.dev
    && left.messageStoreIdentity.ino === right.messageStoreIdentity.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.schemaFingerprint === right.schemaFingerprint;
}

function projectedText(
  value: unknown,
  maximumBytes: number,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes) {
    return fail("projection-invalid");
  }
  return value;
}

function projectedBoolean(value: unknown): boolean {
  const parsed = sqliteBigInt(value);
  if (parsed !== 0n && parsed !== 1n) return fail("projection-invalid");
  return parsed === 1n;
}

function projectedUnixTimestamp(value: unknown, nullable: boolean): string | null {
  if (nullable && (value === null || value === "" || value === 0 || value === 0n || value === "0")) {
    return null;
  }
  const seconds = sqliteBigInt(value);
  if (seconds < 0n || seconds > MAX_UNIX_SECONDS) return fail("projection-invalid");
  return new Date(Number(seconds) * 1_000).toISOString();
}

function projectedFileLength(value: unknown): number | null {
  if (value === null || value === "") return null;
  const parsed = sqliteBigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail("projection-invalid");
  }
  return Number(parsed);
}

function projectMessageExportItem(row: SqliteRow): WhatsAppMessageExportProjectionItem {
  exactRowKeys(row, [
    "rowid", "chat_jid", "chat_kind", "chat_name", "msg_id", "sender_jid", "sender_name",
    "ts", "from_me", "text", "display_text", "quoted_msg_id", "quoted_sender_jid",
    "reaction_to_id", "reaction_emoji", "media_type", "media_caption", "filename",
    "mime_type", "file_length", "revoked", "deleted_for_me", "deleted_at",
    "payload_purged_at", "edited", "edited_ts",
  ]);
  const rowid = sqliteBigInt(row.rowid);
  if (
    rowid < 1n
    || (row.chat_kind !== "dm" && row.chat_kind !== "group")
    || typeof row.msg_id !== "string"
    || !/^[A-Za-z0-9._~:-]{1,256}$/u.test(row.msg_id)
  ) return fail("projection-invalid");
  const timestamp = projectedUnixTimestamp(row.ts, false)! as string;
  const editedFlag = projectedBoolean(row.edited);
  const rawEditedAt = projectedUnixTimestamp(row.edited_ts, true);
  const edited = editedFlag && rawEditedAt !== null && rawEditedAt >= timestamp;
  const fileNameCandidate = projectedText(row.filename, 8 * 1024);
  const fileName = fileNameCandidate !== null && (
    fileNameCandidate === "."
    || fileNameCandidate === ".."
    || fileNameCandidate.includes("/")
    || fileNameCandidate.includes("\\")
  ) ? null : fileNameCandidate;
  const senderJid = row.sender_jid === SYSTEM_SENTINEL_JID
    ? null
    : projectedJid(row.sender_jid, true);
  const quotedSenderJid = row.quoted_sender_jid === SYSTEM_SENTINEL_JID
    ? null
    : projectedJid(row.quoted_sender_jid, true);
  return Object.freeze({
    rowid: rowid.toString(),
    chatJid: projectedJid(row.chat_jid)! as string,
    chatKind: row.chat_kind,
    chatName: projectedText(row.chat_name, 8 * 1024),
    messageId: row.msg_id,
    senderJid,
    senderName: projectedText(row.sender_name, 8 * 1024),
    timestamp,
    fromMe: projectedBoolean(row.from_me),
    text: projectedText(row.text, 1024 * 1024),
    displayText: projectedText(row.display_text, 1024 * 1024),
    quotedMessageId: projectedText(row.quoted_msg_id, 256),
    quotedSenderJid,
    reactionToMessageId: projectedText(row.reaction_to_id, 256),
    reactionEmoji: projectedText(row.reaction_emoji, 8 * 1024),
    mediaType: projectedText(row.media_type, 256),
    mediaCaption: projectedText(row.media_caption, 1024 * 1024),
    fileName,
    mimeType: projectedText(row.mime_type, 256),
    fileLength: projectedFileLength(row.file_length),
    revoked: projectedBoolean(row.revoked),
    deletedForMe: projectedBoolean(row.deleted_for_me),
    deletedAt: projectedUnixTimestamp(row.deleted_at, true),
    payloadPurgedAt: projectedUnixTimestamp(row.payload_purged_at, true),
    edited,
    editedAt: edited ? rawEditedAt : null,
  });
}

function messageExportAnchor(item: WhatsAppMessageExportProjectionItem): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}

const MESSAGE_EXPORT_FILTER = `
  c.kind IN ('dm', 'group')
  AND m.chat_jid <> '0@s.whatsapp.net'
  AND m.chat_jid NOT LIKE '%@broadcast'
  AND m.chat_jid NOT LIKE '%@newsletter'
  AND (
    m.chat_jid LIKE '%@s.whatsapp.net'
    OR m.chat_jid LIKE '%@lid'
    OR m.chat_jid LIKE '%@g.us'
  )
`;

function hasSystemChatMessages(database: Database): boolean {
  let projected: readonly SqliteRow[];
  try {
    projected = rows(database.query(`
      SELECT EXISTS(
        SELECT 1 FROM messages WHERE chat_jid = ?1 LIMIT 1
      ) AS excluded
    `).iterate(SYSTEM_SENTINEL_JID), 1, "projection-invalid");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("projection-invalid");
  }
  if (projected.length !== 1) return fail("projection-invalid");
  exactRowKeys(projected[0]!, ["excluded"]);
  return projectedBoolean(projected[0]!.excluded);
}

const MESSAGE_EXPORT_COLUMNS = `
  CAST(m.rowid AS TEXT) AS rowid,
  m.chat_jid,
  c.kind AS chat_kind,
  COALESCE(m.chat_name, c.name) AS chat_name,
  m.msg_id,
  m.sender_jid,
  m.sender_name,
  CAST(m.ts AS TEXT) AS ts,
  CAST(m.from_me AS TEXT) AS from_me,
  m.text,
  m.display_text,
  m.quoted_msg_id,
  m.quoted_sender_jid,
  m.reaction_to_id,
  m.reaction_emoji,
  m.media_type,
  m.media_caption,
  m.filename,
  m.mime_type,
  CAST(m.file_length AS TEXT) AS file_length,
  CAST(m.revoked AS TEXT) AS revoked,
  CAST(m.deleted_for_me AS TEXT) AS deleted_for_me,
  CAST(m.deleted_at AS TEXT) AS deleted_at,
  CAST(m.payload_purged_at AS TEXT) AS payload_purged_at,
  CAST(m.edited AS TEXT) AS edited,
  CAST(m.edited_ts AS TEXT) AS edited_ts
`;

function assertMessageExportCursorAnchor(
  database: Database,
  request: WhatsAppMessageExportProjectionRequest,
): void {
  if (request.cursor === "0") return;
  let projected: readonly SqliteRow[];
  try {
    projected = rows(database.query(`
      SELECT ${MESSAGE_EXPORT_COLUMNS}
      FROM messages m
      JOIN chats c ON c.jid = m.chat_jid
      WHERE m.rowid = ?1 AND ${MESSAGE_EXPORT_FILTER}
      LIMIT 2
    `).iterate(BigInt(request.cursor)), 2, "projection-invalid");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("projection-invalid");
  }
  if (
    projected.length !== 1
    || messageExportAnchor(projectMessageExportItem(projected[0]!)) !== request.cursorAnchor
  ) return fail("projection-invalid");
}

function projectMessageExport(
  database: Database,
  request: WhatsAppMessageExportProjectionRequest,
  fileStats: BigIntStats,
): WhatsAppMessageExportProjectionSuccess {
  const projectionGeneration = messageExportGeneration(fileStats);
  if (
    request.expectedGeneration !== null
    && !sameMessageExportGeneration(projectionGeneration, request.expectedGeneration)
  ) return fail("generation-mismatch");
  const systemChatExcluded = hasSystemChatMessages(database);
  assertMessageExportCursorAnchor(database, request);
  let projectedRows: readonly SqliteRow[];
  try {
    projectedRows = rows(database.query(`
      SELECT ${MESSAGE_EXPORT_COLUMNS}
      FROM messages m
      JOIN chats c ON c.jid = m.chat_jid
      WHERE m.rowid > ?1 AND ${MESSAGE_EXPORT_FILTER}
      ORDER BY m.rowid ASC
      LIMIT ?2
    `).iterate(BigInt(request.cursor), request.limit + 1), request.limit + 1, "projection-invalid");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("projection-invalid");
  }
  const projected = projectedRows.map(projectMessageExportItem);
  for (let index = 0; index < projected.length; index += 1) {
    const previous = index === 0 ? request.cursor : projected[index - 1]!.rowid;
    if (BigInt(projected[index]!.rowid) <= BigInt(previous)) return fail("projection-invalid");
  }
  const hasMore = projected.length > request.limit;
  const messages = Object.freeze(projected.slice(0, request.limit));
  const last = messages.at(-1);
  const checkpoint = last === undefined
    ? Object.freeze({ cursor: request.cursor, anchor: request.cursorAnchor })
    : Object.freeze({ cursor: last.rowid, anchor: messageExportAnchor(last) });
  return Object.freeze({
    schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
    status: "succeeded",
    projectionGeneration,
    systemChatExcluded,
    messages,
    nextCursor: hasMore ? last?.rowid ?? null : null,
    localInsertPageComplete: !hasMore,
    checkpoint,
  });
}

function projectBoundWhatsAppMessageStore<Result>(
  request: BoundMessageStoreRequest,
  projection: (database: Database, fileStats: BigIntStats) => Result,
): Result {
  const initialCwd = assertBoundCwd(request);
  try {
    projectWhatsAppContactsFromBoundCwd({
      schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
      operation: "contacts.list",
      accountSubject: request.accountSubject,
      cursor: null,
      limit: 1,
      storeIdentity: request.storeIdentity,
      sessionIdentity: request.sessionIdentity,
    });
  } catch {
    return fail("owner-mismatch");
  }
  assertBoundCwd(request, initialCwd);
  assertNoMessageSidecars();
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) return fail("message-store-file-invalid");
  const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = openSync(MESSAGE_DATABASE_NAME, fsConstants.O_RDONLY | noFollow | nonBlock);
  } catch {
    return fail("message-store-file-invalid");
  }
  let initialFile: BigIntStats | undefined;
  let database: Database | undefined;
  let result: Result | undefined;
  let failure: unknown;
  try {
    initialFile = fstatSync(descriptor, { bigint: true });
    assertMessageFile(initialFile, request);
    exactMessagePathSnapshot(initialFile, request);
    // wacli persists WAL journal mode in the database header. Once the linked
    // device is quiescent it may leave no -wal/-shm sidecars, and an ordinary
    // read-only SQLite open then tries (and fails) to recreate shared-memory
    // state. The path is fixed, the parent directory and inode are bound above,
    // and both are revalidated after close, so immutable mode is the correct
    // side-effect-free way to read that already-proven quiescent snapshot.
    // SQLITE_OPEN_URI is explicit because Bun's Linux SQLite build does not
    // inherit macOS SQLite's process-wide URI-filename configuration.
    database = new Database(
      IMMUTABLE_MESSAGE_DATABASE_URI,
      IMMUTABLE_MESSAGE_DATABASE_FLAGS,
    );
    configureDatabase(database);
    assertIntegrity(database);
    assertPinnedSchema(database);
    result = projection(database, initialFile);
  } catch (error) {
    failure = error;
  } finally {
    try {
      database?.close();
    } catch {
      failure = new HelperFailure("database-invalid");
    }
  }
  try {
    if (initialFile !== undefined) {
      const after = fstatSync(descriptor, { bigint: true });
      if (!sameSnapshot(initialFile, after)) fail("message-store-file-invalid");
      exactMessagePathSnapshot(initialFile, request);
    }
    assertBoundCwd(request, initialCwd);
    assertNoMessageSidecars();
  } catch (error) {
    failure = error;
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      failure = new HelperFailure("message-store-file-invalid");
    }
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new HelperFailure("database-invalid");
  }
  if (result === undefined) return fail("projection-invalid");
  return result;
}

export function projectWhatsAppInteractionsFromBoundCwd(
  requestValue: unknown,
): WhatsAppInteractionProjectionSuccess {
  const request = parseWhatsAppInteractionProjectionRequest(requestValue);
  return projectBoundWhatsAppMessageStore(request, (database) => {
    assertCursorAnchor(database, request);
    return projectInteractions(database, request);
  });
}

export function projectWhatsAppMessageExportFromBoundCwd(
  requestValue: unknown,
): WhatsAppMessageExportProjectionSuccess {
  const request = parseWhatsAppMessageExportProjectionRequest(requestValue);
  return projectBoundWhatsAppMessageStore(
    request,
    (database, fileStats) => projectMessageExport(database, request, fileStats),
  );
}

async function readBoundedStdin(): Promise<unknown> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > Math.max(
        WHATSAPP_INTERACTION_PROJECTION_MAX_STDIN_BYTES,
        WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDIN_BYTES,
      )) {
        return fail("request-invalid");
      }
      chunks.push(item.value);
    }
  } catch {
    return fail("request-invalid");
  } finally {
    reader.releaseLock();
  }
  if (length < 2) return fail("request-invalid");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length),
    )) as unknown;
  } catch {
    return fail("request-invalid");
  }
}

export async function runWhatsAppInteractionProjectionHelper(): Promise<
  WhatsAppInteractionProjectionResponse | WhatsAppMessageExportProjectionResponse
> {
  let requestValue: unknown;
  try {
    if (process.argv.length !== 2) fail("request-invalid");
    requestValue = await readBoundedStdin();
  } catch {
    return createWhatsAppInteractionProjectionFailure("request-invalid");
  }
  const messageExport = typeof requestValue === "object"
    && requestValue !== null
    && !Array.isArray(requestValue)
    && "operation" in requestValue
    && requestValue.operation === "message-like-me.export";
  if (messageExport) {
    let request: WhatsAppMessageExportProjectionRequest;
    try {
      request = parseWhatsAppMessageExportProjectionRequest(requestValue);
    } catch {
      return createWhatsAppMessageExportProjectionFailure("request-invalid");
    }
    try {
      return projectWhatsAppMessageExportFromBoundCwd(request);
    } catch (error) {
      return createWhatsAppMessageExportProjectionFailure(errorCode(error));
    }
  }
  let request: WhatsAppInteractionProjectionRequest;
  try {
    request = parseWhatsAppInteractionProjectionRequest(requestValue);
  } catch {
    return createWhatsAppInteractionProjectionFailure("request-invalid");
  }
  try {
    return projectWhatsAppInteractionsFromBoundCwd(request);
  } catch (error) {
    return createWhatsAppInteractionProjectionFailure(errorCode(error));
  }
}

async function main(): Promise<void> {
  let response = await runWhatsAppInteractionProjectionHelper();
  let output = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(output, "utf8") > Math.max(
    WHATSAPP_INTERACTION_PROJECTION_MAX_STDOUT_BYTES,
    WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDOUT_BYTES,
  )) {
    response = createWhatsAppMessageExportProjectionFailure("output-too-large");
    output = `${JSON.stringify(response)}\n`;
  }
  await Bun.write(Bun.stdout, output);
}

if (import.meta.main) await main();
