import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";

import { Database } from "bun:sqlite";

import {
  WHATSAPP_CONTACT_PROJECTION_MAX_STDIN_BYTES,
  WHATSAPP_CONTACT_PROJECTION_MAX_STDOUT_BYTES,
  WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
  createWhatsAppContactProjectionFailure,
  isExactWhatsAppContactProjectionMode,
  parseWhatsAppContactProjectionJid,
  parseWhatsAppContactProjectionRequest,
  parseWhatsAppContactProjectionSubject,
  type WhatsAppContactDisplayNameBasis,
  type WhatsAppContactProjectionContact,
  type WhatsAppContactProjectionErrorCode,
  type WhatsAppContactProjectionRequest,
  type WhatsAppContactProjectionResponse,
  type WhatsAppContactProjectionSuccess,
} from "./whatsapp-contact-projection-protocol";

const SESSION_DATABASE_NAME = "session.db";
const MAX_SESSION_DATABASE_BYTES = 128 * 1024 * 1024;
const MAX_DEVICE_ROWS = 1_024;
const SQLITE_CACHE_KIB = 2_048;

class HelperFailure extends Error {
  readonly code: WhatsAppContactProjectionErrorCode;

  constructor(code: WhatsAppContactProjectionErrorCode) {
    super("WhatsApp contact projection helper failed");
    this.name = "WhatsAppContactProjectionHelperFailure";
    this.code = code;
  }
}

function fail(code: WhatsAppContactProjectionErrorCode): never {
  throw new HelperFailure(code);
}

function errorCode(error: unknown): WhatsAppContactProjectionErrorCode {
  return error instanceof HelperFailure ? error.code : "database-invalid";
}

function isNoEntry(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
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
  identity: WhatsAppContactProjectionRequest["storeIdentity"],
): boolean {
  return stats.dev.toString() === identity.dev
    && stats.ino.toString() === identity.ino;
}

function assertBoundCwd(
  request: WhatsAppContactProjectionRequest,
  initial?: BigIntStats,
): BigIntStats {
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

function assertNoSidecars(): void {
  for (const suffix of ["-journal", "-wal", "-shm"] as const) {
    try {
      lstatSync(`${SESSION_DATABASE_NAME}${suffix}`);
    } catch (error) {
      if (isNoEntry(error)) continue;
      return fail("session-sidecar-state-unverified");
    }
    fail("session-sidecar-present");
  }
}

function assertSessionFile(
  stats: BigIntStats,
  request: WhatsAppContactProjectionRequest,
): void {
  const uid = currentUid();
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1n
    || (uid !== null && stats.uid !== uid)
    || !isExactWhatsAppContactProjectionMode(stats.mode, 0o600)
    || !matchesIdentity(stats, request.sessionIdentity)
  ) fail("session-file-invalid");
  if (stats.size < 1n || stats.size > BigInt(MAX_SESSION_DATABASE_BYTES)) {
    fail("session-file-too-large");
  }
}

function exactSessionPathSnapshot(
  initial: BigIntStats,
  request: WhatsAppContactProjectionRequest,
): void {
  let pathStats: BigIntStats;
  try {
    pathStats = lstatSync(SESSION_DATABASE_NAME, { bigint: true });
  } catch {
    return fail("session-file-invalid");
  }
  assertSessionFile(pathStats, request);
  if (!sameSnapshot(initial, pathStats)) fail("session-file-invalid");
}

function readExactSessionDatabase(
  descriptor: number,
  stats: BigIntStats,
): Buffer {
  const length = Number(stats.size);
  if (!Number.isSafeInteger(length) || length < 1) {
    return fail("session-file-too-large");
  }
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead < 1) fail("session-read-failed");
      offset += bytesRead;
    }
  } catch (error) {
    buffer.fill(0);
    if (error instanceof HelperFailure) throw error;
    return fail("session-read-failed");
  }
  return buffer;
}

type SqliteRow = Readonly<Record<string, unknown>>;

