import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  acquireCookieRecords,
  type CookieRecordReader,
  type CookieSelection,
} from "@hraness/kb/clip/acquire";
import {
  filterCookies,
  MAX_COOKIE_RECORDS,
  type StrictCookie,
} from "@hraness/kb/clip/cookies";

import type { WrenchAuth } from "./auth";
import { listDerivations } from "./derive";

const MAX_CHROMIUM_COOKIE_DB_BYTES = 256 * 1024 * 1024;
const MAX_CHROMIUM_COOKIE_SIDECAR_BYTES = 128 * 1024 * 1024;
const CHROMIUM_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600_000_000n;
const MICROSECONDS_PER_SECOND = 1_000_000n;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const MOCK_KEYCHAIN_KEY = pbkdf2Sync(
  "mock_password",
  "saltysalt",
  1_003,
  16,
  "sha1",
);
const DERIVATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type ChromiumCookieRow = {
  readonly name: string;
  readonly value: string;
  readonly hostKey: string;
  readonly path: string;
  readonly expiresUtc: string;
  readonly sameSite: number;
  readonly encryptedValue: Uint8Array;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly topFrameSiteKey: string;
  readonly hasCrossSiteAncestor: boolean;
};

function ownedByCurrentUser(uid: bigint): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return currentUid === undefined || uid === BigInt(currentUid);
}

type FileIdentity = {
  readonly device: string;
  readonly inode: string;
  readonly byteLength: bigint;
  readonly modifiedAtNanoseconds: bigint;
};

function inspectPrivateRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): FileIdentity {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || !ownedByCurrentUser(stats.uid)
    || (stats.mode & 0o077n) !== 0n
    || stats.size < 1n
    || stats.size > BigInt(maximumBytes)
    || realpathSync(path) !== path
  ) throw new Error(`${label} is unsafe`);
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    byteLength: stats.size,
    modifiedAtNanoseconds: stats.mtimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.byteLength === right.byteLength
    && left.modifiedAtNanoseconds === right.modifiedAtNanoseconds;
}

function inspectPrivateDirectory(path: string, label: string): void {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !ownedByCurrentUser(stats.uid)
    || (stats.mode & 0o777n) !== 0o700n
    || realpathSync(path) !== path
  ) throw new Error(`${label} is unsafe`);
}

/**
 * Select only the exact ready profile layout created inside Wrench's private
 * derivation state. A path that merely resembles that layout cannot opt an
 * arbitrary Chromium profile into the fixed mock-keychain credential.
 */
