import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  type BigIntStats,
  lstatSync,
  realpathSync,
} from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
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
import {
  createBeeperMessageLikeMeDirectoryLease,
  releaseBeeperMessageLikeMeDirectoryLease,
  type BeeperMessageLikeMeDirectoryLease,
  updateBeeperMessageLikeMeDirectoryLease,
} from "./beeper-message-like-me-recovery";
import { canonicalJson, sha256 } from "./canonical-json";
import { removePrivateDirectoryTree } from "./storage";

const PHOTOS_DATABASE_RELATIVE_PATH = join("database", "Photos.sqlite");
const CONTACTS_RELATIVE_ROOT = join(
  "Library",
  "Application Support",
  "AddressBook",
);
const SQLITE_HEADER_BYTES = 512;
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

type CaptureRole = "photos" | "contacts";

export type ApplePhotosLocalSourceDependencies = Readonly<{
  platform?: NodeJS.Platform;
  resolveAccountHomeDirectory?: () => string;
  temporaryDirectory?: string;
  now?: () => Date;
  runId?: () => string;
  afterDatabaseCaptured?: (
    role: CaptureRole,
    attempt: number,
  ) => void | Promise<void>;
}>;

export type ApplePhotosLocalSourceRequest = Readonly<{
  library?: string;
  stateEnvironment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  dependencies?: ApplePhotosLocalSourceDependencies;
  progress?: (event: ApplePhotosLocalSourceProgressEvent) => void;
}>;

export type ApplePhotosLocalSourceProgressEvent = Readonly<
  | { phase: "source-admission" }
  | { phase: "contacts-discovery" }
  | { phase: "photos-capture" }
  | { phase: "contacts-capture"; current: number; total: number }
  | { phase: "evidence-validation" }
  | { phase: "generation-hashing" }
  | { phase: "cleanup" }
>;

type DirectoryIdentity = Readonly<{
  kind: "directory";
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  uid: bigint;
  mode: bigint;
}>;

type SnapshotDirectory = Readonly<{
  path: string;
  parentPath: string;
  identity: DirectoryIdentity;
  parentIdentity: DirectoryIdentity;
}>;

type FileIdentity = Readonly<{
  kind: "regular-file";
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  mode: bigint;
  nlink: bigint;
  uid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type SourceFile = Readonly<{
  path: string;
  identity: FileIdentity;
}>;

type SnapshotDatabase = Readonly<{
  mainPath: string;
  capture: Readonly<{
    startedAt: string;
    finishedAt: string;
  }>;
}>;

type TableColumnContract = Readonly<Record<string, Readonly<{
  type: string;
  notnull: number;
  defaultValue: null;
  pk: number;
  hidden: number;
}>>>;

type SchemaContract = Readonly<Record<string, TableColumnContract>>;

function fail(message: string): never {
  throw new Error(`Apple Photos local source: ${message}`);
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) return fail("operation was cancelled");
}

function reportProgress(
  request: ApplePhotosLocalSourceRequest,
  event: ApplePhotosLocalSourceProgressEvent,
): void {
  try {
    request.progress?.(Object.freeze(event));
  } catch {
    // Progress is advisory and cannot weaken capture or cleanup custody.
  }
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
): Promise<DirectoryIdentity> {
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
  return Object.freeze({
    kind: "directory" as const,
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeNs: metadata.birthtimeNs,
    uid: metadata.uid,
    mode: metadata.mode,
  });
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.kind === right.kind
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs
    && left.uid === right.uid
    && left.mode === right.mode;
}

async function exactPrivateDirectory(
  path: string,
  label: string,
  uid: bigint,
): Promise<DirectoryIdentity> {
  const observed = await exactRealDirectory(path, label, uid);
  if ((observed.mode & 0o777n) !== 0o700n) {
    return fail(`${label} must be private mode 0700`);
  }
  return observed;
}

