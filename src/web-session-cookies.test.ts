import { describe, expect, test } from "bun:test";
import {
  createCipheriv,
  createHash,
  pbkdf2Sync,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";

import type { WrenchAuth } from "./auth";
import { sha256 } from "./canonical-json";
import { wrenchStateHome } from "./storage";
import { acquireWebSessionCookieRecords } from "./web-session-cookies";

const CHROMIUM_EPOCH_OFFSET_MICROSECONDS = 11_644_473_600_000_000n;

function directoryIdentity(path: string): { readonly device: string; readonly inode: string } {
  const stats = lstatSync(path, { bigint: true });
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function encryptMockKeychainCookie(hostKey: string, value: string): Buffer {
  const key = pbkdf2Sync("mock_password", "saltysalt", 1_003, 16, "sha1");
  const plaintext = Buffer.concat([
    createHash("sha256").update(hostKey, "utf8").digest(),
    Buffer.from(value, "utf8"),
  ]);
  const padding = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  cipher.setAutoPadding(false);
  return Buffer.concat([
    Buffer.from("v10", "ascii"),
    cipher.update(padded),
    cipher.final(),
  ]);
}

function managedProfileFixture(): {
  readonly auth: WrenchAuth;
  readonly cleanup: () => void;
} {
  const requestedRoot = mkdtempSync(join(tmpdir(), "wrench-managed-cookie-test-"));
  chmodSync(requestedRoot, 0o700);
  const root = wrenchStateHome({ WRENCH_STATE_HOME: requestedRoot });
  const id = randomUUID();
  const directory = join(root, "derivations", id);
  const profile = join(directory, "profile");
  const defaultProfile = join(profile, "Default");
  const socketDirectory = join(
    process.platform === "win32" ? tmpdir() : "/tmp",
    `io-derive-ab-${id}`,
  );
  mkdirSync(defaultProfile, { recursive: true, mode: 0o700 });
  chmodSync(join(root, "derivations"), 0o700);
  chmodSync(directory, 0o700);
  chmodSync(profile, 0o700);
  chmodSync(defaultProfile, 0o700);
  mkdirSync(socketDirectory, { mode: 0o700 });
  writeFileSync(join(directory, "agent-browser.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(directory, "action-policy.json"), "{}\n", { mode: 0o600 });

  const directoryId = directoryIdentity(directory);
  const socketId = directoryIdentity(socketDirectory);
  writeFileSync(join(directory, "phase.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "io-derivation-directory-phase",
    derivationId: id,
    directoryIdentity: directoryId,
  }), { mode: 0o600 });
  writeFileSync(join(directory, "initializing.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "io-derivation-initialization",
    derivationId: id,
    directoryIdentity: directoryId,
    socketDirectory,
    socketIdentity: socketId,
  }), { mode: 0o600 });
  const metadata = JSON.stringify({
    schemaVersion: 1,
    id,
    adapterId: "managed-cookie-test",
    targetUrl: "https://www.example.com/",
    targetOrigin: "https://www.example.com",
    createdAt: "2026-08-17T00:00:00.000Z",
    allowRemoteActions: true,
    contentMode: "none",
    browserDomains: ["www.example.com"],
    headed: true,
    sessionName: `io-derive-${id.replaceAll("-", "").slice(0, 12)}`,
    directory,
    directoryIdentity: directoryId,
    socketDirectory,
    socketIdentity: socketId,
    configPath: join(directory, "agent-browser.json"),
    policyPath: join(directory, "action-policy.json"),
    profilePath: profile,
  });
  const metadataPath = join(directory, "session.json");
  writeFileSync(metadataPath, metadata, { mode: 0o600 });
  const metadataStats = lstatSync(metadataPath, { bigint: true });
  writeFileSync(join(directory, "ready.json"), JSON.stringify({
    schemaVersion: 1,
    state: "ready",
    metadata: {
      device: metadataStats.dev.toString(),
      inode: metadataStats.ino.toString(),
      byteLength: Buffer.byteLength(metadata, "utf8"),
      sha256: sha256(metadata),
    },
  }), { mode: 0o600 });

  const database = new Database(join(defaultProfile, "Cookies"), { create: true });
  database.run("CREATE TABLE meta (key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)");
  database.run("INSERT INTO meta (key, value) VALUES ('version', '24')");
  database.run(
    "CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT, expires_utc INTEGER, "
      + "samesite INTEGER, encrypted_value BLOB, is_secure INTEGER, is_httponly INTEGER, "
      + "top_frame_site_key TEXT, has_cross_site_ancestor INTEGER)",
  );
  const hostKey = ".example.com";
  const expiry = CHROMIUM_EPOCH_OFFSET_MICROSECONDS
    + BigInt(Math.floor(Date.now() / 1_000) + 3_600) * 1_000_000n;
  database.query(
    "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "sessionid",
    "",
    hostKey,
    "/",
    expiry,
    1,
    encryptMockKeychainCookie(hostKey, "synthetic-managed-session"),
    1,
    1,
    "",
    1,
  );
  database.close();
  chmodSync(join(defaultProfile, "Cookies"), 0o600);

  return {
    auth: {
      schemaVersion: 1,
      id: "managed-cookie-test",
      kind: "browser-profile",
      profile,
      trustUnfilteredEgress: true,
      cookieSource: "chrome",
      cookieProfile: defaultProfile,
    },
    cleanup: () => {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("managed Chromium web-session cookies", () => {
  test("decrypts only an exact ready Wrench derivation profile with the fixed mock keychain", async () => {
    const fixture = managedProfileFixture();
    let fallbackCalls = 0;
    const fallback: CookieRecordReader = () => {
      fallbackCalls += 1;
      return Promise.reject(new Error("fallback must not run"));
    };
    try {
      const result = await acquireWebSessionCookieRecords(
        fixture.auth,
        new URL("https://www.example.com/"),
        5_000,
        fallback,
      );
      expect(result.cookies).toEqual([{
        name: "sessionid",
        value: "synthetic-managed-session",
        domain: "example.com",
        hostOnly: false,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expires: expect.any(Number),
      }]);
      expect(result.warnings).toEqual([]);
      expect(fallbackCalls).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test("does not apply the mock keychain to a caller-selected profile layout", async () => {
    const fixture = managedProfileFixture();
    let selection: Parameters<CookieRecordReader>[0] | null = null;
    const fallback: CookieRecordReader = (value) => {
      selection = value;
      return Promise.resolve({ cookies: [], warnings: [] });
    };
    try {
      const auth = {
        ...fixture.auth,
        cookieProfile: fixture.auth.kind === "browser-profile"
          ? fixture.auth.profile
          : "unreachable",
      };
      await acquireWebSessionCookieRecords(
        auth,
        new URL("https://www.example.com/"),
        5_000,
        fallback,
      );
      expect(selection).toMatchObject({
        cookieSources: ["chrome"],
        cookieProfile: auth.cookieProfile,
        requireExplicitCookieScope: true,
      });
    } finally {
      fixture.cleanup();
    }
  });
});
