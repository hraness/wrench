import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  canonicalLinkedDeviceStorePath,
  createAuth,
  linkedDeviceRealmKey,
  listAuth,
  loadAuth,
  loadAuthSnapshot,
  parseAuth,
  removeAuth,
  replaceAuthIfUnchanged,
  saveAuth,
} from "./auth";
import { discardDerivation } from "./derive";
import {
  createLinkedDeviceLifecycleJournal,
  createLinkedDeviceLifecycleOwner,
  initialLinkedDeviceLifecycleJournal,
  updateLinkedDeviceLifecycleJournal,
} from "./linked-device-lifecycle-journal";
import { canonicalJson, type WrenchManifest } from "./model";
import {
  providerPluginPackageRoot,
  providerPluginRepositoryRoot,
} from "./provider-plugin";
import { providerPluginRegistry } from "./provider-plugins";
import {
  readSessionSecret,
  writeSessionSecret,
} from "./session-secrets";
import {
  createPrivateJsonIfAbsent,
  installManifest as installManifestWithRegistry,
  listPrivateStateDirectory,
  listInstalledManifests as listInstalledManifestsWithRegistry,
  loadInstalledManifest as loadInstalledManifestWithRegistry,
  loadInstalledManifestSnapshot as loadInstalledManifestSnapshotWithRegistry,
  readJsonFile,
  readRegularFile,
  removeInstalledManifest,
  removePrivateStateFile,
  wrenchStateHome,
  writePrivateJson,
} from "./storage";

const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;

const installManifest = (
  manifest: Parameters<typeof installManifestWithRegistry>[0],
  options: Parameters<typeof installManifestWithRegistry>[1],
) => installManifestWithRegistry(manifest, {
  ...options,
  registry: options.registry ?? providerPluginRegistry,
});
const listInstalledManifests = (
  environment: Readonly<Record<string, string | undefined>>,
) => listInstalledManifestsWithRegistry(environment, providerPluginRegistry);
const loadInstalledManifest = (
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
) => loadInstalledManifestWithRegistry(
  id,
  environment,
  providerPluginRegistry,
);
const loadInstalledManifestSnapshot = (
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
) => loadInstalledManifestSnapshotWithRegistry(
  id,
  environment,
  providerPluginRegistry,
);

function state(): { readonly directory: string; readonly environment: Readonly<Record<string, string | undefined>> } {
  const directory = mkdtempSync(join(tmpdir(), "wrench-storage-test-"));
  chmodSync(directory, 0o700);
  return { directory, environment: { WRENCH_STATE_HOME: directory } };
}

const manifest: WrenchManifest = {
  schemaVersion: 1,
  id: "example",
  version: "1.0.0",
  displayName: "Example",
  origins: ["https://example.com"],
  browserDomains: ["example.com"],
  operations: {},
};