async function assertBoundDirectory(
  path: string,
  expected: DirectoryIdentity,
  label: string,
  uid: bigint,
  privateMode: boolean,
): Promise<void> {
  const observed = privateMode
    ? await exactPrivateDirectory(path, label, uid)
    : await exactRealDirectory(path, label, uid);
  if (!sameDirectoryIdentity(observed, expected)) {
    return fail(`${label} changed filesystem identity during the export`);
  }
}

async function assertSnapshotDirectory(
  snapshot: SnapshotDirectory,
  uid: bigint,
): Promise<void> {
  await assertBoundDirectory(
    snapshot.parentPath,
    snapshot.parentIdentity,
    "the private snapshot parent",
    uid,
    true,
  );
  await assertBoundDirectory(
    snapshot.path,
    snapshot.identity,
    "the private snapshot root",
    uid,
    true,
  );
}

function assertSnapshotDirectorySync(
  snapshot: SnapshotDirectory,
  uid: bigint,
): void {
  for (const [path, expected, label] of [
    [snapshot.parentPath, snapshot.parentIdentity, "the private snapshot parent"],
    [snapshot.path, snapshot.identity, "the private snapshot root"],
  ] as const) {
    let metadata: BigIntStats;
    let resolved: string;
    try {
      metadata = lstatSync(path, { bigint: true });
      resolved = realpathSync(path);
    } catch {
      return fail(`${label} is unavailable`);
    }
    const observed = Object.freeze({
      kind: "directory" as const,
      dev: metadata.dev,
      ino: metadata.ino,
      birthtimeNs: metadata.birthtimeNs,
      uid: metadata.uid,
      mode: metadata.mode,
    });
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || metadata.uid !== uid
      || resolved !== path
      || (metadata.mode & 0o777n) !== 0o700n
      || !sameDirectoryIdentity(observed, expected)
    ) return fail(`${label} changed filesystem identity during the export`);
  }
}

function identity(metadata: BigIntStats): FileIdentity {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return fail("a database descriptor is not a regular file");
  }
  return Object.freeze({
    kind: "regular-file" as const,
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeNs: metadata.birthtimeNs,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameExactIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameStableIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function libraryRealmSha256(identity: DirectoryIdentity): string {
  return sha256(canonicalJson({
    domain: "wrench.apple-photos.library-realm.v1",
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    birthtimeNs: identity.birthtimeNs.toString(),
  }));
}

function sameStableIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.kind === right.kind
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

async function ownedSourceFile(
  path: string,
  uid: bigint,
  maximumBytes: number,
): Promise<SourceFile> {
  let metadata: BigIntStats;
  try {
    metadata = await lstat(path, { bigint: true });
  } catch {
    return fail("a source database file could not be inspected");
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.nlink !== 1n
    || metadata.size < BigInt(SQLITE_HEADER_BYTES)
    || metadata.size > BigInt(maximumBytes)
  ) return fail("a source database file failed type, owner, hardlink, or size validation");
  return Object.freeze({ path, identity: identity(metadata) });
}

async function sourcePathStillMatches(
  file: SourceFile,
  uid: bigint,
  maximumBytes: number,
): Promise<boolean> {
  try {
    const current = await lstat(file.path, { bigint: true });
    return current.isFile()
      && !current.isSymbolicLink()
      && current.uid === uid
      && current.nlink === 1n
      && current.size >= BigInt(SQLITE_HEADER_BYTES)
      && current.size <= BigInt(maximumBytes)
      && sameStableIdentity(file.identity, identity(current));
  } catch {
    return false;
  }
}

async function capturedFileIdentity(
  path: string,
  uid: bigint,
  maximumBytes: number,
): Promise<FileIdentity> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.chmod(0o600);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.uid !== uid
      || metadata.nlink !== 1n
      || (metadata.mode & 0o777n) !== 0o600n
      || metadata.size < BigInt(SQLITE_HEADER_BYTES)
      || metadata.size > BigInt(maximumBytes)
    ) return fail("a captured database failed private file validation");
    return identity(metadata);
  } finally {
    await handle.close();
  }
}