function rows(
  value: Iterable<unknown>,
  maximum: number,
  failureCode: WhatsAppContactProjectionErrorCode = "schema-mismatch",
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
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) fail("schema-mismatch");
}

function pragmaInteger(value: unknown, expected: bigint): boolean {
  return value === expected || value === Number(expected);
}

function singlePragmaInteger(database: Database, sql: string): bigint {
  const result = rows(
    database.query(sql).iterate(),
    1,
    "database-invalid",
  );
  if (result.length !== 1) fail("database-invalid");
  const values = Object.values(result[0]!);
  if (values.length !== 1) fail("database-invalid");
  const value = values[0];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
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
    const checks = [
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
    ] as const;
    for (const [sql, expected] of checks) {
      if (singlePragmaInteger(database, sql) !== expected) {
        fail("database-invalid");
      }
    }
    const mmap = rows(
      database.query("PRAGMA mmap_size").iterate(),
      1,
      "database-invalid",
    );
    if (
      mmap.length === 1
      && !pragmaInteger(Object.values(mmap[0]!)[0], 0n)
    ) fail("database-invalid");
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    fail("database-invalid");
  }
}

function assertIntegrity(database: Database): void {
  try {
    const integrityCheck = rows(
      database.query("PRAGMA integrity_check(1)").iterate(),
      1,
      "database-integrity-failed",
    );
    if (
      integrityCheck.length !== 1
      || Object.values(integrityCheck[0]!).length !== 1
      || Object.values(integrityCheck[0]!)[0] !== "ok"
    ) fail("database-integrity-failed");
    if (rows(
      database.query("PRAGMA foreign_key_check").iterate(),
      1,
      "database-integrity-failed",
    ).length !== 0) {
      fail("database-integrity-failed");
    }
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    fail("database-integrity-failed");
  }
}

const CONTACT_COLUMNS = Object.freeze([
  { cid: 0n, name: "our_jid", type: "TEXT", notnull: 0n, dflt_value: null, pk: 1n, hidden: 0n },
  { cid: 1n, name: "their_jid", type: "TEXT", notnull: 0n, dflt_value: null, pk: 2n, hidden: 0n },
  { cid: 2n, name: "first_name", type: "TEXT", notnull: 0n, dflt_value: null, pk: 0n, hidden: 0n },
  { cid: 3n, name: "full_name", type: "TEXT", notnull: 0n, dflt_value: null, pk: 0n, hidden: 0n },
  { cid: 4n, name: "push_name", type: "TEXT", notnull: 0n, dflt_value: null, pk: 0n, hidden: 0n },
  { cid: 5n, name: "business_name", type: "TEXT", notnull: 0n, dflt_value: null, pk: 0n, hidden: 0n },
  { cid: 6n, name: "redacted_phone", type: "TEXT", notnull: 0n, dflt_value: null, pk: 0n, hidden: 0n },
] as const);

function assertTableList(database: Database): void {
  const tableList = rows(database.query(`
    SELECT schema, name, type, ncol, wr, strict
    FROM pragma_table_list
    WHERE schema = 'main'
      AND name IN ('whatsmeow_contacts', 'whatsmeow_device')
    LIMIT 3
  `).iterate(), 3);
  for (const [name, ncol] of [["whatsmeow_contacts", 7n]] as const) {
    const matches = tableList.filter((row) => row.schema === "main" && row.name === name);
    if (matches.length !== 1) fail("schema-mismatch");
    const row = matches[0]!;
    exactRowKeys(row, ["schema", "name", "type", "ncol", "wr", "strict"]);
    if (
      row.type !== "table"
      || !pragmaInteger(row.ncol, ncol)
      || !pragmaInteger(row.wr, 0n)
      || !pragmaInteger(row.strict, 0n)
    ) fail("schema-mismatch");
  }
  const devices = tableList.filter(
    (row) => row.schema === "main" && row.name === "whatsmeow_device",
  );
  if (devices.length !== 1) fail("schema-mismatch");
  const device = devices[0]!;
  exactRowKeys(device, ["schema", "name", "type", "ncol", "wr", "strict"]);
  if (
    device.type !== "table"
    || (typeof device.ncol !== "bigint" && typeof device.ncol !== "number")
    || BigInt(device.ncol) < 2n
    || !pragmaInteger(device.wr, 0n)
    || !pragmaInteger(device.strict, 0n)
  ) fail("schema-mismatch");
}

