import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  type BigIntStats,
  type Dirent,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";

import { Database } from "bun:sqlite";

import {
  APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS,
  createApplePhotosContactEvidenceExportResult,
} from "./apple-photos-contact-evidence";
import type {
  ApplePhotosContactEvidence,
  ApplePhotosContactEvidenceExportResult,
} from "./apple-photos-client-types";
import { canonicalJson, sha256 } from "./canonical-json";

const PHOTOS_DATABASE_RELATIVE_PATH = join("database", "Photos.sqlite");
const CONTACTS_RELATIVE_ROOT = join(
  "Library",
  "Application Support",
  "AddressBook",
);
const SQLITE_HEADER_BYTES = 512;
const MAX_WAL_BYTES = 1024 * 1024 * 1024;
const MAX_SHM_BYTES = 64 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const CONTACT_DATABASE_PATTERN = /^AddressBook-v([1-9][0-9]*)\.abcddb$/u;
const CONTACT_SOURCE_DIRECTORY_PATTERN =
  /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/u;

const PHOTOS_SCHEMA_CONTRACT = Object.freeze({
  ZPERSON: Object.freeze({
    Z_PK: Object.freeze({ type: "INTEGER", notnull: 0, defaultValue: null, pk: 1, hidden: 0 }),
    ZPERSONUUID: Object.freeze({ type: "VARCHAR", notnull: 0, defaultValue: null, pk: 0, hidden: 0 }),
    ZPERSONURI: Object.freeze({ type: "VARCHAR", notnull: 0, defaultValue: null, pk: 0, hidden: 0 }),
  }),
  ZDETECTEDFACE: Object.freeze({
    Z_PK: Object.freeze({ type: "INTEGER", notnull: 0, defaultValue: null, pk: 1, hidden: 0 }),
    ZPERSONFORFACE: Object.freeze({ type: "INTEGER", notnull: 0, defaultValue: null, pk: 0, hidden: 0 }),
    ZASSETFORFACE: Object.freeze({ type: "INTEGER", notnull: 0, defaultValue: null, pk: 0, hidden: 0 }),
  }),
  ZASSET: Object.freeze({
    Z_PK: Object.freeze({ type: "INTEGER", notnull: 0, defaultValue: null, pk: 1, hidden: 0 }),
    ZDATECREATED: Object.freeze({ type: "TIMESTAMP", notnull: 0, defaultValue: null, pk: 0, hidden: 0 }),
  }),
});

const CONTACTS_SCHEMA_CONTRACT = Object.freeze({
  ZABCDRECORD: Object.freeze({
    Z_PK: Object.freeze({ type: "INTEGER", notnull: 0, defaultValue: null, pk: 1, hidden: 0 }),
    ZUNIQUEID: Object.freeze({ type: "VARCHAR", notnull: 0, defaultValue: null, pk: 0, hidden: 0 }),
  }),
});

export const APPLE_PHOTOS_SCHEMA_SHA256 = sha256(
  canonicalJson(PHOTOS_SCHEMA_CONTRACT),
);
export const APPLE_CONTACTS_SCHEMA_SHA256 = sha256(
  canonicalJson(CONTACTS_SCHEMA_CONTRACT),
);

type SnapshotRole = "photos" | "contacts";

export type ApplePhotosLocalSourceDependencies = Readonly<{
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  temporaryDirectory?: string;
  now?: () => Date;
  runId?: () => string;
  afterSnapshotFilesCopied?: (
    role: SnapshotRole,
    attempt: number,
  ) => void | Promise<void>;
}>;

export type ApplePhotosLocalSourceRequest = Readonly<{
  library?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  dependencies?: ApplePhotosLocalSourceDependencies;
}>;

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type SourceFile = Readonly<{
  path: string;
  suffix: "" | "-wal" | "-shm";
  identity: FileIdentity;
}>;