function managedDerivationChromiumCookieDatabase(
  browserProfile: string,
  cookieProfile: string | undefined,
): string | null {
  if (!isAbsolute(browserProfile) || cookieProfile === undefined || !isAbsolute(cookieProfile)) {
    return null;
  }
  const profile = resolve(browserProfile);
  if (basename(profile) !== "profile") return null;
  const directory = dirname(profile);
  const id = basename(directory);
  const derivationsDirectory = dirname(directory);
  if (
    !DERIVATION_ID_PATTERN.test(id)
    || basename(derivationsDirectory) !== "derivations"
    || resolve(cookieProfile) !== join(profile, "Default")
  ) return null;

  const sessionPath = join(directory, "session.json");
  const before = inspectPrivateRegularFile(
    sessionPath,
    64 * 1024,
    "managed Chromium derivation metadata",
  );
  const summaries = listDerivations({
    WRENCH_STATE_HOME: dirname(derivationsDirectory),
  });
  const summary = summaries.find((candidate) => candidate.id === id);
  if (summary === undefined || summary.invalid === true || summary.ready !== true) {
    throw new Error("managed Chromium profile is not bound to one ready Wrench derivation");
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(readFileSync(sessionPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("managed Chromium derivation metadata is malformed", { cause: error });
  }
  const after = inspectPrivateRegularFile(
    sessionPath,
    64 * 1024,
    "managed Chromium derivation metadata",
  );
  if (!sameFileIdentity(before, after)) {
    throw new Error("managed Chromium derivation metadata changed during validation");
  }
  if (
    typeof metadata !== "object"
    || metadata === null
    || Array.isArray(metadata)
    || (metadata as Record<string, unknown>).id !== id
    || (metadata as Record<string, unknown>).directory !== directory
    || (metadata as Record<string, unknown>).profilePath !== profile
  ) throw new Error("managed Chromium profile does not match its derivation metadata");
  inspectPrivateDirectory(profile, "managed Chromium profile");
  inspectPrivateDirectory(join(profile, "Default"), "managed Chromium Default profile");
  return join(profile, "Default", "Cookies");
}

function snapshotPrivateRegularFile(
  source: string,
  target: string,
  maximumBytes: number,
  label: string,
  optional = false,
): void {
  if (optional && !existsSync(source)) return;
  const before = inspectPrivateRegularFile(source, maximumBytes, label);
  try {
    copyFileSync(source, target);
  } catch (error) {
    throw new Error(`${label} could not be snapshotted`, { cause: error });
  }
  const after = inspectPrivateRegularFile(source, maximumBytes, label);
  if (!sameFileIdentity(before, after)) {
    throw new Error(`${label} changed while it was being snapshotted`);
  }
}

function chromiumHostCandidates(hostname: string): readonly string[] {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return [hostname.toLowerCase()];
  const candidates = new Set<string>([parts.join(".")]);
  for (let index = 0; index <= parts.length - 2; index += 1) {
    candidates.add(`.${parts.slice(index).join(".")}`);
  }
  return [...candidates];
}

function booleanColumn(value: unknown): boolean | null {
  if (value === true || value === 1 || value === 1n || value === "1") return true;
  if (value === false || value === 0 || value === 0n || value === "0") return false;
  return null;
}

function integerColumn(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  if (typeof value === "string" && /^-?[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parseChromiumCookieRow(value: unknown): ChromiumCookieRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const secure = booleanColumn(row.is_secure);
  const httpOnly = booleanColumn(row.is_httponly);
  const hasCrossSiteAncestor = booleanColumn(row.has_cross_site_ancestor);
  const sameSite = integerColumn(row.samesite);
  if (
    typeof row.name !== "string"
    || typeof row.value !== "string"
    || typeof row.host_key !== "string"
    || typeof row.path !== "string"
    || typeof row.expires_utc !== "string"
    || !(row.encrypted_value instanceof Uint8Array)
    || typeof row.top_frame_site_key !== "string"
    || secure === null
    || httpOnly === null
    || hasCrossSiteAncestor === null
    || sameSite === null
  ) return null;
  return {
    name: row.name,
    value: row.value,
    hostKey: row.host_key,
    path: row.path,
    expiresUtc: row.expires_utc,
    sameSite,
    encryptedValue: row.encrypted_value,
    secure,
    httpOnly,
    topFrameSiteKey: row.top_frame_site_key,
    hasCrossSiteAncestor,
  };
}

function removePkcs7Padding(value: Buffer): Buffer | null {
  if (value.length === 0) return null;
  const padding = value[value.length - 1] ?? 0;
  if (padding < 1 || padding > 16 || padding > value.length) return null;
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value[index] !== padding) return null;
  }
  return value.subarray(0, value.length - padding);
}

function decryptMockKeychainCookie(
  encryptedValue: Uint8Array,
  hostKey: string,
  requireHostHash: boolean,
): string | null {
  const bytes = Buffer.from(encryptedValue);
  if (bytes.length < 19) return null;
  const prefix = bytes.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return null;
  try {
    const decipher = createDecipheriv(
      "aes-128-cbc",
      MOCK_KEYCHAIN_KEY,
      Buffer.alloc(16, 0x20),
    );
    decipher.setAutoPadding(false);
    const padded = Buffer.concat([
      decipher.update(bytes.subarray(3)),
      decipher.final(),
    ]);
    const plaintext = removePkcs7Padding(padded);
    if (plaintext === null) return null;
    let value = plaintext;
    if (requireHostHash) {
      if (plaintext.length < 32) return null;
      const expected = createHash("sha256").update(hostKey, "utf8").digest();
      if (!timingSafeEqual(plaintext.subarray(0, 32), expected)) return null;
      value = plaintext.subarray(32);
    }
    return UTF8_DECODER.decode(value);
  } catch {
    return null;
  }
}

function chromiumExpiry(value: string): number | null {
  if (!/^[0-9]+$/u.test(value)) return null;
  const microseconds = BigInt(value);
  if (microseconds === 0n) return 0;
  if (microseconds <= CHROMIUM_EPOCH_OFFSET_MICROSECONDS) return null;
  const seconds = (microseconds - CHROMIUM_EPOCH_OFFSET_MICROSECONDS)
    / MICROSECONDS_PER_SECOND;
  const parsed = Number(seconds);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function chromiumSameSite(value: number): StrictCookie["sameSite"] {
  if (value === 2) return "Strict";
  if (value === 1) return "Lax";
  if (value === 0) return "None";
  return null;
}

async function readManagedChromiumCookies(
  databasePath: string,
  target: URL,
): Promise<{ readonly cookies: readonly StrictCookie[]; readonly warnings: readonly string[] }> {
  const snapshotDirectory = mkdtempSync(join(tmpdir(), "wrench-managed-chromium-"));
  const snapshotPath = join(snapshotDirectory, "Cookies");
  try {
    snapshotPrivateRegularFile(
      databasePath,
      snapshotPath,
      MAX_CHROMIUM_COOKIE_DB_BYTES,
      "managed Chromium cookie database",
    );
    snapshotPrivateRegularFile(
      `${databasePath}-wal`,
      `${snapshotPath}-wal`,
      MAX_CHROMIUM_COOKIE_SIDECAR_BYTES,
      "managed Chromium cookie WAL",
      true,
    );
    snapshotPrivateRegularFile(
      `${databasePath}-shm`,
      `${snapshotPath}-shm`,
      MAX_CHROMIUM_COOKIE_SIDECAR_BYTES,
      "managed Chromium cookie shared-memory file",
      true,
    );

    const { Database } = await import("bun:sqlite");
    const database = new Database(snapshotPath, { readonly: true });
    try {
      const meta = database.query("SELECT value FROM meta WHERE key = ? LIMIT 1").get("version");
      const metaVersion = typeof meta === "object" && meta !== null
        ? integerColumn((meta as Record<string, unknown>).value)
        : null;
      if (metaVersion === null) throw new Error("managed Chromium cookie database has no valid schema version");
      const hostCandidates = chromiumHostCandidates(target.hostname);
      const placeholders = hostCandidates.map(() => "?").join(", ");
      const rows = database.query(
        "SELECT name, value, host_key, path, CAST(expires_utc AS TEXT) AS expires_utc, "
          + "samesite, encrypted_value, is_secure, is_httponly, top_frame_site_key, "
          + "has_cross_site_ancestor FROM cookies "
          + `WHERE host_key IN (${placeholders}) ORDER BY expires_utc DESC LIMIT ?`,
      ).all(...hostCandidates, MAX_COOKIE_RECORDS + 1);
      if (rows.length > MAX_COOKIE_RECORDS) {
        throw new Error("managed Chromium cookie selection exceeded its record bound");
      }

      let malformed = 0;
      let partitioned = 0;
      const candidates = new Map<string, Readonly<Record<string, unknown>>>();
      for (const value of rows) {
        const row = parseChromiumCookieRow(value);
        if (row === null) {
          malformed += 1;
          continue;
        }
        if (row.topFrameSiteKey.trim() !== "") {
          partitioned += 1;
          continue;
        }
        const cookieValue = row.value.length > 0
          ? row.value
          : decryptMockKeychainCookie(
              row.encryptedValue,
              row.hostKey,
              metaVersion >= 24,
            );
        const expires = chromiumExpiry(row.expiresUtc);
        if (cookieValue === null || expires === null) {
          malformed += 1;
          continue;
        }
        const hostOnly = !row.hostKey.startsWith(".");
        const domain = hostOnly ? row.hostKey : row.hostKey.slice(1);
        const key = `${domain}\0${hostOnly ? "host" : "domain"}\0${row.path || "/"}\0${row.name}`;
        if (candidates.has(key)) continue;
        candidates.set(key, {
          name: row.name,
          value: cookieValue,
          domain,
          hostOnly,
          path: row.path || "/",
          secure: row.secure,
          httpOnly: row.httpOnly,
          sameSite: chromiumSameSite(row.sameSite),
          expires,
          top_frame_site_key: "",
          has_cross_site_ancestor: false,
        });
      }
      const filtered = filterCookies([...candidates.values()], target);
      const rejected = malformed + filtered.rejected;
      if (filtered.cookies.length === 0) {
        throw new Error(rejected === 0
          ? "no matching cookies were found in the managed Chromium profile"
          : "the managed Chromium profile contained no usable origin-scoped cookies");
      }
      const warnings: string[] = [];
      if (rejected > 0) warnings.push(`Ignored ${rejected} malformed, expired, or out-of-scope managed Chromium cookie record(s).`);
      if (partitioned > 0) warnings.push(`Excluded ${partitioned} partitioned managed Chromium cookie record(s).`);
      return { cookies: filtered.cookies, warnings };
    } finally {
      database.close();
    }
  } finally {
    rmSync(snapshotDirectory, { recursive: true, force: true });
  }
}

export function webSessionCookieSelection(
  auth: WrenchAuth,
  timeoutMs: number,
): CookieSelection {
  if (auth.kind === "cookie-source") {
    return {
      cookieSources: [auth.source],
      cookiesFile: undefined,
      cookieProfile: auth.profile,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "cookies-file") {
    return {
      cookieSources: [],
      cookiesFile: auth.path,
      cookieProfile: undefined,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "browser-profile" && auth.cookieSource !== undefined) {
    return {
      cookieSources: [auth.cookieSource],
      cookiesFile: undefined,
      cookieProfile: auth.cookieProfile,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "browser-profile") {
    throw new Error("authenticated web API execution requires the browser auth locator to name a cookie source");
  }
  throw new Error("authenticated web API execution requires browser-session or cookie auth");
}

export async function acquireWebSessionCookieRecords(
  auth: WrenchAuth,
  target: URL,
  timeoutMs: number,
  reader: CookieRecordReader = acquireCookieRecords,
): Promise<{ readonly cookies: readonly StrictCookie[]; readonly warnings: readonly string[] }> {
  if (
    auth.kind === "browser-profile"
    && auth.cookieSource === "chrome"
  ) {
    const databasePath = managedDerivationChromiumCookieDatabase(
      auth.profile,
      auth.cookieProfile,
    );
    if (databasePath !== null) {
      return readManagedChromiumCookies(databasePath, target);
    }
  }
  return reader(webSessionCookieSelection(auth, timeoutMs), target);
}