function assertContactColumns(database: Database): void {
  const actual = rows(
    database.query("PRAGMA table_xinfo('whatsmeow_contacts')").iterate(),
    CONTACT_COLUMNS.length,
  );
  if (actual.length !== CONTACT_COLUMNS.length) fail("schema-mismatch");
  for (const [index, expected] of CONTACT_COLUMNS.entries()) {
    const row = actual[index]!;
    exactRowKeys(row, ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"]);
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === "bigint") {
        if (!pragmaInteger(row[key], value)) fail("schema-mismatch");
      } else if (row[key] !== value) fail("schema-mismatch");
    }
  }
}

function assertDeviceIdentityColumns(database: Database): void {
  const actual = rows(
    database.query("PRAGMA table_xinfo('whatsmeow_device')").iterate(),
    256,
  );
  const jidRows = actual.filter((row) => row.name === "jid");
  const lidRows = actual.filter((row) => row.name === "lid");
  if (jidRows.length !== 1 || lidRows.length !== 1) fail("schema-mismatch");
  for (const row of [jidRows[0]!, lidRows[0]!]) {
    exactRowKeys(row, ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"]);
    if (
      row.type !== "TEXT"
      || row.dflt_value !== null
      || !pragmaInteger(row.notnull, 0n)
      || !pragmaInteger(row.hidden, 0n)
    ) fail("schema-mismatch");
  }
  if (
    !pragmaInteger(jidRows[0]!.pk, 1n)
    || !pragmaInteger(lidRows[0]!.pk, 0n)
  ) fail("schema-mismatch");
}

function assertPrimaryKeyIndex(
  database: Database,
  table: "whatsmeow_contacts" | "whatsmeow_device",
  expectedColumns: readonly string[],
  requireOnlyIndex: boolean,
): void {
  const expectedIndexName = table === "whatsmeow_contacts"
    ? "sqlite_autoindex_whatsmeow_contacts_1"
    : "sqlite_autoindex_whatsmeow_device_1";
  const indexList = rows(
    database.query(`PRAGMA index_list('${table}')`).iterate(),
    256,
  );
  if (requireOnlyIndex && indexList.length !== 1) fail("schema-mismatch");
  const primary = indexList.filter((row) => row.origin === "pk");
  if (primary.length !== 1) fail("schema-mismatch");
  const index = primary[0]!;
  exactRowKeys(index, ["seq", "name", "unique", "origin", "partial"]);
  if (
    index.name !== expectedIndexName
    || !pragmaInteger(index.unique, 1n)
    || !pragmaInteger(index.partial, 0n)
  ) fail("schema-mismatch");
  const indexInfo = rows(table === "whatsmeow_contacts"
    ? database.query(
        "PRAGMA index_xinfo('sqlite_autoindex_whatsmeow_contacts_1')",
      ).iterate()
    : database.query(
        "PRAGMA index_xinfo('sqlite_autoindex_whatsmeow_device_1')",
      ).iterate(), expectedColumns.length + 1);
  if (indexInfo.length !== expectedColumns.length + 1) fail("schema-mismatch");
  for (const [position, column] of expectedColumns.entries()) {
    const row = indexInfo[position]!;
    exactRowKeys(row, ["seqno", "cid", "name", "desc", "coll", "key"]);
    if (
      !pragmaInteger(row.seqno, BigInt(position))
      || row.name !== column
      || !pragmaInteger(row.desc, 0n)
      || row.coll !== "BINARY"
      || !pragmaInteger(row.key, 1n)
    ) fail("schema-mismatch");
  }
  const trailing = indexInfo.at(-1)!;
  exactRowKeys(trailing, ["seqno", "cid", "name", "desc", "coll", "key"]);
  if (
    !pragmaInteger(trailing.seqno, BigInt(expectedColumns.length))
    || !pragmaInteger(trailing.cid, -1n)
    || trailing.name !== null
    || !pragmaInteger(trailing.desc, 0n)
    || trailing.coll !== "BINARY"
    || !pragmaInteger(trailing.key, 0n)
  ) fail("schema-mismatch");
}

function assertContactForeignKey(database: Database): void {
  const foreignKeys = rows(
    database.query("PRAGMA foreign_key_list('whatsmeow_contacts')").iterate(),
    2,
  );
  if (foreignKeys.length !== 1) fail("schema-mismatch");
  const row = foreignKeys[0]!;
  exactRowKeys(row, [
    "id",
    "seq",
    "table",
    "from",
    "to",
    "on_update",
    "on_delete",
    "match",
  ]);
  if (
    !pragmaInteger(row.id, 0n)
    || !pragmaInteger(row.seq, 0n)
    || row.table !== "whatsmeow_device"
    || row.from !== "our_jid"
    || row.to !== "jid"
    || row.on_update !== "CASCADE"
    || row.on_delete !== "CASCADE"
    || row.match !== "NONE"
  ) fail("schema-mismatch");
}

function assertPinnedSchema(database: Database): void {
  try {
    assertTableList(database);
    assertContactColumns(database);
    assertDeviceIdentityColumns(database);
    assertPrimaryKeyIndex(
      database,
      "whatsmeow_contacts",
      ["our_jid", "their_jid"],
      true,
    );
    assertPrimaryKeyIndex(database, "whatsmeow_device", ["jid"], false);
    assertContactForeignKey(database);
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    fail("schema-mismatch");
  }
}

const DEVICE_PN_JID_PATTERN = /^([0-9]{5,20})(?::[0-9]{1,5})?@s\.whatsapp\.net$/u;
const DEVICE_LID_JID_PATTERN = /^([0-9]{5,32})(?::[0-9]{1,5})?@lid$/u;
const LID_VALUE_PATTERN = /^([0-9]{5,32})(?::[0-9]{1,5})?@lid$/u;
const LID_DIGITS_PATTERN = /^[0-9]{5,32}$/u;

function normalizedDeviceJid(value: unknown): Readonly<{
  id: string;
  kind: "pn" | "lid";
}> {
  if (typeof value !== "string" || value.length > 96) fail("owner-mismatch");
  const phone = DEVICE_PN_JID_PATTERN.exec(value);
  const lid = DEVICE_LID_JID_PATTERN.exec(value);
  const id = phone?.[1] ?? lid?.[1];
  if (id === undefined) {
    return fail("owner-mismatch");
  }
  return Object.freeze({
    id,
    kind: phone === null ? "lid" : "pn",
  });
}

function normalizedLid(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 96) fail("owner-mismatch");
  if (LID_DIGITS_PATTERN.test(value)) return value;
  const match = LID_VALUE_PATTERN.exec(value);
  if (match === null || match[1] === undefined) fail("owner-mismatch");
  return match[1];
}