type SnapshotDatabase = Readonly<{
  mainPath: string;
  files: readonly Readonly<{
    suffix: SourceFile["suffix"];
    snapshotPath: string;
  }>[];
}>;

type TableColumnContract = Readonly<Record<string, Readonly<{
  type: string;
  notnull: number;
  defaultValue: null;
  pk: number;
  hidden: number;
}>>>;

type SchemaContract = Readonly<Record<string, TableColumnContract>>;

class SnapshotDriftError extends Error {}

function fail(message: string): never {
  throw new Error(`Apple Photos local source: ${message}`);
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) return fail("operation was cancelled");
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (
    !isAbsolute(value)
    || resolve(value) !== value
    || Buffer.byteLength(value, "utf8") > 4_096
    || /[\0\r\n]/u.test(value)
  ) return fail(`${label} must be one normalized absolute path`);
  return value;
}

async function exactRealDirectory(
  path: string,
  label: string,
  uid: bigint,
): Promise<void> {
  let metadata: BigIntStats;
  let resolved: string;
  try {
    [metadata, resolved] = await Promise.all([
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
  } catch {
    return fail(`${label} is unavailable`);
  }
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || resolved !== path
  ) return fail(`${label} must be an owned real directory without symlink components`);
}

function identity(metadata: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fileMaximum(
  suffix: SourceFile["suffix"],
  mainMaximum: number,
): number {
  if (suffix === "") return mainMaximum;
  return suffix === "-wal" ? MAX_WAL_BYTES : MAX_SHM_BYTES;
}

async function optionalOwnedSourceFile(
  path: string,
  suffix: SourceFile["suffix"],
  uid: bigint,
  mainMaximum: number,
): Promise<SourceFile | null> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return null;
    return fail("a source database file could not be inspected");
  }
  const maximum = BigInt(fileMaximum(suffix, mainMaximum));
  const minimum = suffix === "" ? BigInt(SQLITE_HEADER_BYTES) : 1n;
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.nlink !== 1n
    || metadata.size < minimum
    || metadata.size > maximum
  ) return fail("a source database file failed type, owner, hardlink, or size validation");
  return Object.freeze({ path, suffix, identity: identity(metadata) });
}

async function inspectSourceSet(
  mainPath: string,
  uid: bigint,
  mainMaximum: number,
): Promise<readonly SourceFile[]> {
  const [main, wal, shm] = await Promise.all([
    optionalOwnedSourceFile(mainPath, "", uid, mainMaximum),
    optionalOwnedSourceFile(`${mainPath}-wal`, "-wal", uid, mainMaximum),
    optionalOwnedSourceFile(`${mainPath}-shm`, "-shm", uid, mainMaximum),
  ]);
  if (main === null) return fail("the source database is unavailable");
  if ((wal === null) !== (shm === null)) {
    return fail("the source SQLite WAL and shared-memory sidecars are incomplete");
  }
  return Object.freeze([
    main,
    ...(wal === null || shm === null ? [] : [wal, shm]),
  ]);
}

async function sourcePathStillMatches(file: SourceFile): Promise<boolean> {
  try {
    const current = await lstat(file.path, { bigint: true });
    return sameIdentity(file.identity, identity(current));
  } catch {
    return false;
  }
}

async function absentSidecarsStayedAbsent(mainPath: string): Promise<boolean> {
  for (const suffix of ["-wal", "-shm"] as const) {
    try {
      await lstat(`${mainPath}${suffix}`, { bigint: true });
      return false;
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "ENOENT"
      ) return false;
    }
  }
  return true;
}

