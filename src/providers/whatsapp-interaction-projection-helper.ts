import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { createHash } from "node:crypto";

import { Database } from "bun:sqlite";

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

const MESSAGE_DATABASE_NAME = "wacli.db";
const MAX_MESSAGE_DATABASE_BYTES = 2n * 1024n * 1024n * 1024n;
const SQLITE_CACHE_KIB = 4_096;
const MAX_UNIX_SECONDS = 253_402_300_799n;

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
  identity: WhatsAppInteractionProjectionRequest["messageStoreIdentity"],
): boolean {
  return stats.dev.toString() === identity.dev && stats.ino.toString() === identity.ino;
}

function assertBoundCwd(request: WhatsAppInteractionProjectionRequest, initial?: BigIntStats): BigIntStats {
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
  request: WhatsAppInteractionProjectionRequest,
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
  request: WhatsAppInteractionProjectionRequest,
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
    for (const [name, count] of [["messages", 33n], ["chats", 9n]] as const) {
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
  return fail("projection-invalid");
}

function projectedJid(value: unknown, nullable = false): string | null {
  if (nullable && (value === null || value === "")) return null;
  if (
    typeof value !== "string"
    || value.length < 9
    || value.length > 96
    || !(
      /^[0-9]{5,20}(?::[0-9]{1,5})?@s\.whatsapp\.net$/u.test(value)
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
  return Object.freeze({
    rowid: rowid.toString(),
    chatJid: projectedJid(row.chat_jid)! as string,
    messageId: row.msg_id,
    senderJid: projectedJid(row.sender_jid, true),
    timestamp: new Date(Number(seconds) * 1_000).toISOString(),
    fromMe: fromMe === 1n,
    chatKind: row.chat_kind,
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
        m.rowid, m.chat_jid, m.msg_id, m.sender_jid,
        m.ts, m.from_me, c.kind AS chat_kind
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
        m.rowid,
        m.chat_jid,
        m.msg_id,
        m.sender_jid,
        m.ts,
        m.from_me,
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

export function projectWhatsAppInteractionsFromBoundCwd(
  requestValue: unknown,
): WhatsAppInteractionProjectionSuccess {
  const request = parseWhatsAppInteractionProjectionRequest(requestValue);
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
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) return fail("message-store-file-invalid");
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let descriptor: number;
  try {
    descriptor = openSync(MESSAGE_DATABASE_NAME, constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    return fail("message-store-file-invalid");
  }
  let initialFile: BigIntStats | undefined;
  let database: Database | undefined;
  let result: WhatsAppInteractionProjectionSuccess | undefined;
  let failure: unknown;
  try {
    initialFile = fstatSync(descriptor, { bigint: true });
    assertMessageFile(initialFile, request);
    exactMessagePathSnapshot(initialFile, request);
    database = new Database(MESSAGE_DATABASE_NAME, {
      readonly: true,
      strict: true,
      safeIntegers: true,
    });
    configureDatabase(database);
    assertIntegrity(database);
    assertPinnedSchema(database);
    assertCursorAnchor(database, request);
    result = projectInteractions(database, request);
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

async function readBoundedStdin(): Promise<unknown> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > WHATSAPP_INTERACTION_PROJECTION_MAX_STDIN_BYTES) {
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
  WhatsAppInteractionProjectionResponse
> {
  let request: unknown;
  try {
    if (process.argv.length !== 2) fail("request-invalid");
    request = parseWhatsAppInteractionProjectionRequest(await readBoundedStdin());
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
  if (Buffer.byteLength(output, "utf8") > WHATSAPP_INTERACTION_PROJECTION_MAX_STDOUT_BYTES) {
    response = createWhatsAppInteractionProjectionFailure("output-too-large");
    output = `${JSON.stringify(response)}\n`;
  }
  await Bun.write(Bun.stdout, output);
}

if (import.meta.main) await main();