function matchedOwnerJid(
  database: Database,
  accountSubject: string,
): string {
  const subject = parseWhatsAppContactProjectionSubject(accountSubject);
  let deviceRows: readonly SqliteRow[];
  try {
    deviceRows = rows(database.query(`
      SELECT jid, lid
      FROM whatsmeow_device
      ORDER BY jid COLLATE BINARY ASC
      LIMIT ${MAX_DEVICE_ROWS + 1}
    `).iterate(), MAX_DEVICE_ROWS + 1);
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("owner-mismatch");
  }
  if (deviceRows.length > MAX_DEVICE_ROWS) fail("owner-mismatch");
  const matches: string[] = [];
  for (const row of deviceRows) {
    exactRowKeys(row, ["jid", "lid"]);
    if (typeof row.jid !== "string") fail("owner-mismatch");
    const jid = normalizedDeviceJid(row.jid);
    const lid = normalizedLid(row.lid);
    if (
      (subject.kind === "pn" && jid.kind === "pn" && jid.id === subject.id)
      || (subject.kind === "lid" && (
        (jid.kind === "lid" && jid.id === subject.id)
        || lid === subject.id
      ))
    ) matches.push(row.jid);
  }
  if (matches.length !== 1) fail("owner-mismatch");
  return matches[0]!;
}