async function captureSqliteDatabase(
  sourceMainPath: string,
  snapshotRoot: SnapshotDirectory,
  snapshotStem: string,
  mainMaximum: number,
  uid: bigint,
  role: CaptureRole,
  signal: AbortSignal | undefined,
  afterCaptured: ApplePhotosLocalSourceDependencies["afterDatabaseCaptured"],
  now: () => Date,
): Promise<SnapshotDatabase> {
  const destination = join(snapshotRoot.path, snapshotStem);
  abortIfRequested(signal);
  await assertSnapshotDirectory(snapshotRoot, uid);
  await rm(destination, { force: true });
  await assertSnapshotDirectory(snapshotRoot, uid);
  const source = await ownedSourceFile(sourceMainPath, uid, mainMaximum);
  const sourceHandle = await open(
    source.path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let capturedIdentity: FileIdentity | undefined;
  const startedAt = now().toISOString();
  try {
    const opened = identity(await sourceHandle.stat({ bigint: true }));
    if (!sameStableIdentity(opened, source.identity)) {
      return fail("the source database changed identity before capture");
    }
    const sourceDatabase = new Database(source.path, {
      readonly: true,
      strict: true,
    });
    try {
      sourceDatabase.exec("PRAGMA trusted_schema = OFF");
      sourceDatabase.exec("PRAGMA foreign_keys = OFF");
      sourceDatabase.query("VACUUM INTO ?1").run(destination);
    } finally {
      sourceDatabase.close(false);
    }
    capturedIdentity = await capturedFileIdentity(destination, uid, mainMaximum);
    const captured = new Database(destination, { readonly: true, strict: true });
    try {
      captured.exec("PRAGMA trusted_schema = OFF");
      validateQuickCheck(captured, "captured SQLite database");
      captured.exec("PRAGMA query_only = ON");
      captured.exec("PRAGMA foreign_keys = OFF");
    } finally {
      captured.close(false);
    }
    await afterCaptured?.(
      role,
      APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.captureAttemptsPerDatabase,
    );
    abortIfRequested(signal);
    await assertSnapshotDirectory(snapshotRoot, uid);
    const descriptorStable = sameStableIdentity(
      identity(await sourceHandle.stat({ bigint: true })),
      source.identity,
    );
    const pathStable = await sourcePathStillMatches(source, uid, mainMaximum);
    if (!descriptorStable || !pathStable) {
      return fail("the source database changed filesystem identity during capture");
    }
    const afterValidation = identity(await lstat(destination, { bigint: true }));
    if (!sameExactIdentity(capturedIdentity, afterValidation)) {
      return fail("the captured database changed after integrity validation");
    }
    return Object.freeze({
      mainPath: destination,
      capture: Object.freeze({
        startedAt,
        finishedAt: now().toISOString(),
      }),
    });
  } finally {
    await sourceHandle.close().catch(() => undefined);
    if (capturedIdentity === undefined) {
      await assertSnapshotDirectory(snapshotRoot, uid);
      await rm(destination, { force: true });
      await assertSnapshotDirectory(snapshotRoot, uid);
    }
  }
}

async function latestContactDatabaseInDirectory(
  directory: string,
  uid: bigint,
): Promise<string | null> {
  await exactRealDirectory(directory, "an Apple Contacts store directory", uid);
  const entries = await opendir(directory);
  let scanned = 0;
  let latest: Readonly<{ path: string; version: number }> | null = null;
  for await (const entry of entries) {
    scanned += 1;
    if (scanned > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumDirectoryEntries) {
      return fail("an Apple Contacts store directory exceeds the reviewed entry bound");
    }
    const match = CONTACT_DATABASE_PATTERN.exec(entry.name);
    if (match === null) continue;
    if (!entry.isFile()) return fail("an Apple Contacts database candidate is not a regular directory entry");
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) return fail("an Apple Contacts database version is malformed");
    if (latest === null || version > latest.version) {
      latest = Object.freeze({ path: join(directory, entry.name), version });
    }
  }
  return latest?.path ?? null;
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
  const sourceNames: string[] = [];
  try {
    await exactRealDirectory(sourcesRoot, "the Apple Contacts Sources directory", uid);
    const entries = await opendir(sourcesRoot);
    let scanned = 0;
    for await (const entry of entries) {
      scanned += 1;
      if (scanned > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumDirectoryEntries) {
        return fail("the Apple Contacts Sources directory exceeds the reviewed entry bound");
      }
      if (!CONTACT_SOURCE_DIRECTORY_PATTERN.test(entry.name)) continue;
      if (!entry.isDirectory()) {
        return fail("an Apple Contacts source identifier is not a directory");
      }
      sourceNames.push(entry.name);
      if (
        sourceNames.length
        > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsSourceDirectories
      ) return fail("Apple Contacts source directories exceed the reviewed bound");
    }
  } catch (error) {
    if (
      !(error instanceof Error)
      || error.message !== "Apple Photos local source: the Apple Contacts Sources directory is unavailable"
    ) throw error;
  }
  sourceNames.sort((left, right) => Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  ));
  for (const sourceName of sourceNames) {
    const candidate = await latestContactDatabaseInDirectory(
      join(sourcesRoot, sourceName),
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

function validateQuickCheck(database: Database, label: string): void {
  const quickCheck = database.query("PRAGMA quick_check(1)").get() as unknown;
  const quickCheckRow = databaseRow(quickCheck, `${label} quick check`);
  if (Object.values(quickCheckRow).length !== 1 || Object.values(quickCheckRow)[0] !== "ok") {
    return fail(`${label} failed SQLite quick_check`);
  }
}

function validateSchema(
  database: Database,
  contract: SchemaContract,
  expectedSha256: string,
  label: string,
): void {
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
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA query_only = ON");
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
  snapshotRoot: SnapshotDirectory,
  uid: bigint,
): Set<string> {
  const ids = new Set<string>();
  let scanned = 0;
  for (const snapshot of snapshots) {
    assertSnapshotDirectorySync(snapshotRoot, uid);
    const database = new Database(snapshot.mainPath, {
      readonly: true,
      strict: true,
    });
    try {
      assertSnapshotDirectorySync(snapshotRoot, uid);
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
      assertSnapshotDirectorySync(snapshotRoot, uid);
    } finally {
      database.close(false);
      assertSnapshotDirectorySync(snapshotRoot, uid);
    }
  }
  return ids;
}

function queryPhotosEvidence(
  snapshot: SnapshotDatabase,
  contactIds: ReadonlySet<string>,
  snapshotRoot: SnapshotDirectory,
  uid: bigint,
): readonly ApplePhotosContactEvidence[] {
  assertSnapshotDirectorySync(snapshotRoot, uid);
  const database = new Database(snapshot.mainPath, {
    readonly: true,
    strict: true,
  });
  try {
    assertSnapshotDirectorySync(snapshotRoot, uid);
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
    assertSnapshotDirectorySync(snapshotRoot, uid);
    return Object.freeze(evidence);
  } finally {
    database.close(false);
    assertSnapshotDirectorySync(snapshotRoot, uid);
  }
}

async function hashSnapshotDatabases(
  photos: SnapshotDatabase,
  contacts: readonly SnapshotDatabase[],
  snapshotRoot: SnapshotDirectory,
  uid: bigint,
  signal: AbortSignal | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  const groups = [photos, ...contacts];
  for (const [databaseIndex, database] of groups.entries()) {
    hash.update(databaseIndex === 0
      ? "apple-photos\0"
      : `apple-contacts-${String(databaseIndex - 1).padStart(2, "0")}\0`);
    abortIfRequested(signal);
    await assertSnapshotDirectory(snapshotRoot, uid);
    const before = await capturedFileIdentity(
      database.mainPath,
      uid,
      databaseIndex === 0
        ? APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPhotosDatabaseBytes
        : APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabaseBytes,
    );
    hash.update("vacuum-capture\0");
    hash.update(`${before.size.toString()}\0`);
    for await (const chunk of createReadStream(database.mainPath)) {
      abortIfRequested(signal);
      hash.update(chunk as Buffer);
    }
    const after = identity(await lstat(database.mainPath, { bigint: true }));
    if (!sameExactIdentity(before, after)) {
      return fail("a captured database changed during generation hashing");
    }
    await assertSnapshotDirectory(snapshotRoot, uid);
  }
  return hash.digest("hex");
}

async function checkedHomeDirectory(
  request: ApplePhotosLocalSourceRequest,
  uid: bigint,
): Promise<string> {
  const selected = request.dependencies?.resolveAccountHomeDirectory?.()
    ?? resolveApplePhotosAccountHomeDirectory();
  const home = normalizedAbsolutePath(selected, "the home directory");
  await exactRealDirectory(home, "the home directory", uid);
  return home;
}

/** Resolve the signed-in OS account's home without consulting ambient env. */
export function resolveApplePhotosAccountHomeDirectory(): string {
  try {
    return userInfo({ encoding: "utf8" }).homedir;
  } catch {
    return fail("the operating system account home directory is unavailable");
  }
}

export async function exportApplePhotosContactEvidence(
  request: ApplePhotosLocalSourceRequest = {},
): Promise<ApplePhotosContactEvidenceExportResult> {
  const platform = request.dependencies?.platform ?? process.platform;
  if (platform !== "darwin") return fail("this source requires macOS");
  const currentUid = process.getuid?.();
  if (currentUid === undefined) return fail("the current file owner cannot be established");
  const uid = BigInt(currentUid);
  const now = request.dependencies?.now ?? (() => new Date());
  const startedAt = now().toISOString();
  reportProgress(request, { phase: "source-admission" });
  const home = await checkedHomeDirectory(request, uid);
  const library = normalizedAbsolutePath(
    request.library ?? join(home, "Pictures", "Photos Library.photoslibrary"),
    "the Photos library",
  );
  if (!library.endsWith(".photoslibrary")) {
    return fail("the Photos library must have the .photoslibrary suffix");
  }
  const libraryIdentity = await exactRealDirectory(
    library,
    "the Photos library",
    uid,
  );
  const databaseDirectory = join(library, "database");
  const databaseDirectoryIdentity = await exactRealDirectory(
    databaseDirectory,
    "the Photos database directory",
    uid,
  );
  if (!join(databaseDirectory, "Photos.sqlite").startsWith(`${library}${sep}`)) {
    return fail("the Photos database escaped the selected library");
  }
  reportProgress(request, { phase: "contacts-discovery" });
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
  await exactPrivateDirectory(
    temporaryBase,
    "the temporary directory",
    uid,
  );
  const snapshotRootPath = await mkdtemp(join(temporaryBase, "wrench-apple-photos-"));
  const snapshotParentIdentity = await exactPrivateDirectory(
    temporaryBase,
    "the temporary directory",
    uid,
  );
  const snapshotRoot: SnapshotDirectory = Object.freeze({
    path: snapshotRootPath,
    parentPath: temporaryBase,
    identity: await exactPrivateDirectory(
      snapshotRootPath,
      "the private snapshot root",
      uid,
    ),
    parentIdentity: snapshotParentIdentity,
  });
  let snapshotLease: BeeperMessageLikeMeDirectoryLease | undefined;
  try {
    await assertSnapshotDirectory(snapshotRoot, uid);
    if (request.stateEnvironment !== undefined) {
      const createdAtMs = Date.now();
      snapshotLease = await createBeeperMessageLikeMeDirectoryLease({
        role: "raw-working",
        path: snapshotRoot.path,
        recoverAfterMs: createdAtMs,
        nowMs: createdAtMs,
        environment: request.stateEnvironment,
      });
      updateBeeperMessageLikeMeDirectoryLease(snapshotLease, "launching");
      updateBeeperMessageLikeMeDirectoryLease(
        snapshotLease,
        "running",
        process.pid,
      );
    }
    reportProgress(request, { phase: "photos-capture" });
    const photosSnapshot = await captureSqliteDatabase(
      join(library, PHOTOS_DATABASE_RELATIVE_PATH),
      snapshotRoot,
      "photos.sqlite",
      APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPhotosDatabaseBytes,
      uid,
      "photos",
      request.signal,
      request.dependencies?.afterDatabaseCaptured,
      now,
    );
    const contactSnapshots: SnapshotDatabase[] = [];
    for (const [index, source] of contacts.entries()) {
      reportProgress(request, {
        phase: "contacts-capture",
        current: index + 1,
        total: contacts.length,
      });
      contactSnapshots.push(await captureSqliteDatabase(
        source,
        snapshotRoot,
        `contacts-${String(index).padStart(2, "0")}.sqlite`,
        APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabaseBytes,
        uid,
        "contacts",
        request.signal,
        request.dependencies?.afterDatabaseCaptured,
        now,
      ));
    }
    abortIfRequested(request.signal);
    await assertSnapshotDirectory(snapshotRoot, uid);
    await assertBoundDirectory(
      library,
      libraryIdentity,
      "the Photos library",
      uid,
      false,
    );
    await assertBoundDirectory(
      databaseDirectory,
      databaseDirectoryIdentity,
      "the Photos database directory",
      uid,
      false,
    );
    reportProgress(request, { phase: "evidence-validation" });
    const contactIds = loadContactIds(contactSnapshots, snapshotRoot, uid);
    const evidence = queryPhotosEvidence(
      photosSnapshot,
      contactIds,
      snapshotRoot,
      uid,
    );
    reportProgress(request, { phase: "generation-hashing" });
    const generationSha256 = await hashSnapshotDatabases(
      photosSnapshot,
      contactSnapshots,
      snapshotRoot,
      uid,
      request.signal,
    );
    await assertBoundDirectory(
      library,
      libraryIdentity,
      "the Photos library",
      uid,
      false,
    );
    await assertBoundDirectory(
      databaseDirectory,
      databaseDirectoryIdentity,
      "the Photos database directory",
      uid,
      false,
    );
    const observedAt = now().toISOString();
    const captureFinishedAt = now().toISOString();
    const finishedAt = now().toISOString();
    return createApplePhotosContactEvidenceExportResult({
      ...(request.dependencies?.runId === undefined
        ? {}
        : { runId: request.dependencies.runId() }),
      startedAt,
      finishedAt,
      observedAt,
      contactsDatabases: contactSnapshots.length,
      libraryRealmSha256: libraryRealmSha256(libraryIdentity),
      generationSha256,
      photosSchemaSha256: APPLE_PHOTOS_SCHEMA_SHA256,
      contactsSchemaSha256: APPLE_CONTACTS_SCHEMA_SHA256,
      capture: Object.freeze({
        startedAt,
        finishedAt: captureFinishedAt,
        photos: photosSnapshot.capture,
        contacts: Object.freeze(contactSnapshots.map((snapshot, ordinal) =>
          Object.freeze({ ordinal, ...snapshot.capture }))),
        consistency: "independent-read-transactions" as const,
        crossDatabaseAtomicity: "not-asserted" as const,
      }),
      evidence,
    });
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Apple Photos ")
    ) throw error;
    throw new Error("Apple Photos local source: private local operation failed");
  } finally {
    let removed = false;
    try {
      reportProgress(request, { phase: "cleanup" });
      await assertSnapshotDirectory(snapshotRoot, uid);
      removed = removePrivateDirectoryTree(snapshotRoot.path, {
        device: snapshotRoot.identity.dev.toString(),
        inode: snapshotRoot.identity.ino.toString(),
        birthtimeNs: snapshotRoot.identity.birthtimeNs.toString(),
      });
      if (!removed) return fail("the private snapshot root could not be removed exactly");
    } catch {
      return fail("the private snapshot root changed before exact cleanup");
    } finally {
      if (removed && snapshotLease !== undefined) {
        updateBeeperMessageLikeMeDirectoryLease(snapshotLease, "settled");
        releaseBeeperMessageLikeMeDirectoryLease(snapshotLease);
      }
    }
  }
}