async function copyExactFile(
  source: FileHandle,
  destinationPath: string,
  expectedSize: bigint,
  signal: AbortSignal | undefined,
): Promise<void> {
  const destination = await open(
    destinationPath,
    fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_WRONLY
      | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  const exactSize = Number(expectedSize);
  try {
    while (position < exactSize) {
      abortIfRequested(signal);
      const remaining = exactSize - position;
      const length = Math.min(remaining, buffer.byteLength);
      const read = await source.read(buffer, 0, length, position);
      if (read.bytesRead !== length) {
        throw new SnapshotDriftError(
          "source database changed or ended during snapshot copy",
        );
      }
      let written = 0;
      while (written < read.bytesRead) {
        const next = await destination.write(
          buffer,
          written,
          read.bytesRead - written,
          position + written,
        );
        if (next.bytesWritten < 1) return fail("a private snapshot write made no progress");
        written += next.bytesWritten;
      }
      position += read.bytesRead;
    }
    await destination.sync();
    await destination.chmod(0o600);
  } finally {
    await destination.close();
  }
}

async function snapshotSqliteDatabase(
  sourceMainPath: string,
  snapshotRoot: string,
  snapshotStem: string,
  mainMaximum: number,
  uid: bigint,
  role: SnapshotRole,
  signal: AbortSignal | undefined,
  afterCopied: ApplePhotosLocalSourceDependencies["afterSnapshotFilesCopied"],
): Promise<SnapshotDatabase> {
  const destinations = ["", "-wal", "-shm"].map((suffix) =>
    join(snapshotRoot, `${snapshotStem}${suffix}`));
  for (
    let attempt = 1;
    attempt <= APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.snapshotAttempts;
    attempt += 1
  ) {
    abortIfRequested(signal);
    await Promise.all(destinations.map((path) => rm(path, { force: true })));
    const sources = await inspectSourceSet(sourceMainPath, uid, mainMaximum);
    const handles: FileHandle[] = [];
    let stable = false;
    try {
      for (const source of sources) {
        const handle = await open(
          source.path,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        handles.push(handle);
        const opened = identity(await handle.stat({ bigint: true }));
        if (!sameIdentity(opened, source.identity)) {
          stable = false;
          break;
        }
      }
      if (handles.length !== sources.length) continue;
      for (const [index, source] of sources.entries()) {
        const destination = join(snapshotRoot, `${snapshotStem}${source.suffix}`);
        await copyExactFile(
          handles[index]!,
          destination,
          source.identity.size,
          signal,
        );
      }
      await afterCopied?.(role, attempt);
      const descriptorStable = (
        await Promise.all(handles.map(async (handle, index) =>
          sameIdentity(
            identity(await handle.stat({ bigint: true })),
            sources[index]!.identity,
          )))
      ).every(Boolean);
      const pathsStable = (
        await Promise.all(sources.map(sourcePathStillMatches))
      ).every(Boolean);
      const sidecarsStable = sources.length === 1
        ? await absentSidecarsStayedAbsent(sourceMainPath)
        : true;
      stable = descriptorStable && pathsStable && sidecarsStable;
      if (stable) {
        return Object.freeze({
          mainPath: join(snapshotRoot, snapshotStem),
          files: Object.freeze(sources.map((source) => Object.freeze({
            suffix: source.suffix,
            snapshotPath: join(snapshotRoot, `${snapshotStem}${source.suffix}`),
          }))),
        });
      }
    } catch (error) {
      if (!(error instanceof SnapshotDriftError)) throw error;
    } finally {
      await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
      if (!stable) {
        await Promise.all(destinations.map((path) => rm(path, { force: true })));
      }
    }
  }
  return fail("source database did not remain stable across a bounded snapshot attempt");
}

async function latestContactDatabaseInDirectory(
  directory: string,
  uid: bigint,
): Promise<string | null> {
  await exactRealDirectory(directory, "an Apple Contacts store directory", uid);
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries.flatMap((entry): readonly Readonly<{
    path: string;
    version: number;
  }>[] => {
    const match = CONTACT_DATABASE_PATTERN.exec(entry.name);
    if (match === null) return [];
    if (!entry.isFile()) return fail("an Apple Contacts database candidate is not a regular directory entry");
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) return fail("an Apple Contacts database version is malformed");
    return [Object.freeze({ path: join(directory, entry.name), version })];
  });
  candidates.sort((left, right) => right.version - left.version);
  return candidates[0]?.path ?? null;
}

async function discoverContactDatabases(
  home: string,
  uid: bigint,
): Promise<readonly string[]> {
  const root = join(home, CONTACTS_RELATIVE_ROOT);
  await exactRealDirectory(root, "the Apple Contacts data root", uid);
  const candidates: string[] = [];
  const primary = await latestContactDatabaseInDirectory(root, uid);
  if (primary !== null) candidates.push(primary);
  const sourcesRoot = join(root, "Sources");
  let sourceEntries: Dirent<string>[] = [];
  try {
    await exactRealDirectory(sourcesRoot, "the Apple Contacts Sources directory", uid);
    sourceEntries = await readdir(sourcesRoot, { withFileTypes: true });
  } catch (error) {
    if (
      !(error instanceof Error)
      || error.message !== "Apple Photos local source: the Apple Contacts Sources directory is unavailable"
    ) throw error;
  }
  for (const entry of sourceEntries) {
    if (!CONTACT_SOURCE_DIRECTORY_PATTERN.test(entry.name)) continue;
    if (!entry.isDirectory()) {
      return fail("an Apple Contacts source identifier is not a directory");
    }
    const candidate = await latestContactDatabaseInDirectory(
      join(sourcesRoot, entry.name),
      uid,
    );
    if (candidate !== null) candidates.push(candidate);
  }
  candidates.sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  if (candidates.length < 1) return fail("no Apple Contacts database is available");
  if (candidates.length > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases) {
    return fail("the Apple Contacts database count exceeds the reviewed bound");
  }
  const identities = new Set<string>();
  for (const candidate of candidates) {
    const metadata = await lstat(candidate, { bigint: true });
    const key = `${metadata.dev.toString()}:${metadata.ino.toString()}`;
    if (identities.has(key)) return fail("one Apple Contacts database is reachable through multiple hardlinks");
    identities.add(key);
  }
  return Object.freeze(candidates);
}

function databaseRow(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} is not a SQLite row`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function integerField(value: unknown, label: string, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) return fail(`${label} is outside its reviewed integer bound`);
  return value;
}

function validateSchema(
  database: Database,
  contract: SchemaContract,
  expectedSha256: string,
  label: string,
): void {
  const quickCheck = database.query("PRAGMA quick_check(1)").get() as unknown;
  const quickCheckRow = databaseRow(quickCheck, `${label} quick check`);
  if (Object.values(quickCheckRow).length !== 1 || Object.values(quickCheckRow)[0] !== "ok") {
    return fail(`${label} snapshot failed SQLite quick_check`);
  }
  const observed: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [table, columns] of Object.entries(contract)) {
    const schemaRows = database.query(
      "SELECT type, name FROM sqlite_schema WHERE name = ?1 ORDER BY type, name",
    ).all(table) as unknown[];
    if (
      schemaRows.length !== 1
      || databaseRow(schemaRows[0], `${label} schema object`).type !== "table"
      || databaseRow(schemaRows[0], `${label} schema object`).name !== table
    ) return fail(`${label} required table ${table} drifted`);
    const tableRows = database.query(`PRAGMA table_xinfo('${table}')`).all() as unknown[];
    const byName = new Map<string, Readonly<Record<string, unknown>>>();
    for (const raw of tableRows) {
      const row = databaseRow(raw, `${label} ${table} column`);
      if (typeof row.name !== "string" || byName.has(row.name)) {
        return fail(`${label} table ${table} has malformed columns`);
      }
      byName.set(row.name, row);
    }
    const selected: Record<string, unknown> = Object.create(null);
    for (const [name, expected] of Object.entries(columns)) {
      const row = byName.get(name);
      if (row === undefined) return fail(`${label} table ${table} lost column ${name}`);
      const actual = Object.freeze({
        type: row.type,
        notnull: row.notnull,
        defaultValue: row.dflt_value,
        pk: row.pk,
        hidden: row.hidden,
      });
      if (canonicalJson(actual) !== canonicalJson(expected)) {
        return fail(`${label} table ${table} column ${name} drifted`);
      }
      selected[name] = actual;
    }
    observed[table] = selected;
  }
  if (sha256(canonicalJson(observed)) !== expectedSha256) {
    return fail(`${label} relevant Core Data schema fingerprint drifted`);
  }
}

function configureReadOnlyDatabase(database: Database): void {
  database.exec("PRAGMA query_only = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA foreign_keys = OFF");
}

function providerIdentifier(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximum
  ) return fail(`${label} is malformed`);
  return value;
}

function exportedProviderIdentifier(
  value: unknown,
  label: string,
  maximum: number,
): string {
  const parsed = providerIdentifier(value, label, maximum);
  if (!/^[A-Za-z0-9._:-]+$/u.test(parsed)) {
    return fail(`${label} contains characters outside the reviewed output alphabet`);
  }
  return parsed;
}

function coreDataTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(`${label} is not a finite Core Data timestamp`);
  }
  const unixMilliseconds = (value + 978_307_200) * 1_000;
  if (!Number.isSafeInteger(Math.trunc(unixMilliseconds))) {
    return fail(`${label} exceeds the supported timestamp range`);
  }
  const date = new Date(unixMilliseconds);
  if (!Number.isFinite(date.getTime())) return fail(`${label} is outside the Date range`);
  const rendered = date.toISOString();
  if (!/^\d{4}-/u.test(rendered)) return fail(`${label} is outside years 0000 through 9999`);
  return rendered;
}

function loadContactIds(
  snapshots: readonly SnapshotDatabase[],
): Set<string> {
  const ids = new Set<string>();
  let scanned = 0;
  for (const snapshot of snapshots) {
    const database = new Database(snapshot.mainPath, {
      readonly: true,
      strict: true,
    });
    try {
      configureReadOnlyDatabase(database);
      validateSchema(
        database,
        CONTACTS_SCHEMA_CONTRACT,
        APPLE_CONTACTS_SCHEMA_SHA256,
        "Apple Contacts",
      );
      const remaining = APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContacts
        - scanned;
      const rows = database.query(
        "SELECT ZUNIQUEID AS contactId FROM ZABCDRECORD WHERE ZUNIQUEID IS NOT NULL ORDER BY ZUNIQUEID COLLATE BINARY LIMIT ?1",
      ).all(remaining + 1) as unknown[];
      if (rows.length > remaining) return fail("Apple Contacts rows exceed the reviewed bound");
      scanned += rows.length;
      for (const [index, raw] of rows.entries()) {
        const row = databaseRow(raw, `Apple Contacts row ${String(index)}`);
        ids.add(providerIdentifier(row.contactId, "an Apple Contacts identifier", 4_096));
      }
    } finally {
      database.close(false);
    }
  }
  return ids;
}

function queryPhotosEvidence(
  snapshot: SnapshotDatabase,
  contactIds: ReadonlySet<string>,
): readonly ApplePhotosContactEvidence[] {
  const database = new Database(snapshot.mainPath, {
    readonly: true,
    strict: true,
  });
  try {
    configureReadOnlyDatabase(database);
    validateSchema(
      database,
      PHOTOS_SCHEMA_CONTRACT,
      APPLE_PHOTOS_SCHEMA_SHA256,
      "Apple Photos",
    );
    const rows = database.query(`
      SELECT
        p.ZPERSONUUID AS photosPersonId,
        p.ZPERSONURI AS appleContactId,
        COUNT(DISTINCT f.Z_PK) AS linkedFaceCount,
        COUNT(DISTINCT a.Z_PK) AS linkedAssetCount,
        MIN(a.ZDATECREATED) AS firstAssetAt,
        MAX(a.ZDATECREATED) AS lastAssetAt
      FROM ZPERSON AS p
      LEFT JOIN ZDETECTEDFACE AS f ON f.ZPERSONFORFACE = p.Z_PK
      LEFT JOIN ZASSET AS a ON a.Z_PK = f.ZASSETFORFACE
      WHERE p.ZPERSONUUID IS NOT NULL AND p.ZPERSONURI IS NOT NULL
      GROUP BY p.Z_PK, p.ZPERSONUUID, p.ZPERSONURI
      ORDER BY p.ZPERSONURI COLLATE BINARY, p.ZPERSONUUID COLLATE BINARY
      LIMIT ?1
    `).all(APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPeople + 1) as unknown[];
    if (rows.length > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPeople) {
      return fail("Apple Photos matched-person candidates exceed the reviewed bound");
    }
    const evidence: ApplePhotosContactEvidence[] = [];
    for (const [index, raw] of rows.entries()) {
      const row = databaseRow(raw, `Apple Photos person row ${String(index)}`);
      const contactId = providerIdentifier(
        row.appleContactId,
        "a Photos contact identifier",
        4_096,
      );
      if (!contactIds.has(contactId)) continue;
      const firstAssetAt = coreDataTimestamp(
        row.firstAssetAt,
        "the first linked asset date",
      );
      const lastAssetAt = coreDataTimestamp(
        row.lastAssetAt,
        "the last linked asset date",
      );
      if ((firstAssetAt === null) !== (lastAssetAt === null)) {
        return fail("linked asset date bounds are incomplete");
      }
      evidence.push(Object.freeze({
        photosPersonId: exportedProviderIdentifier(
          row.photosPersonId,
          "a Photos person identifier",
          128,
        ),
        appleContactId: exportedProviderIdentifier(
          contactId,
          "a matched Apple Contacts identifier",
          512,
        ),
        linkedFaceCount: integerField(
          row.linkedFaceCount,
          "a linked face count",
          10_000_000,
        ),
        linkedAssetCount: integerField(
          row.linkedAssetCount,
          "a linked asset count",
          10_000_000,
        ),
        firstAssetAt,
        lastAssetAt,
      }));
    }
    return Object.freeze(evidence);
  } finally {
    database.close(false);
  }
}

async function hashSnapshotDatabases(
  photos: SnapshotDatabase,
  contacts: readonly SnapshotDatabase[],
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  const groups = [photos, ...contacts];
  for (const [databaseIndex, database] of groups.entries()) {
    hash.update(databaseIndex === 0
      ? "apple-photos\0"
      : `apple-contacts-${String(databaseIndex - 1).padStart(2, "0")}\0`);
    for (const file of database.files) {
      // The SHM file is copied and identity-fenced because SQLite needs its
      // matching WAL index. Its transient lock bytes do not identify logical
      // database content and therefore do not enter the source generation.
      if (file.suffix === "-shm") continue;
      abortIfRequested(signal);
      hash.update(file.suffix === "" ? "main\0" : `${file.suffix.slice(1)}\0`);
      const metadata = await stat(file.snapshotPath, { bigint: true });
      hash.update(`${metadata.size.toString()}\0`);
      for await (const chunk of createReadStream(file.snapshotPath)) {
        abortIfRequested(signal);
        hash.update(chunk as Buffer);
      }
    }
  }
  return hash.digest("hex");
}

async function checkedHomeDirectory(
  request: ApplePhotosLocalSourceRequest,
  uid: bigint,
): Promise<string> {
  const selected = request.dependencies?.homeDirectory
    ?? request.environment?.HOME
    ?? homedir();
  const home = normalizedAbsolutePath(selected, "the home directory");
  await exactRealDirectory(home, "the home directory", uid);
  return home;
}

export async function exportApplePhotosContactEvidence(
  request: ApplePhotosLocalSourceRequest = {},
): Promise<ApplePhotosContactEvidenceExportResult> {
  const platform = request.dependencies?.platform ?? process.platform;
  if (platform !== "darwin") return fail("this source requires macOS");
  const currentUid = process.getuid?.();
  if (currentUid === undefined) return fail("the current file owner cannot be established");
  const uid = BigInt(currentUid);
  const startedAt = (request.dependencies?.now ?? (() => new Date()))().toISOString();
  const home = await checkedHomeDirectory(request, uid);
  const library = normalizedAbsolutePath(
    request.library ?? join(home, "Pictures", "Photos Library.photoslibrary"),
    "the Photos library",
  );
  if (!library.endsWith(".photoslibrary")) {
    return fail("the Photos library must have the .photoslibrary suffix");
  }
  await exactRealDirectory(library, "the Photos library", uid);
  const databaseDirectory = join(library, "database");
  await exactRealDirectory(databaseDirectory, "the Photos database directory", uid);
  if (!join(databaseDirectory, "Photos.sqlite").startsWith(`${library}${sep}`)) {
    return fail("the Photos database escaped the selected library");
  }
  const contacts = await discoverContactDatabases(home, uid);
  const explicitTemporary = request.dependencies?.temporaryDirectory;
  const selectedTemporary = normalizedAbsolutePath(
    explicitTemporary ?? tmpdir(),
    "the temporary directory",
  );
  const temporaryBase = explicitTemporary === undefined
    ? normalizedAbsolutePath(
        await realpath(selectedTemporary).catch(() =>
          fail("the temporary directory is unavailable")),
        "the physical temporary directory",
      )
    : selectedTemporary;
  await exactRealDirectory(temporaryBase, "the temporary directory", uid);
  const snapshotRoot = await mkdtemp(join(temporaryBase, "wrench-apple-photos-"));
  try {
    await chmod(snapshotRoot, 0o700);
    const photosSnapshot = await snapshotSqliteDatabase(
      join(library, PHOTOS_DATABASE_RELATIVE_PATH),
      snapshotRoot,
      "photos.sqlite",
      APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPhotosDatabaseBytes,
      uid,
      "photos",
      request.signal,
      request.dependencies?.afterSnapshotFilesCopied,
    );
    const contactSnapshots: SnapshotDatabase[] = [];
    for (const [index, source] of contacts.entries()) {
      contactSnapshots.push(await snapshotSqliteDatabase(
        source,
        snapshotRoot,
        `contacts-${String(index).padStart(2, "0")}.sqlite`,
        APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabaseBytes,
        uid,
        "contacts",
        request.signal,
        request.dependencies?.afterSnapshotFilesCopied,
      ));
    }
    abortIfRequested(request.signal);
    const contactIds = loadContactIds(contactSnapshots);
    const evidence = queryPhotosEvidence(photosSnapshot, contactIds);
    const generationSha256 = await hashSnapshotDatabases(
      photosSnapshot,
      contactSnapshots,
      request.signal,
    );
    const observedAt = (request.dependencies?.now ?? (() => new Date()))().toISOString();
    const finishedAt = (request.dependencies?.now ?? (() => new Date()))().toISOString();
    return createApplePhotosContactEvidenceExportResult({
      ...(request.dependencies?.runId === undefined
        ? {}
        : { runId: request.dependencies.runId() }),
      startedAt,
      finishedAt,
      observedAt,
      contactsDatabases: contactSnapshots.length,
      generationSha256,
      photosSchemaSha256: APPLE_PHOTOS_SCHEMA_SHA256,
      contactsSchemaSha256: APPLE_CONTACTS_SCHEMA_SHA256,
      evidence,
    });
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Apple Photos ")
    ) throw error;
    throw new Error("Apple Photos local source: private local operation failed");
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}