function optionalContactText(
  value: unknown,
  maximum: number,
): string | null {
  if (value === null || value === "") return null;
  if (
    typeof value !== "string"
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) return fail("projection-invalid");
  return value;
}

function projectContact(row: SqliteRow): WhatsAppContactProjectionContact {
  exactRowKeys(row, [
    "their_jid",
    "first_name",
    "full_name",
    "push_name",
    "business_name",
    "redacted_phone",
  ]);
  let jid: ReturnType<typeof parseWhatsAppContactProjectionJid>;
  try {
    jid = parseWhatsAppContactProjectionJid(row.their_jid);
  } catch {
    return fail("projection-invalid");
  }
  const firstName = optionalContactText(row.first_name, 512);
  const fullName = optionalContactText(row.full_name, 512);
  const pushName = optionalContactText(row.push_name, 512);
  const businessName = optionalContactText(row.business_name, 512);
  const redactedPhone = optionalContactText(row.redacted_phone, 64);
  const phone = jid.kind === "user" ? jid.id : null;
  const candidates = [
    [fullName, "full-name"],
    [pushName, "push-name"],
    [businessName, "business-name"],
    [firstName, "first-name"],
    [redactedPhone, "redacted-phone"],
    [phone, "phone"],
  ] as const satisfies readonly (readonly [string | null, WhatsAppContactDisplayNameBasis])[];
  const selected = candidates.find(([value]) => value !== null);
  return Object.freeze({
    providerId: jid.jid,
    jidKind: jid.kind,
    phone,
    redactedPhone,
    firstName,
    fullName,
    pushName,
    businessName,
    displayName: selected?.[0] ?? null,
    displayNameBasis: selected?.[1] ?? "unavailable",
  });
}

function projectContacts(
  database: Database,
  request: WhatsAppContactProjectionRequest,
): WhatsAppContactProjectionSuccess {
  const ownerJid = matchedOwnerJid(database, request.accountSubject);
  let projectedRows: readonly SqliteRow[];
  try {
    projectedRows = rows(database.query(`
      SELECT
        their_jid,
        first_name,
        full_name,
        push_name,
        business_name,
        redacted_phone
      FROM whatsmeow_contacts
      WHERE our_jid = ?1 COLLATE BINARY
        AND (?2 IS NULL OR their_jid > ?2 COLLATE BINARY)
        AND (
          their_jid GLOB '[0-9]*@s.whatsapp.net'
          OR their_jid GLOB '[0-9]*@lid'
        )
      ORDER BY their_jid COLLATE BINARY ASC
      LIMIT ?3
    `).iterate(ownerJid, request.cursor, request.limit + 1), request.limit + 1);
  } catch (error) {
    if (error instanceof HelperFailure) throw error;
    return fail("projection-invalid");
  }
  const projectedContacts = projectedRows.map(projectContact);
  for (let index = 0; index < projectedContacts.length; index += 1) {
    const previous = index === 0
      ? request.cursor
      : projectedContacts[index - 1]?.providerId;
    if (
      previous !== null
      && previous !== undefined
      && projectedContacts[index]!.providerId <= previous
    ) {
      fail("projection-invalid");
    }
  }
  const hasMore = projectedContacts.length > request.limit;
  const contacts = Object.freeze(projectedContacts.slice(0, request.limit));
  return Object.freeze({
    schemaVersion: WHATSAPP_CONTACT_PROJECTION_PROTOCOL_VERSION,
    status: "succeeded",
    contacts,
    nextCursor: hasMore ? contacts.at(-1)?.providerId ?? null : null,
    localContactTablePageComplete: !hasMore,
  });
}