describe("auth locators", () => {
  test("binds linked-device aliases to one canonical physical realm key", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-linked-realm-key-test-"));
    try {
      const physical = join(root, "physical");
      const alias = join(root, "alias");
      mkdirSync(physical);
      symlinkSync(physical, alias);
      const direct = createAuth("direct", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: join(physical, "store"),
      });
      const linked = createAuth("linked", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: join(alias, "store"),
      });
      if (
        direct.kind !== "linked-device-store"
        || linked.kind !== "linked-device-store"
      ) throw new Error("linked-device realm fixture is malformed");
      expect(linked.path).toBe(join(realpathSync(physical), "store"));
      expect(canonicalLinkedDeviceStorePath(linked.path))
        .toBe(join(realpathSync(physical), "store"));
      expect(linkedDeviceRealmKey(linked)).toBe(linkedDeviceRealmKey(direct));
      expect(linkedDeviceRealmKey(linked)).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists one stable linked-device coordinate and rejects unresolved aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-linked-realm-stability-test-"));
    try {
      const store = join(realpathSync(root), "store");
      mkdirSync(store, { mode: 0o700 });
      const auth = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: store,
      });
      if (auth.kind !== "linked-device-store") {
        throw new Error("linked-device realm fixture is malformed");
      }
      const before = linkedDeviceRealmKey(auth);
      renameSync(store, `${store}.old`);
      mkdirSync(store, { mode: 0o700 });
      expect(linkedDeviceRealmKey(auth)).toBe(before);
      expect(() => parseAuth({
        ...auth,
        path: `${store}.old`,
      })).toThrow("does not match");
      expect(() => parseAuth({
        ...auth,
        realmKey: "f".repeat(64),
      })).toThrow("does not match");

      const dangling = join(root, "dangling");
      symlinkSync(join(root, "missing-target"), dangling);
      expect(() => createAuth("dangling", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: dangling,
      })).toThrow("unresolved symbolic link");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads and preserves a legacy linked-device locator without a stored realm key", () => {
    const outer = mkdtempSync(join(tmpdir(), "wrench-legacy-linked-auth-test-"));
    chmodSync(outer, 0o700);
    const environment = { WRENCH_STATE_HOME: join(outer, "state") };
    const store = join(outer, "device-store");
    mkdirSync(store, { mode: 0o700 });
    const legacy = {
      schemaVersion: 1 as const,
      id: "legacy-linked",
      kind: "linked-device-store" as const,
      provider: "whatsapp" as const,
      // The original schema-v1 writer used path.resolve rather than realpath.
      path: resolve(store),
    };
    try {
      const path = join(wrenchStateHome(environment), "auth", "legacy-linked.json");
      writePrivateJson(path, legacy, { privateParent: true });

      const snapshot = loadAuthSnapshot("legacy-linked", environment);
      expect(snapshot.auth).toEqual(legacy);
      if (snapshot.auth.kind !== "linked-device-store") {
        throw new Error("legacy linked-device auth fixture is malformed");
      }
      const replacement = createAuth("replacement", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: store,
      });
      if (replacement.kind !== "linked-device-store") {
        throw new Error("replacement linked-device auth fixture is malformed");
      }
      expect(linkedDeviceRealmKey(snapshot.auth)).toBe(
        linkedDeviceRealmKey(replacement),
      );

      saveAuth(snapshot.auth, environment);
      expect(readFileSync(path, "utf8")).toBe(`${canonicalJson(legacy)}\n`);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "loads, lists, and preserves legacy /tmp and /var compatibility aliases",
    () => {
      const outer = mkdtempSync(
        join(tmpdir(), "wrench-legacy-linked-alias-auth-test-"),
      );
      chmodSync(outer, 0o700);
      const environment = { WRENCH_STATE_HOME: join(outer, "state") };
      const suffix = `wrench-legacy-device-${randomUUID()}`;
      const aliases = [
        {
          id: "legacy-tmp",
          path: resolve("/tmp", suffix),
          canonicalPath: resolve(realpathSync("/tmp"), suffix),
        },
        {
          id: "legacy-var",
          path: resolve("/var/tmp", suffix),
          canonicalPath: resolve(realpathSync("/var"), "tmp", suffix),
        },
      ] as const;
      try {
        for (const alias of aliases) {
          expect(alias.path).not.toBe(alias.canonicalPath);
          const legacy = {
            schemaVersion: 1 as const,
            id: alias.id,
            kind: "linked-device-store" as const,
            provider: "whatsapp" as const,
            path: alias.path,
          };
          const path = join(
            wrenchStateHome(environment),
            "auth",
            `${alias.id}.json`,
          );
          writePrivateJson(path, legacy, { privateParent: true });

          const loaded = loadAuth(alias.id, environment);
          expect(loaded).toEqual(legacy);
          if (loaded.kind !== "linked-device-store") {
            throw new Error("legacy linked-device auth fixture is malformed");
          }
          const canonical = createAuth(`${alias.id}-canonical`, {
            linkedDeviceProvider: "whatsapp",
            deviceStore: alias.canonicalPath,
          });
          if (canonical.kind !== "linked-device-store") {
            throw new Error("canonical linked-device auth fixture is malformed");
          }
          expect(linkedDeviceRealmKey(loaded)).toBe(
            linkedDeviceRealmKey(canonical),
          );

          saveAuth(loaded, environment);
          expect(readFileSync(path, "utf8")).toBe(
            `${canonicalJson(legacy)}\n`,
          );
        }

        const listed = new Map(
          listAuth(environment).map((auth) => [auth.id, auth]),
        );
        for (const alias of aliases) {
          expect(listed.get(alias.id)).toEqual({
            schemaVersion: 1,
            id: alias.id,
            kind: "linked-device-store",
            provider: "whatsapp",
            path: alias.path,
          });
        }
      } finally {
        rmSync(outer, { recursive: true, force: true });
      }
    },
  );

  test("requires an explicit browser-profile egress acknowledgement", () => {
    expect(() => createAuth("example", {
      browserProfile: "Work",
      trustUnfilteredEgress: false,
    })).toThrow("--trust-profile-egress");
    expect(createAuth("example", {
      browserProfile: "Work",
      trustUnfilteredEgress: true,
    })).toEqual({
      schemaVersion: 1,
      id: "example",
      kind: "browser-profile",
      profile: "Work",
      trustUnfilteredEgress: true,
    });
  });

  test("creates and parses a browser profile with optional target-filtered cookie seeding", () => {
    const hybrid = createAuth("arc-main", {
      browserProfile: "/private/browser/Arc/User Data/Profile 1",
      browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      trustUnfilteredEgress: true,
      cookieSource: "arc",
      cookieProfile: "Profile 1",
      subject: "urn:li:person:viewer-1",
    });
    expect(hybrid).toEqual({
      schemaVersion: 1,
      id: "arc-main",
      kind: "browser-profile",
      profile: "/private/browser/Arc/User Data/Profile 1",
      browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      trustUnfilteredEgress: true,
      cookieSource: "arc",
      cookieProfile: "Profile 1",
      subject: "urn:li:person:viewer-1",
    });
    expect(parseAuth(hybrid)).toEqual(hybrid);
    expect(parseAuth({
      schemaVersion: 1,
      id: "legacy-profile",
      kind: "browser-profile",
      profile: "Work",
      trustUnfilteredEgress: true,
    })).toEqual({
      schemaVersion: 1,
      id: "legacy-profile",
      kind: "browser-profile",
      profile: "Work",
      trustUnfilteredEgress: true,
    });
    expect(() => createAuth("arc-main", {
      browserProfile: "Work",
      trustUnfilteredEgress: true,
      cookieProfile: "Profile 1",
    })).toThrow("requires a valid cookie source");
    expect(() => parseAuth({
      ...hybrid,
      browserExecutable: "relative/browser",
    })).toThrow("invalid browser executable");
  });

  test("binds every cookie-capable locator to an optional non-secret subject while accepting legacy records", () => {
    const bound = [
      createAuth("arc-bound", { source: "arc", profile: "Profile 1", subject: "ACoAA-viewer_1" }),
      createAuth("file-bound", { cookiesFile: "/private/cookies.json", subject: "2244994945" }),
      createAuth("profile-bound", {
        browserProfile: "Work",
        trustUnfilteredEgress: true,
        subject: "urn:li:person:viewer-1",
      }),
    ];
    for (const auth of bound) expect(parseAuth(auth)).toEqual(auth);

    expect(parseAuth({
      schemaVersion: 1,
      id: "legacy-source",
      kind: "cookie-source",
      source: "chrome",
    })).toEqual({
      schemaVersion: 1,
      id: "legacy-source",
      kind: "cookie-source",
      source: "chrome",
    });
    expect(parseAuth({
      schemaVersion: 1,
      id: "legacy-file",
      kind: "cookies-file",
      path: "/private/cookies.json",
    })).toEqual({
      schemaVersion: 1,
      id: "legacy-file",
      kind: "cookies-file",
      path: "/private/cookies.json",
    });
  });

  test("rejects unsafe subjects for every auth locator kind", () => {
    expect(() => createAuth("source", { source: "chrome", subject: "viewer\nspoofed" })).toThrow("invalid subject");
    expect(() => createAuth("file", { cookiesFile: "/private/cookies.json", subject: " viewer" })).toThrow("invalid subject");
    expect(() => createAuth("profile", {
      browserProfile: "Work",
      trustUnfilteredEgress: true,
      subject: "viewer name",
    })).toThrow("invalid subject");
  });

  test("canonicalizes path-like locators so future working directories cannot retarget them", () => {
    expect(createAuth("relative-profile", {
      browserProfile: "./private-profiles/work",
      trustUnfilteredEgress: true,
    })).toMatchObject({ profile: resolve("./private-profiles/work") });
    expect(createAuth("relative-cookies", { cookiesFile: "./private-cookies.json" }))
      .toMatchObject({ path: resolve("./private-cookies.json") });
    expect(createAuth("relative-cookie-profile", { source: "safari", profile: "./Cookies.binarycookies" }))
      .toMatchObject({ profile: resolve("./Cookies.binarycookies") });
    expect(() => parseAuth({
      schemaVersion: 1,
      id: "legacy-relative",
      kind: "browser-profile",
      profile: "./moves-with-cwd",
      trustUnfilteredEgress: true,
    })).toThrow("must be absolute");
  });

  test("creates a canonical secret-free OAuth token-file locator", () => {
    const auth = createAuth("linkedin-api", {
      oauthProvider: "linkedin",
      tokenFile: "./private-provider-token",
      scopes: ["w_member_social", "openid", "profile"],
      subject: "urn:li:person:abc-123",
    });
    expect(auth).toEqual({
      schemaVersion: 1,
      id: "linkedin-api",
      kind: "oauth-token-file",
      provider: "linkedin",
      path: resolve("./private-provider-token"),
      scopes: ["openid", "profile", "w_member_social"],
      subject: "urn:li:person:abc-123",
    });
    expect(parseAuth(auth)).toEqual(auth);
  });

  test("round-trips non-built-in OAuth and linked-device provider realms without requiring an installed plugin", () => {
    const oauth = createAuth("mastodon-api", {
      oauthProvider: "mastodon",
      tokenFile: "/private/mastodon-token",
      scopes: ["read", "write:statuses"],
      subject: "acct:viewer@example.social",
    });
    const linkedDevice = createAuth("signal-main", {
      linkedDeviceProvider: "signal",
      deviceStore: "/private/signal-device",
      subject: "signal:viewer",
    });

    expect(parseAuth(oauth)).toEqual(oauth);
    expect(parseAuth(linkedDevice)).toEqual(linkedDevice);
    expect(oauth).toMatchObject({ kind: "oauth-token-file", provider: "mastodon" });
    expect(linkedDevice).toMatchObject({
      kind: "linked-device-store",
      provider: "signal",
    });
  });

  test("OAuth token-file records persist and list without reading or embedding the token", () => {
    const testState = state();
    const absentTokenPath = join(testState.directory, "token-does-not-exist");
    try {
      const path = saveAuth(createAuth("x-api", {
        oauthProvider: "x",
        tokenFile: absentTokenPath,
        scopes: ["users.read", "tweet.read"],
        subject: "2244994945",
      }), testState.environment);
      writeFileSync(absentTokenPath, "not-a-real-access-token\n", { mode: 0o000 });
      expect(listAuth(testState.environment)).toEqual([{
        schemaVersion: 1,
        id: "x-api",
        kind: "oauth-token-file",
        provider: "x",
        path: absentTokenPath,
        scopes: ["tweet.read", "users.read"],
        subject: "2244994945",
      }]);
      expect(readFileSync(path, "utf8")).not.toContain("not-a-real-access-token");
      expect(existsSync(absentTokenPath)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "malformed OAuth provider",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "Facebook.com",
        path: "/private/token",
        scopes: ["posts.read"],
      },
    },
    {
      label: "overlong OAuth provider",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: `a${"b".repeat(63)}`,
        path: "/private/token",
        scopes: ["posts.read"],
      },
    },
    {
      label: "malformed linked-device provider",
      value: {
        schemaVersion: 1,
        id: "device",
        kind: "linked-device-store",
        provider: "signal.device",
        path: "/private/device",
      },
    },
    {
      label: "relative OAuth token path",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "token.txt",
        scopes: ["tweet.read"],
      },
    },
    {
      label: "directionally unsafe OAuth token path",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/\u202etoken",
        scopes: ["tweet.read"],
      },
    },
    {
      label: "empty OAuth scopes",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/token",
        scopes: [],
      },
    },
    {
      label: "blank OAuth scope",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/token",
        scopes: [""],
      },
    },
    {
      label: "duplicate OAuth scopes",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/token",
        scopes: ["tweet.read", "tweet.read"],
      },
    },
    {
      label: "unsorted OAuth scopes",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/token",
        scopes: ["users.read", "tweet.read"],
      },
    },
    {
      label: "OAuth scope containing whitespace",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/token",
        scopes: ["tweet read"],
      },
    },
    {
      label: "unsafe OAuth subject",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "linkedin",
        path: "/private/token",
        scopes: ["openid"],
        subject: "urn:li:person:abc\nspoofed",
      },
    },
    {
      label: "embedded OAuth secret field",
      value: {
        schemaVersion: 1,
        id: "api",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/token",
        scopes: ["tweet.read"],
        accessToken: "secret",
      },
    },
  ])("rejects $label", ({ value }) => {
    expect(() => parseAuth(value)).toThrow();
  });

  test("rejects duplicate scopes and unsafe subjects before creating an OAuth locator", () => {
    expect(() => createAuth("x-api", {
      oauthProvider: "x",
      tokenFile: "/private/token",
      scopes: ["tweet.read", "tweet.read"],
    })).toThrow("duplicates");
    expect(() => createAuth("linkedin-api", {
      oauthProvider: "linkedin",
      tokenFile: "/private/token",
      scopes: ["openid"],
      subject: " urn:li:person:abc",
    })).toThrow("subject");
    expect(() => createAuth("invalid-provider", {
      oauthProvider: "../mastodon",
      tokenFile: "/private/token",
      scopes: ["read"],
    })).toThrow("invalid provider");
    expect(() => createAuth("invalid-device", {
      linkedDeviceProvider: "Signal",
      deviceStore: "/private/device",
    })).toThrow("invalid provider");
  });

  test.each([
    {
      label: "unknown cookie field",
      value: { schemaVersion: 1, id: "example", kind: "cookie-source", source: "chrome", token: "secret" },
    },
    {
      label: "unsafe cookie subject",
      value: { schemaVersion: 1, id: "example", kind: "cookie-source", source: "chrome", subject: "viewer\nspoofed" },
    },
    {
      label: "unknown profile field",
      value: { schemaVersion: 1, id: "example", kind: "browser-profile", profile: "Work", trustUnfilteredEgress: true, token: "secret" },
    },
    {
      label: "missing profile trust",
      value: { schemaVersion: 1, id: "example", kind: "browser-profile", profile: "Work", trustUnfilteredEgress: false },
    },
    {
      label: "hybrid profile name without source",
      value: {
        schemaVersion: 1,
        id: "example",
        kind: "browser-profile",
        profile: "Work",
        trustUnfilteredEgress: true,
        cookieProfile: "Profile 1",
      },
    },
    {
      label: "control character",
      value: { schemaVersion: 1, id: "example", kind: "cookies-file", path: "cookies\u0000.json" },
    },
    {
      label: "invalid ID",
      value: { schemaVersion: 1, id: "../escape", kind: "cookie-source", source: "chrome" },
    },
    {
      label: "unsupported source",
      value: { schemaVersion: 1, id: "example", kind: "cookie-source", source: "unknown-browser" },
    },
  ])("rejects $label", ({ value }) => {
    expect(() => parseAuth(value)).toThrow();
  });

  test("persists only a secret-free locator with private modes", () => {
    const testState = state();
    try {
      const path = saveAuth(createAuth("example", {
        source: "chrome",
        profile: "Profile 9",
        subject: "urn:li:person:viewer-9",
      }), testState.environment);
      expect(loadAuth("example", testState.environment)).toEqual({
        schemaVersion: 1,
        id: "example",
        kind: "cookie-source",
        source: "chrome",
        profile: "Profile 9",
        subject: "urn:li:person:viewer-9",
      });
      expect(lstatSync(join(testState.directory, "auth")).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).not.toMatch(/authorization|bearer|password|token/i);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("snapshots and conditionally replaces exact canonical auth bytes", () => {
    const testState = state();
    try {
      const initial = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: "/private/wrench-whatsapp-store",
      });
      const path = saveAuth(initial, testState.environment);
      const current = loadAuthSnapshot(
        "whatsapp-main",
        testState.environment,
      );
      const exact = readFileSync(path);
      expect(current.contentSha256).toBe(
        createHash("sha256").update(exact).digest("hex"),
      );
      expect(current.contentSha256).not.toBe(
        createHash("sha256")
          .update(canonicalJson(initial), "utf8")
          .digest("hex"),
      );

      const replacement = {
        ...initial,
        subject: "whatsapp:pn:15551234567",
      };
      const result = replaceAuthIfUnchanged(
        current,
        replacement,
        testState.environment,
      );
      expect(result.replaced).toBeTrue();
      if (!result.replaced) throw new Error("auth replacement was lost");
      expect(result.snapshot.auth).toEqual(replacement);
      expect(result.snapshot.contentSha256).toBe(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      );
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects noncanonical auth bytes and preserves a concurrent winner", () => {
    const testState = state();
    try {
      const initial = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: "/private/wrench-whatsapp-store",
      });
      const path = saveAuth(initial, testState.environment);
      const variants = [
        `${canonicalJson(initial)}`,
        `${canonicalJson(initial)}\r\n`,
        `${canonicalJson(initial)}\n\n`,
        `\uFEFF${canonicalJson(initial)}\n`,
        `${JSON.stringify(initial, null, 2)}\n`,
        `{"schemaVersion":1,"kind":"linked-device-store","id":"whatsapp-main","provider":"whatsapp","path":"/private/wrench-whatsapp-store"}\n`,
      ];
      for (const variant of variants) {
        writeFileSync(path, variant, { mode: 0o600 });
        expect(() =>
          loadAuthSnapshot("whatsapp-main", testState.environment))
          .toThrow();
      }

      writeFileSync(path, `${canonicalJson(initial)}\n`, { mode: 0o600 });
      const stale = loadAuthSnapshot(
        "whatsapp-main",
        testState.environment,
      );
      const winner = {
        ...initial,
        subject: "whatsapp:pn:15550000000",
      };
      saveAuth(winner, testState.environment, { force: true });
      expect(replaceAuthIfUnchanged(
        stale,
        {
          ...initial,
          subject: "whatsapp:pn:15551234567",
        },
        testState.environment,
      )).toEqual({ replaced: false });
      expect(loadAuth("whatsapp-main", testState.environment)).toEqual(winner);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("does not reuse an auth ID whose prior physical realm is unresolved", () => {
    const testState = state();
    const deviceRoot = mkdtempSync(
      join(tmpdir(), "wrench-linked-auth-id-reuse-test-"),
    );
    try {
      const firstStore = join(deviceRoot, "first-device-store");
      const secondStore = join(deviceRoot, "second-device-store");
      mkdirSync(firstStore, { mode: 0o700 });
      mkdirSync(secondStore, { mode: 0o700 });
      const first = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: firstStore,
      });
      if (first.kind !== "linked-device-store") {
        throw new Error("linked-device auth fixture is malformed");
      }
      saveAuth(first, testState.environment);
      const authSnapshot = loadAuthSnapshot(
        first.id,
        testState.environment,
      );
      const owner = createLinkedDeviceLifecycleOwner(
        "2099-07-25T13:00:00.000Z",
      );
      let journal = createLinkedDeviceLifecycleJournal(
        initialLinkedDeviceLifecycleJournal({
          journalId: "30000000-0000-4000-8000-000000000003",
          kind: "pair",
          pluginId: "whatsapp-web",
          pluginVersion: "1.0.0",
          pluginImplementationHash: "a".repeat(64),
          lifecycleContractVersion: 1,
          surfaceId: "whatsapp",
          authId: first.id,
          authRealmHash: linkedDeviceRealmKey(first),
          authContentHash: authSnapshot.contentSha256,
          initialSubjectState: "unbound",
          phoneProvided: false,
          owner,
          startedAt: "2026-07-25T12:00:00.000Z",
        }),
        testState.environment,
      );
      journal = updateLinkedDeviceLifecycleJournal(journal, {
        type: "external-begin",
        at: "2026-07-25T12:00:01.000Z",
      }, { owner, environment: testState.environment });
      updateLinkedDeviceLifecycleJournal(journal, {
        type: "outcome-not-durable",
        reasonCode: "runtime-error-after-begin",
        at: "2026-07-25T12:00:02.000Z",
      }, { owner, environment: testState.environment });

      rmSync(
        join(testState.directory, "auth", `${first.id}.json`),
      );
      const replacement = createAuth("whatsapp-main", {
        linkedDeviceProvider: "whatsapp",
        deviceStore: secondStore,
      });
      expect(() => saveAuth(replacement, testState.environment))
        .toThrow("active or unreconciled linked-device lifecycle");
      expect(() => saveAuth(createAuth("whatsapp-main", {
        oauthProvider: "whatsapp",
        tokenFile: join(deviceRoot, "token.json"),
        scopes: ["messages.read"],
      }), testState.environment))
        .toThrow("active or unreconciled linked-device lifecycle");
      expect(existsSync(
        join(testState.directory, "auth", `${first.id}.json`),
      )).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
      rmSync(deviceRoot, { recursive: true, force: true });
    }
  });

  test("keeps auth realm IDs stable unless replacement is explicit", () => {
    const testState = state();
    try {
      const chrome = createAuth("personal", { source: "chrome", profile: "Profile 1" });
      const arc = createAuth("personal", { source: "arc", profile: "Default" });
      const path = saveAuth(chrome, testState.environment);

      expect(saveAuth(chrome, testState.environment)).toBe(path);
      expect(() => saveAuth(arc, testState.environment)).toThrow("different access realm");
      expect(loadAuth("personal", testState.environment)).toEqual(chrome);

      expect(saveAuth(arc, testState.environment, { force: true })).toBe(path);
      expect(loadAuth("personal", testState.environment)).toEqual(arc);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("treats hybrid cookie selection as part of the guarded access realm", () => {
    const testState = state();
    try {
      const profileOnly = createAuth("arc-main", {
        browserProfile: "Work",
        trustUnfilteredEgress: true,
      });
      const hybrid = createAuth("arc-main", {
        browserProfile: "Work",
        trustUnfilteredEgress: true,
        cookieSource: "arc",
        cookieProfile: "Profile 1",
      });
      saveAuth(profileOnly, testState.environment);
      expect(() => saveAuth(hybrid, testState.environment)).toThrow("different access realm");
      expect(loadAuth("arc-main", testState.environment)).toEqual(profileOnly);
      saveAuth(hybrid, testState.environment, { force: true });
      expect(loadAuth("arc-main", testState.environment)).toEqual(hybrid);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses symlinked auth records and filename/record mismatches", () => {
    const testState = state();
    try {
      const path = saveAuth(createAuth("other", { source: "chrome" }), testState.environment);
      const linked = join(testState.directory, "auth", "example.json");
      symlinkSync(path, linked);
      expect(() => loadAuth("example", testState.environment)).toThrow("symbolic link");
      rmSync(linked);
      writePrivateJson(linked, { schemaVersion: 1, id: "other", kind: "cookie-source", source: "chrome" });
      expect(() => loadAuth("example", testState.environment)).toThrow("does not match its filename");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("lists valid auth deterministically, skips malformed records, and removes only the locator", () => {
    const testState = state();
    try {
      saveAuth(createAuth("zulu", { source: "firefox" }), testState.environment);
      saveAuth(createAuth("alpha", { cookiesFile: "/tmp/cookies.json" }), testState.environment);
      writePrivateJson(join(testState.directory, "auth", "broken.json"), { broken: true });

      expect(listAuth(testState.environment).map((entry) => entry.id)).toEqual(["alpha", "zulu"]);
      expect(removeAuth("alpha", testState.environment)).toBeTrue();
      expect(removeAuth("alpha", testState.environment)).toBeFalse();
      expect(listAuth(testState.environment).map((entry) => entry.id)).toEqual(["zulu"]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("removes auth-bound browser session caches with the locator", () => {
    const testState = state();
    try {
      const auth = createAuth("linkedin-main", { source: "arc", profile: "Profile 1" });
      saveAuth(auth, testState.environment);
      const authHash = "a".repeat(64);
      writeSessionSecret(
        "linkedin-cookie-rotation",
        auth.id,
        authHash,
        { private: "edge-cookie-cache" },
        testState.environment,
      );
      writeSessionSecret(
        "bluesky",
        auth.id,
        authHash,
        { private: "session-cache" },
        testState.environment,
      );

      expect(removeAuth(auth.id, testState.environment)).toBeTrue();
      expect(readSessionSecret(
        "linkedin-cookie-rotation",
        auth.id,
        authHash,
        testState.environment,
      )).toBeNull();
      expect(readSessionSecret(
        "bluesky",
        auth.id,
        authHash,
        testState.environment,
      )).toBeNull();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("private state storage", () => {
  test("recovers only definitely orphaned state-write temporaries after SIGKILL", async () => {
    const testState = state();
    const stateRoot = wrenchStateHome(testState.environment);
    const plans = join(stateRoot, "plans");
    let child: ReturnType<typeof Bun.spawn> | null = null;
    try {
      writePrivateJson(
        join(plans, "bootstrap.json"),
        { ready: true },
        { privateParent: true },
      );
      const identity = (path: string) => {
        const stats = lstatSync(path, { bigint: true });
        return {
          device: stats.dev.toString(),
          inode: stats.ino.toString(),
        };
      };
      const helper = join(import.meta.dir, "state-helper.ts");
      const config = join(import.meta.dir, "state-helper.bunfig.toml");
      const spawned = Bun.spawn([
        process.execPath,
        "--no-env-file",
        "--no-install",
        "--no-macros",
        "--no-addons",
        `--config=${config}`,
        helper,
      ], {
        cwd: stateRoot,
        env: {
          NODE_ENV: "test",
          WRENCH_TEST_WRITE_TEMP_FAULT: "pause-after-temp-fsync",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child = spawned;
      await spawned.stdin.write(JSON.stringify({
        schemaVersion: 1,
        requestId: randomUUID(),
        expected: identity(stateRoot),
        operation: {
          kind: "write-file",
          segments: ["plans", "target.json"],
          directoryExpectations: [identity(plans)],
          content: "{\"published\":false}\n",
          createOnly: false,
          expectedContentSha256: null,
        },
      }));
      await spawned.stdin.end();
      let staleName: string | undefined;
      const readyDeadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
      while (performance.now() < readyDeadline) {
        staleName = readdirSync(plans).find((name) =>
          name.startsWith(`.io-write-${spawned.pid}-`));
        if (staleName !== undefined) break;
        await Bun.sleep(10);
      }
      expect(staleName).toBeDefined();
      spawned.kill("SIGKILL");
      await spawned.exited;

      const liveName =
        `.io-write-${process.pid}-22222222-2222-4222-8222-222222222222.tmp`;
      writeFileSync(join(plans, liveName), "live", { mode: 0o600 });
      const entries = listPrivateStateDirectory(
        plans,
        testState.environment,
      );
      expect(entries.map((entry) => entry.name)).toContain(liveName);
      expect(readdirSync(plans)).not.toContain(staleName as string);
      expect(existsSync(join(plans, "target.json"))).toBeFalse();
    } finally {
      child?.kill("SIGKILL");
      if (child !== null) await child.exited;
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test.each([
    { label: "filesystem root", path: "/" },
    { label: "shared temporary root", path: tmpdir() },
    { label: "repository root", path: providerPluginRepositoryRoot },
    { label: "repository subdirectory", path: join(providerPluginRepositoryRoot, "skills") },
    { label: "missing source-package child", path: join(providerPluginPackageRoot, ".forbidden-wrench-state") },
    { label: "system usr directory", path: "/usr" },
    { label: "system configuration directory", path: "/etc" },
    { label: "system variable-data directory", path: "/var" },
    { label: "system optional-software directory", path: "/opt" },
    { label: "shared users directory", path: "/Users/Shared" },
  ])("rejects a broad $label without creating or changing it", ({ path }) => {
    const existedBefore = existsSync(path);
    const modeBefore = existedBefore ? lstatSync(path).mode & 0o777 : null;
    expect(() => wrenchStateHome({ WRENCH_STATE_HOME: path })).toThrow("WRENCH_STATE_HOME");
    expect(existsSync(path)).toBe(existedBefore);
    if (modeBefore !== null) expect(lstatSync(path).mode & 0o777).toBe(modeBefore);
  });

  test("defaults new state to Wrench while continuing either lone legacy state root", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "wrench-state-default-test-"));
    try {
      const fresh = wrenchStateHome({ XDG_DATA_HOME: dataRoot });
      expect(fresh).toBe(join(realpathSync(dataRoot), "wrench"));

      for (const name of ["oh", "io"] as const) {
        const legacy = join(dataRoot, name);
        mkdirSync(legacy, { mode: 0o700 });
        expect(wrenchStateHome({ XDG_DATA_HOME: dataRoot })).toBe(realpathSync(legacy));
        rmSync(legacy, { recursive: true });
      }
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("recognizes populated unmarked predecessor state roots without rewriting them", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "wrench-populated-legacy-state-test-"));
    try {
      for (const name of ["oh", "io"] as const) {
        const legacy = join(dataRoot, name);
        const plans = join(legacy, "plans");
        mkdirSync(plans, { recursive: true, mode: 0o700 });
        writeFileSync(join(plans, "legacy.json"), '{"legacy":true}\n', { mode: 0o600 });

        expect(wrenchStateHome({ XDG_DATA_HOME: dataRoot })).toBe(realpathSync(legacy));
        expect(existsSync(join(legacy, ".io-state.json"))).toBeFalse();
        expect(readFileSync(join(plans, "legacy.json"), "utf8")).toBe('{"legacy":true}\n');

        rmSync(legacy, { recursive: true });
      }
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when implicit old and new state roots coexist", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "wrench-state-conflict-test-"));
    try {
      mkdirSync(join(dataRoot, "wrench"), { mode: 0o700 });
      mkdirSync(join(dataRoot, "oh"), { mode: 0o700 });
      expect(() => wrenchStateHome({ XDG_DATA_HOME: dataRoot }))
        .toThrow("multiple Wrench and legacy state roots exist");
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("accepts matching predecessor overrides and rejects every divergence", () => {
    const outer = mkdtempSync(join(tmpdir(), "wrench-state-override-test-"));
    const selected = join(outer, "selected");
    const other = join(outer, "other");
    try {
      expect(wrenchStateHome({
        WRENCH_STATE_HOME: selected,
        OH_STATE_HOME: selected,
        IO_HOME: selected,
      }))
        .toBe(join(realpathSync(outer), "selected"));
      expect(() => wrenchStateHome({ WRENCH_STATE_HOME: selected, OH_STATE_HOME: other }))
        .toThrow("select different state roots");
      expect(() => wrenchStateHome({ OH_STATE_HOME: selected, IO_HOME: other }))
        .toThrow("select different state roots");
      expect(wrenchStateHome({ OH_STATE_HOME: selected })).toBe(
        join(realpathSync(outer), "selected"),
      );
      expect(wrenchStateHome({ IO_HOME: selected })).toBe(
        join(realpathSync(outer), "selected"),
      );
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("claims a recognizable dedicated root with a private ownership marker", () => {
    const testState = state();
    try {
      writePrivateJson(join(wrenchStateHome(testState.environment), "plans", "claim.json"), { claimed: true }, { privateParent: true });
      const marker = join(testState.directory, ".io-state.json");
      expect(lstatSync(marker).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ schemaVersion: 1, kind: "io-state" });
      expect(wrenchStateHome(testState.environment)).toBe(realpathSync(testState.directory));
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("binds a validated root identity before mutating state", () => {
    const outer = mkdtempSync(join(tmpdir(), "wrench-root-swap-test-"));
    const root = join(outer, "io-state");
    const moved = join(outer, "original-state");
    mkdirSync(root, { mode: 0o700 });
    const environment = { WRENCH_STATE_HOME: root } as const;
    try {
      const validatedRoot = wrenchStateHome(environment);
      expect(validatedRoot).toBe(realpathSync(root));
      renameSync(validatedRoot, moved);
      mkdirSync(validatedRoot, { mode: 0o755 });
      writeFileSync(join(validatedRoot, "unrelated-sentinel"), "unchanged\n", { mode: 0o600 });

      expect(() => writePrivateJson(join(validatedRoot, "plans", "claim.json"), { claimed: true }, { privateParent: true }))
        .toThrow("changed identity");
      expect(lstatSync(validatedRoot).mode & 0o777).toBe(0o755);
      expect(readFileSync(join(validatedRoot, "unrelated-sentinel"), "utf8")).toBe("unchanged\n");
      expect(existsSync(join(validatedRoot, "plans"))).toBeFalse();
      expect(existsSync(join(validatedRoot, ".io-state.json"))).toBeFalse();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("binds the existing ancestor before creating a missing nested root", () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "wrench-root-anchor-test-")));
    const external = join(outer, "external");
    const lateParent = join(outer, "late-parent");
    const root = join(lateParent, "io-state");
    mkdirSync(external, { mode: 0o700 });
    const environment = { WRENCH_STATE_HOME: root } as const;
    try {
      const validatedRoot = wrenchStateHome(environment);
      symlinkSync(external, lateParent);

      expect(() => writePrivateJson(join(validatedRoot, "plans", "claim.json"), { claimed: true }, { privateParent: true }))
        .toThrow("creation path");
      expect(readdirWithoutDot(external)).toEqual([]);
      expect(existsSync(join(external, "io-state"))).toBeFalse();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("binds helper cwd after the final parent-side validation without loading replacement config", () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "wrench-bound-helper-test-")));
    const root = join(outer, "io-state");
    const moved = join(outer, "original-state");
    const replacement = join(outer, "replacement-state");
    const environment = { WRENCH_STATE_HOME: root } as const;
    const originalRandomUUID = crypto.randomUUID.bind(crypto);
    try {
      const validatedRoot = wrenchStateHome(environment);
      writePrivateJson(join(validatedRoot, "plans", "seed.json"), { seed: true }, { privateParent: true });
      mkdirSync(join(replacement, "plans"), { recursive: true, mode: 0o700 });
      writeFileSync(join(replacement, ".io-state.json"), '{"kind":"io-state","schemaVersion":1}\n', { mode: 0o600 });
      writeFileSync(join(replacement, "bunfig.toml"), 'preload = ["./untrusted-preload.ts"]\n', { mode: 0o600 });
      writeFileSync(
        join(replacement, "untrusted-preload.ts"),
        'require("node:fs").writeFileSync("preload-ran", "unsafe");\n',
        { mode: 0o600 },
      );

      let swapped = false;
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: () => {
          if (!swapped) {
            renameSync(validatedRoot, moved);
            renameSync(replacement, validatedRoot);
            swapped = true;
          }
          return originalRandomUUID();
        },
      });

      expect(() => writePrivateJson(join(validatedRoot, "plans", "claim.json"), { claimed: true }, { privateParent: true }))
        .toThrow("changed identity");
      expect(swapped).toBeTrue();
      expect(existsSync(join(validatedRoot, "plans", "claim.json"))).toBeFalse();
      expect(existsSync(join(validatedRoot, "preload-ran"))).toBeFalse();
    } finally {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUUID });
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("binds every validated state descendant before mutating it", () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "wrench-descendant-swap-test-")));
    const root = join(outer, "io-state");
    const movedPlans = join(outer, "original-plans");
    const environment = { WRENCH_STATE_HOME: root } as const;
    const originalRandomUUID = crypto.randomUUID.bind(crypto);
    try {
      const validatedRoot = wrenchStateHome(environment);
      const plans = join(validatedRoot, "plans");
      writePrivateJson(join(plans, "seed.json"), { seed: true }, { privateParent: true });

      let swapped = false;
      Object.defineProperty(crypto, "randomUUID", {
        configurable: true,
        value: () => {
          if (!swapped) {
            renameSync(plans, movedPlans);
            mkdirSync(plans, { mode: 0o700 });
            writeFileSync(join(plans, "unrelated-sentinel"), "unchanged\n", { mode: 0o600 });
            swapped = true;
          }
          return originalRandomUUID();
        },
      });

      expect(() => writePrivateJson(join(plans, "claim.json"), { claimed: true }, { privateParent: true }))
        .toThrow("identity");
      expect(swapped).toBeTrue();
      expect(readFileSync(join(plans, "unrelated-sentinel"), "utf8")).toBe("unchanged\n");
      expect(existsSync(join(plans, "claim.json"))).toBeFalse();
      expect(readJsonFile(join(movedPlans, "seed.json"))).toEqual({ seed: true });
    } finally {
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: originalRandomUUID });
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("fails closed when a claimed root or trusted state ancestor becomes public", () => {
    const testState = state();
    try {
      const path = join(wrenchStateHome(testState.environment), "plans", "claim.json");
      writePrivateJson(path, { claimed: true }, { privateParent: true });

      chmodSync(testState.directory, 0o777);
      expect(() => wrenchStateHome(testState.environment)).toThrow("private");
      expect(lstatSync(testState.directory).mode & 0o777).toBe(0o777);

      chmodSync(testState.directory, 0o700);
      chmodSync(join(testState.directory, "plans"), 0o777);
      expect(() => readJsonFile(path)).toThrow("could not safely open JSON file");
      expect(() => writePrivateJson(join(testState.directory, "plans", "new.json"), { unsafe: false }))
        .toThrow("mode 0700");
      expect(lstatSync(join(testState.directory, "plans")).mode & 0o777).toBe(0o777);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("recovers from an interrupted unpublished marker stage", () => {
    const testState = state();
    try {
      const stage = join(testState.directory, `.io-state.stage-99999999-${crypto.randomUUID()}.json`);
      writeFileSync(stage, "", { mode: 0o600 });
      writePrivateJson(join(wrenchStateHome(testState.environment), "plans", "claim.json"), { claimed: true }, { privateParent: true });
      expect(JSON.parse(readFileSync(join(testState.directory, ".io-state.json"), "utf8")))
        .toEqual({ schemaVersion: 1, kind: "io-state" });
      expect(wrenchStateHome(testState.environment)).toBe(realpathSync(testState.directory));
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects an unmarked unrelated existing directory even when it is user-owned", () => {
    const root = mkdtempSync(join(tmpdir(), "unrelated-state-"));
    try {
      writeFileSync(join(root, "sentinel"), "unchanged\n", { mode: 0o600 });
      expect(() => wrenchStateHome({ WRENCH_STATE_HOME: root })).toThrow("not marked as wrench-owned");
      expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("unchanged\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not infer Wrench ownership from an embedded path substring", () => {
    const outer = mkdtempSync(join(tmpdir(), "unrelated-state-"));
    const root = join(outer, "cohort", "container", "state");
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      writeFileSync(join(root, "sentinel"), "unchanged\n", { mode: 0o600 });

      expect(() => wrenchStateHome({ WRENCH_STATE_HOME: root })).toThrow("not marked as wrench-owned");
      expect(readFileSync(join(root, "sentinel"), "utf8")).toBe("unchanged\n");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("refuses to claim an empty group/world-writable state root", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-public-state-test-"));
    try {
      chmodSync(root, 0o777);
      expect(() => wrenchStateHome({ WRENCH_STATE_HOME: root })).toThrow("group/world-writable");
      expect(lstatSync(root).mode & 0o777).toBe(0o777);
      expect(readdirWithoutDot(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses no-follow bounded regular-file reads", () => {
    const testState = state();
    try {
      const file = join(testState.directory, "value.json");
      writeFileSync(file, '{"ok":true}\n', { mode: 0o600 });
      expect(readRegularFile(file, 100)).toBe('{"ok":true}\n');
      expect(readJsonFile(file)).toEqual({ ok: true });
      expect(() => readRegularFile(file, 3)).toThrow("no larger than 3 bytes");
      expect(() => readRegularFile(testState.directory, 100)).toThrow("regular file");

      const link = join(testState.directory, "linked.json");
      symlinkSync(file, link);
      expect(() => readRegularFile(link, 100)).toThrow("safely open");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("never writes through a symlink parent and atomically replaces a regular file", () => {
    const testState = state();
    try {
      const target = join(testState.directory, "target");
      mkdirSync(target);
      const linkedParent = join(testState.directory, "linked-parent");
      symlinkSync(target, linkedParent);
      expect(() => writePrivateJson(join(linkedParent, "value.json"), { secret: "no" })).toThrow("not a real directory");
      expect(existsSync(join(target, "value.json"))).toBeFalse();

      const output = join(testState.directory, "direct", "value.json");
      writePrivateJson(output, { version: 1 }, { privateParent: true });
      writePrivateJson(output, { version: 2 }, { privateParent: true });
      expect(readJsonFile(output)).toEqual({ version: 2 });
      expect(lstatSync(join(testState.directory, "direct")).mode & 0o777).toBe(0o700);
      expect(lstatSync(output).mode & 0o777).toBe(0o600);
      expect(readdirWithoutDot(join(testState.directory, "direct"))).toEqual(["value.json"]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("atomically creates private JSON only once and durably removes state files", () => {
    const testState = state();
    try {
      const path = join(wrenchStateHome(testState.environment), "plans", "once.json");
      let readerObservedUnpublishedPath = false;
      expect(createPrivateJsonIfAbsent(path, { version: 1 }, {
        beforePublish: (temporaryPath) => {
          expect(readJsonFile(temporaryPath)).toEqual({ version: 1 });
          const reader = Bun.spawnSync({
            cmd: [process.execPath, "-e", `
              const { readFileSync } = require("node:fs");
              try {
                JSON.parse(readFileSync(process.argv[1], "utf8"));
                process.exit(2);
              } catch (error) {
                process.exit(error && error.code === "ENOENT" ? 0 : 3);
              }
            `, path],
            stderr: "pipe",
            stdout: "pipe",
          });
          expect(reader.exitCode).toBe(0);
          readerObservedUnpublishedPath = true;
        },
        environment: testState.environment,
        privateParent: true,
      })).toEqual({ created: true });
      expect(readerObservedUnpublishedPath).toBeTrue();
      expect(createPrivateJsonIfAbsent(path, { version: 2 }, {
        environment: testState.environment,
        privateParent: true,
      })).toEqual({ created: false });
      expect(readJsonFile(path)).toEqual({ version: 1 });
      expect(lstatSync(path).mode & 0o777).toBe(0o600);

      const racedPath = join(wrenchStateHome(testState.environment), "plans", "race.json");
      const plansStats = lstatSync(join(wrenchStateHome(testState.environment), "plans"), { bigint: true });
      const expectedStateParent = {
        device: plansStats.dev.toString(),
        inode: plansStats.ino.toString(),
      };
      expect(createPrivateJsonIfAbsent(racedPath, { winner: "staged" }, {
        beforePublish: () => {
          expect(createPrivateJsonIfAbsent(racedPath, { winner: "contender" }, {
            environment: testState.environment,
            expectedStateParent,
          })).toEqual({ created: true });
        },
        environment: testState.environment,
        expectedStateParent,
      })).toEqual({ created: false });
      expect(readJsonFile(racedPath)).toEqual({ winner: "contender" });
      expect(readdirWithoutDot(join(wrenchStateHome(testState.environment), "plans"))).toEqual(["once.json", "race.json"]);

      const rejectedPath = join(wrenchStateHome(testState.environment), "plans", "wrong-parent.json");
      expect(() => createPrivateJsonIfAbsent(rejectedPath, { outside: false }, {
        environment: testState.environment,
        expectedStateParent: { ...expectedStateParent, inode: (BigInt(expectedStateParent.inode) + 1n).toString() },
      })).toThrow("identity");
      expect(existsSync(rejectedPath)).toBeFalse();

      expect(removePrivateStateFile(path, testState.environment)).toBeTrue();
      expect(removePrivateStateFile(path, testState.environment)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses create-if-absent and removal through state symlinks", () => {
    const testState = state();
    const external = mkdtempSync(join(tmpdir(), "wrench-storage-external-"));
    chmodSync(external, 0o700);
    try {
      const stateRoot = wrenchStateHome(testState.environment);
      const externalPlans = join(external, "plans");
      mkdirSync(externalPlans, { mode: 0o700 });
      const externalFile = join(externalPlans, "once.json");
      writeFileSync(externalFile, '{"outside":true}\n', { mode: 0o600 });
      symlinkSync(externalPlans, join(stateRoot, "plans"));

      expect(() => createPrivateJsonIfAbsent(
        join(stateRoot, "plans", "new.json"),
        { outside: false },
        { environment: testState.environment, privateParent: true },
      )).toThrow("symbolic link");
      expect(() => removePrivateStateFile(
        join(stateRoot, "plans", "once.json"),
        testState.environment,
      )).toThrow("symbolic link");
      expect(readFileSync(externalFile, "utf8")).toBe('{"outside":true}\n');
      expect(existsSync(join(externalPlans, "new.json"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("canonicalizes an explicit state-home path through existing symlink ancestors", () => {
    const testState = state();
    try {
      const real = join(testState.directory, "real");
      mkdirSync(real);
      const linked = join(testState.directory, "linked");
      symlinkSync(real, linked);
      expect(wrenchStateHome({ WRENCH_STATE_HOME: join(linked, "nested") })).toBe(join(realpathSync(real), "nested"));
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses symlinked state ancestors before writes or destructive removal", async () => {
    const testState = state();
    const external = mkdtempSync(join(tmpdir(), "wrench-storage-external-"));
    chmodSync(external, 0o700);
    try {
      const externalAuth = join(external, "auth");
      mkdirSync(externalAuth, { mode: 0o700 });
      const externalAuthRecord = join(externalAuth, "example.json");
      writeFileSync(externalAuthRecord, '{"outside":true}\n', { mode: 0o600 });
      const authLink = join(testState.directory, "auth");
      symlinkSync(externalAuth, authLink);

      expect(() => saveAuth(createAuth("other", { source: "chrome" }), testState.environment)).toThrow("symbolic link");
      expect(() => removeAuth("example", testState.environment)).toThrow("symbolic link");
      expect(readFileSync(externalAuthRecord, "utf8")).toBe('{"outside":true}\n');
      expect(existsSync(join(externalAuth, "other.json"))).toBeFalse();

      rmSync(authLink);
      const derivationId = crypto.randomUUID();
      const externalDerivations = join(external, "derivations");
      const externalSession = join(externalDerivations, derivationId);
      mkdirSync(externalSession, { recursive: true, mode: 0o700 });
      const marker = join(externalSession, "must-remain.txt");
      writeFileSync(marker, "outside\n", { mode: 0o600 });
      symlinkSync(externalDerivations, join(testState.directory, "derivations"));

      try {
        await discardDerivation(derivationId, testState.environment);
        throw new Error("expected discard to reject a symlinked state ancestor");
      } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).toContain("symbolic link");
      }
      expect(readFileSync(marker, "utf8")).toBe("outside\n");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("installs manifests privately, rejects accidental replacement, and lists invalid installs", () => {
    const testState = state();
    try {
      const path = installManifest(manifest, { force: false, environment: testState.environment });
      expect(lstatSync(join(testState.directory, "adapters", "example")).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(installManifest(manifest, { force: false, environment: testState.environment })).toBe(path);
      expect(() => installManifest({ ...manifest, version: "1.0.1" }, { force: false, environment: testState.environment }))
        .toThrow("already installed and differs");
      installManifest({ ...manifest, version: "1.0.1" }, { force: true, environment: testState.environment });

      const badDirectory = join(testState.directory, "adapters", "broken");
      mkdirSync(badDirectory, { mode: 0o700 });
      // Installed flat-state filenames remain byte-stable for recovery compatibility.
      writeFileSync(join(badDirectory, "io-adapter.json"), "not-json\n", { mode: 0o600 });
      mkdirSync(
        join(testState.directory, "adapters", "missing"),
        { mode: 0o700 },
      );
      const listed = listInstalledManifests(testState.environment);
      expect(listed.map((entry) => entry.id)).toEqual([
        "broken",
        "example",
        "missing",
      ]);
      expect(listed[0]?.result.ok).toBeFalse();
      expect(listed[1]?.result).toMatchObject({ ok: true, value: { version: "1.0.1" } });
      expect(listed[2]?.result.ok).toBeFalse();
      expect(removeInstalledManifest("example", testState.environment)).toBeTrue();
      expect(removeInstalledManifest("example", testState.environment)).toBeFalse();
      expect(existsSync(join(testState.directory, "adapters", "example"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("preserves a same-UID edit that races a conditional managed upgrade", () => {
    const testState = state();
    try {
      installManifest(manifest, { force: false, environment: testState.environment });
      const snapshot = loadInstalledManifestSnapshot("example", testState.environment);
      expect(snapshot.result.ok).toBeTrue();
      expect(snapshot.contentSha256).not.toBeNull();
      if (snapshot.contentSha256 === null) throw new Error("installed manifest snapshot omitted its content hash");
      const expectedCurrentContentSha256 = snapshot.contentSha256;
      const concurrentEdit = { ...manifest, version: "1.0.1", displayName: "Same-UID edit" };

      expect(() => installManifest({ ...manifest, version: "2.0.0" }, {
        force: true,
        environment: testState.environment,
        expectedCurrentContentSha256,
        beforeReplace: () => installManifest(concurrentEdit, { force: true, environment: testState.environment }),
      })).toThrow("no longer matches the expected hash");

      const preserved = loadInstalledManifest("example", testState.environment);
      expect(preserved.ok).toBeTrue();
      if (preserved.ok) expect(preserved.value).toEqual(concurrentEdit);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

function readdirWithoutDot(directory: string): readonly string[] {
  return Array.from(new Bun.Glob("*").scanSync({ cwd: directory, onlyFiles: false })).sort();
}