function projectDatabaseBuffer(
  buffer: Buffer,
  request: WhatsAppContactProjectionRequest,
): WhatsAppContactProjectionSuccess {
  let database: Database;
  try {
    database = Database.deserialize(buffer, {
      readonly: true,
      strict: true,
      safeIntegers: true,
    });
  } catch {
    return fail("database-invalid");
  }
  try {
    configureDatabase(database);
    assertIntegrity(database);
    assertPinnedSchema(database);
    return projectContacts(database, request);
  } finally {
    try {
      database.close();
    } catch {
      fail("database-invalid");
    }
  }
}

export function projectWhatsAppContactsFromBoundCwd(
  requestValue: unknown,
): WhatsAppContactProjectionSuccess {
  const request = parseWhatsAppContactProjectionRequest(requestValue);
  const initialCwd = assertBoundCwd(request);
  assertNoSidecars();
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    return fail("session-file-invalid");
  }
  const nonBlock = typeof constants.O_NONBLOCK === "number"
    ? constants.O_NONBLOCK
    : 0;
  let descriptor: number;
  try {
    descriptor = openSync(
      SESSION_DATABASE_NAME,
      constants.O_RDONLY | noFollow | nonBlock,
    );
  } catch {
    return fail("session-file-invalid");
  }

  let initialFile: BigIntStats | undefined;
  let buffer: Buffer | undefined;
  let result: WhatsAppContactProjectionSuccess | undefined;
  let failure: unknown;
  try {
    initialFile = fstatSync(descriptor, { bigint: true });
    assertSessionFile(initialFile, request);
    exactSessionPathSnapshot(initialFile, request);
    buffer = readExactSessionDatabase(descriptor, initialFile);
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(initialFile, afterRead)) fail("session-file-invalid");
    exactSessionPathSnapshot(initialFile, request);
    assertBoundCwd(request, initialCwd);
    result = projectDatabaseBuffer(buffer, request);
  } catch (error) {
    failure = error;
  }

  try {
    if (initialFile !== undefined) {
      const afterProjection = fstatSync(descriptor, { bigint: true });
      if (!sameSnapshot(initialFile, afterProjection)) fail("session-file-invalid");
      exactSessionPathSnapshot(initialFile, request);
    }
    assertBoundCwd(request, initialCwd);
  } catch (error) {
    failure = error;
  } finally {
    buffer?.fill(0);
    try {
      closeSync(descriptor);
    } catch {
      failure = new HelperFailure("session-read-failed");
    }
  }

  try {
    if (initialFile !== undefined) exactSessionPathSnapshot(initialFile, request);
    assertBoundCwd(request, initialCwd);
    assertNoSidecars();
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    throw failure instanceof Error
      ? failure
      : new HelperFailure("database-invalid");
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
      if (length > WHATSAPP_CONTACT_PROJECTION_MAX_STDIN_BYTES) {
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
  let text: string;
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    bytes.fill(0);
  } catch {
    return fail("request-invalid");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail("request-invalid");
  }
}

export async function runWhatsAppContactProjectionHelper(): Promise<
  WhatsAppContactProjectionResponse
> {
  let request: unknown;
  try {
    if (process.argv.length !== 2) fail("request-invalid");
    request = await readBoundedStdin();
    request = parseWhatsAppContactProjectionRequest(request);
  } catch {
    return createWhatsAppContactProjectionFailure("request-invalid");
  }
  try {
    return projectWhatsAppContactsFromBoundCwd(request);
  } catch (error) {
    return createWhatsAppContactProjectionFailure(errorCode(error));
  }
}

async function main(): Promise<void> {
  let response = await runWhatsAppContactProjectionHelper();
  let output = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(output, "utf8") > WHATSAPP_CONTACT_PROJECTION_MAX_STDOUT_BYTES) {
    response = createWhatsAppContactProjectionFailure("output-too-large");
    output = `${JSON.stringify(response)}\n`;
  }
  await Bun.write(Bun.stdout, output);
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.exitCode = 1;
  }
}
