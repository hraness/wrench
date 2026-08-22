import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireDerivationLifecycleGate,
  assertDerivationAuthCompatibility,
  assertDerivationRecorderCommandAllowed,
  DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS,
  derivationGlobalArguments,
  derivationBootstrapUrl,
  derivationPolicyActions,
  discardDerivation,
  finishDerivation as finishDerivationWithRegistry,
  listDerivations,
  reviewDerivation,
  runDerivationBrowserCommand,
  sanitizeDerivationNetworkResult,
  startDerivation,
  validateDerivationBrowserCommand,
  type DerivationSession,
} from "./derive";
import {
  analyzeHarValue,
  assertBrowserDerivationTargetAllowed,
  assertScaffoldOutput,
  writeDerivationScaffold as writeDerivationScaffoldWithRegistry,
} from "./har";
import { sha256 } from "./model";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  createPrivateJsonIfAbsent,
  listPrivateStateDirectory,
  removePrivateEmptyStateDirectory,
} from "./storage";

const targetOrigin = "https://example.com";
const readOnlyPolicy = { allowRemoteActions: false, targetOrigin } as const;
const actionPolicy = { allowRemoteActions: true, targetOrigin } as const;
const stagedFixture = {
  reference: "fixture:1",
  fileName: "fixture-01.png",
  bytes: 8,
  mediaType: "image/png",
  sha256: "a".repeat(64),
  device: "1",
  inode: "2",
} as const;
const fixtureActionPolicy = { ...actionPolicy, fixtures: [stagedFixture] } as const;

const finishDerivation = (
  id: Parameters<typeof finishDerivationWithRegistry>[0],
  outputDirectory: Parameters<typeof finishDerivationWithRegistry>[1],
  options: Omit<
    Parameters<typeof finishDerivationWithRegistry>[2],
    "registry"
  >,
) => finishDerivationWithRegistry(id, outputDirectory, {
  ...options,
  registry: providerPluginRegistry,
});

const writeDerivationScaffold = (
  outputDirectory: Parameters<typeof writeDerivationScaffoldWithRegistry>[0],
  analysis: Parameters<typeof writeDerivationScaffoldWithRegistry>[1],
  options: Omit<
    Parameters<typeof writeDerivationScaffoldWithRegistry>[2],
    "registry"
  >,
) => writeDerivationScaffoldWithRegistry(outputDirectory, analysis, {
  ...options,
  registry: providerPluginRegistry,
});

function validateReadOnly(command: readonly string[]): void {
  validateDerivationBrowserCommand(readOnlyPolicy, command);
}

function validateAction(command: readonly string[]): void {
  validateDerivationBrowserCommand(actionPolicy, command);
}

async function expectRejectedWith(promise: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown = null;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain(message);
}

describe("derive browser command grammar", () => {
  test("authorizes pinned concrete observation actions and gates mutation actions", () => {
    for (const action of ["getbyrole", "inputvalue", "getattribute", "textcontent", "innerhtml", "waitfortext", "waitforurl", "har_start", "har_stop", "requests", "close"]) {
      expect(derivationPolicyActions(false).includes(action)).toBeTrue();
    }
    expect(derivationPolicyActions(false)).not.toContain("fill");
    for (const action of ["fill", "press", "click"]) expect(derivationPolicyActions(true).includes(action)).toBeTrue();
    expect(derivationPolicyActions(true)).not.toContain("upload");
    expect(derivationPolicyActions(true, true)).toContain("upload");
    expect(derivationPolicyActions(true, true)).toContain("count");
    expect(derivationPolicyActions(true, true)).toContain("cdp_url");
  });

  test("permits only start-bound fixture references for upload", () => {
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["upload", "@e5", "fixture:1"],
    )).not.toThrow();
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["upload", "@single-file-input", "fixture:1"],
    )).not.toThrow();
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["upload", "@single-image-input", "fixture:1"],
    )).not.toThrow();
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["upload-and-seal", "@single-file-input", "fixture:1"],
    )).not.toThrow();
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["choose-upload", "@e5", "fixture:1"],
    )).not.toThrow();
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["choose-upload", "@single-file-input", "fixture:1"],
    )).toThrow("snapshot upload-control");
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["eval", "document.cookie"],
    )).toThrow("does not allow eval");
    expect(() => validateDerivationBrowserCommand(
      actionPolicy,
      ["upload", "@e5", "fixture:1"],
    )).toThrow("staged fixture");
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["upload", "@e5", "/tmp/private.png"],
    )).toThrow("staged fixture");
    expect(() => validateDerivationBrowserCommand(
      fixtureActionPolicy,
      ["upload", "@e5", "fixture:1", "fixture:1"],
    )).toThrow("unique");
    expect(() => validateDerivationBrowserCommand(
      { ...fixtureActionPolicy, allowRemoteActions: false },
      ["upload", "@e5", "fixture:1"],
    )).toThrow("read-only");
  });

  test("allows an exact browser close after the derivation recorder is sealed", () => {
    expect(() => assertDerivationRecorderCommandAllowed(["close"], true)).not.toThrow();
    expect(() => assertDerivationRecorderCommandAllowed(["reload"], true)).toThrow(
      "sealed for private review",
    );
    expect(() => assertDerivationRecorderCommandAllowed(["reload"], false)).not.toThrow();
  });

  test.each([
    ["open", "https://example.com/path?next=https%3A%2F%2Fevil.example"],
    ["open", "https://EXAMPLE.com:443/path"],
    ["back"],
    ["forward"],
    ["reload"],
    ["close"],
    ["snapshot"],
    ["snapshot", "-i"],
    ["snapshot", "-c"],
    ["snapshot", "-u"],
    ["snapshot", "-i", "-u"],
    ["get", "url"],
    ["get", "title"],
    ["get", "text", "@e1"],
    ["get", "html", "@e12"],
    ["get", "value", "@e999"],
    ["get", "attr", "@e2", "aria-label"],
    ["network", "requests"],
    ["network", "requests", "--filter", "ondemand.s"],
    ["wait", "1"],
    ["wait", "30000"],
    ["wait", "--text", "Inbox"],
    ["wait", "--url", "https://example.com/messages"],
    ["scroll", "up"],
    ["scroll", "down", "10000"],
    ["scrollintoview", "@e1"],
  ].map((command) => [command] as const))("accepts bounded read-only command %#", (command) => {
    expect(() => validateReadOnly(command)).not.toThrow();
  });

  test("rejects the pinned browser's advertised but unsupported semantic focus subaction", () => {
    expect(() => validateReadOnly(["find", "placeholder", "Write a message", "focus", "--exact"])).toThrow("find action");
  });

  test.each([
    ["click", "@e1"],
    ["dblclick", "@e1"],
    ["fill", "@e1", "hello"],
    ["type", "@e1", "hello"],
    ["press", "Enter"],
    ["focus", "@e1"],
    ["hover", "@e1"],
    ["check", "@e1"],
    ["uncheck", "@e1"],
    ["select", "@e1", "one", "two"],
    ["find", "role", "button", "click", "--name", "Send"],
    ["find", "label", "Message", "fill", "hello"],
    ["find", "placeholder", "Message", "type", "hello"],
    ["find", "role", "button", "hover", "--name", "Send", "--exact"],
  ].map((command) => [command] as const))("rejects mutating command %# in a read-only session", (command) => {
    expect(() => validateReadOnly(command)).toThrow("read-only");
    expect(() => validateAction(command)).not.toThrow();
  });

  test("allows an action-enabled derivation to clear a field explicitly", () => {
    expect(() => validateAction(["fill", "@e1", ""])).not.toThrow();
    expect(() => validateAction(["find", "label", "Message", "fill", ""])).not.toThrow();
    expect(() => validateReadOnly(["fill", "@e1", ""])).toThrow("read-only");
  });

  test.each([
    [["open", "https://sub.example.com/path"], "target origin"],
    [["open", "https://example.com:444/path"], "target origin"],
    [["open", "http://example.com/path"], "must be HTTPS"],
    [["open", "https://example.com.evil.test/path"], "target origin"],
    [["open", "https://example.com@evil.test/path"], "embedded credentials"],
    [["open", "https://127.0.0.1/path"], "private network"],
    [["open", "https://example.com/path", "--headers", "{}"], "disallowed escape"],
    [["open", "file:///etc/passwd"], "must be HTTPS"],
    [["open", "javascript:alert(1)"], "must be HTTPS"],
  ])("confines navigation %#", (command, message) => {
    expect(() => validateAction(command)).toThrow(message);
  });

  test.each([
    ["eval", "document.cookie"],
    ["cdp-url"],
    ["cookies"],
    ["storage", "local"],
    ["network", "har", "stop", "/tmp/exfil.har"],
    ["network", "clear"],
    ["network", "requests", "--filter", "ok", "--json"],
    ["download", "@e1", "/tmp/file"],
    ["snapshot", "--filename", "/tmp/dom.txt"],
    ["snapshot", "-i", "--download", "/tmp/file"],
    ["get", "html", "body"],
    ["get", "attr", "@e1", "bad name"],
    ["wait", "--fn", "fetch('https://evil.test')"],
    ["wait", "0"],
    ["wait", "30001"],
    ["scroll", "left"],
    ["scroll", "down", "10001"],
    ["click", "#css-selector"],
    ["press", "Control+Shift+Key With Spaces"],
    ["find", "css", "button", "click"],
    ["find", "text", "Send", "click", "--name", "escape"],
    ["find", "role", "button", "click", "--exact", "--exact"],
    ["get", "url", "--headers"],
    ["read", "https://evil.test"],
    ["open", "https://example.com", "--require-md"],
    ["open", "https://example.com", "value\u0000suffix"],
  ].map((command) => [command] as const))("rejects escape-shaped command %#", (command) => {
    expect(() => validateAction(command)).toThrow();
  });

  test("rejects the browser-wide read command because it can expose raw authenticated page state", () => {
    expect(derivationPolicyActions(false)).not.toContain("read");
    expect(derivationPolicyActions(true)).not.toContain("read");
    expect(() => validateReadOnly(["read"])).toThrow("does not allow read");
    expect(() => validateAction(["read"])).toThrow("does not allow read");
  });

  test("enforces command and argument cardinality bounds", () => {
    expect(() => validateAction([])).toThrow("argument bounds");
    expect(() => validateAction(Array.from({ length: 101 }, () => "reload"))).toThrow("argument bounds");
    expect(() => validateAction(["fill", "@e1", "x".repeat(64 * 1024 + 1)])).toThrow("argument bounds");
  });

  test("sanitizes network listings to structural request metadata only", () => {
    const raw = {
      lifecycle: { private: "browser state" },
      requests: [{
        method: "POST",
        url: "https://example.com/api/messages/private-thread?cursor=private&count=20#fragment",
        status: 200,
        mimeType: "application/json",
        resourceType: "Fetch",
        headers: { cookie: "private-cookie", authorization: "Bearer private-token" },
        responseHeaders: { "set-cookie": "private-session" },
        timestamp: 12345,
      }],
    };
    const sanitized = sanitizeDerivationNetworkResult(raw);
    expect(sanitized).toEqual({
      requests: [{
        method: "POST",
        origin: "https://example.com",
        path: "/api/messages/private-thread",
        queryNames: ["count", "cursor"],
        status: 200,
        mimeType: "application/json",
        resourceType: "Fetch",
      }],
      truncated: false,
    });
    expect(JSON.stringify(sanitized)).not.toContain("private-cookie");
    expect(JSON.stringify(sanitized)).not.toContain("private-token");
    expect(JSON.stringify(sanitized)).not.toContain("private-session");
    expect(JSON.stringify(sanitized)).not.toContain("cursor=private");
  });
});

function sessionMetadata(
  id: string,
  directory: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
  const identity = (path: string): { readonly device: string; readonly inode: string } => {
    try {
      const stats = lstatSync(path, { bigint: true });
      return { device: stats.dev.toString(), inode: stats.ino.toString() };
    } catch {
      return { device: "0", inode: "0" };
    }
  };
  return {
    schemaVersion: 1,
    id,
    adapterId: "example",
    targetUrl: "https://example.com/messages",
    targetOrigin,
    createdAt: "2026-07-21T12:00:00.000Z",
    allowRemoteActions: false,
    contentMode: "none",
    browserDomains: ["example.com"],
    headed: false,
    sessionName: `io-derive-${id.replaceAll("-", "").slice(0, 12)}`,
    directory,
    directoryIdentity: identity(directory),
    socketDirectory,
    socketIdentity: identity(socketDirectory),
    configPath: join(directory, "agent-browser.json"),
    policyPath: join(directory, "action-policy.json"),
    profilePath: null,
    ...overrides,
  };
}

function writeDirectoryPhaseFixture(id: string, directory: string): void {
  const directoryStats = lstatSync(directory, { bigint: true });
  writeFileSync(join(directory, "phase.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "io-derivation-directory-phase",
    derivationId: id,
    directoryIdentity: {
      device: directoryStats.dev.toString(),
      inode: directoryStats.ino.toString(),
    },
  }), { mode: 0o600 });
}

function writeInitializationFixture(id: string, directory: string): void {
  writeDirectoryPhaseFixture(id, directory);
  const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
  const directoryStats = lstatSync(directory, { bigint: true });
  const socketStats = lstatSync(socketDirectory, { bigint: true });
  writeFileSync(join(directory, "initializing.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "io-derivation-initialization",
    derivationId: id,
    directoryIdentity: {
      device: directoryStats.dev.toString(),
      inode: directoryStats.ino.toString(),
    },
    socketDirectory,
    socketIdentity: {
      device: socketStats.dev.toString(),
      inode: socketStats.ino.toString(),
    },
  }), { mode: 0o600 });
}

function writeSessionFixture(
  id: string,
  directory: string,
  overrides: Readonly<Record<string, unknown>> = {},
  options: { readonly ready?: boolean } = {},
): void {
  writeInitializationFixture(id, directory);
  const metadataText = JSON.stringify(sessionMetadata(id, directory, overrides));
  const metadataPath = join(directory, "session.json");
  writeFileSync(metadataPath, metadataText, { mode: 0o600 });
  if (options.ready === false) return;
  const stats = lstatSync(metadataPath, { bigint: true });
  writeFileSync(join(directory, "ready.json"), JSON.stringify({
    schemaVersion: 1,
    state: "ready",
    metadata: {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      byteLength: Buffer.byteLength(metadataText, "utf8"),
      sha256: sha256(metadataText),
    },
  }), { mode: 0o600 });
}

async function leaveCrashedLifecycleGate(id: string, wrenchState: string): Promise<string> {
  const modulePath = join(import.meta.dir, "derive.ts");
  const child = Bun.spawn([
    process.execPath,
    "--eval",
    `const m = await import(${JSON.stringify(modulePath)}); m.acquireDerivationLifecycleGate(${JSON.stringify(id)}, { WRENCH_STATE_HOME: ${JSON.stringify(wrenchState)} });`,
  ], {
    cwd: import.meta.dir,
    env: { ...process.env, WRENCH_STATE_HOME: wrenchState },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  return join(wrenchState, "derivations", `.lifecycle-${id}`);
}

describe("derivation session path defenses", () => {
  test("initializes agent-browser on a harmless exact-origin URL instead of about:blank", () => {
    expect(derivationBootstrapUrl(new URL("https://x.com/home?private=value")))
      .toBe("https://x.com/robots.txt");
    expect(derivationBootstrapUrl(new URL("https://example.com:8443/messages")))
      .toBe("https://example.com:8443/robots.txt");
  });

  test.each([
    "https://www.linkedin.com/feed",
    "https://sales.linkedin.com/home",
    "https://x.com/home",
    "https://mobile.twitter.com/home",
  ])("allows first-party internal-API evidence capture for %s", (target) => {
    expect(() => assertBrowserDerivationTargetAllowed(new URL(target))).not.toThrow();
  });

  test("requires a path-backed LinkedIn profile and exact executable at the compatibility gate", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-linkedin-compatibility-test-")));
    const profile = join(root, "profile");
    mkdirSync(profile, { mode: 0o700 });
    const target = new URL("https://www.linkedin.com/feed/");
    try {
      expect(() => assertDerivationAuthCompatibility(target, {
        schemaVersion: 1,
        id: "linkedin-cookie",
        kind: "cookie-source",
        source: "arc",
        profile: "Profile 1",
      })).toThrow("browser-profile auth locator");
      expect(() => assertDerivationAuthCompatibility(target, {
        schemaVersion: 1,
        id: "linkedin-profile",
        kind: "browser-profile",
        profile,
        trustUnfilteredEgress: true,
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        cookieSource: "arc",
        cookieProfile: "Profile 1",
      })).not.toThrow();
      expect(() => assertDerivationAuthCompatibility(target, {
        schemaVersion: 1,
        id: "linkedin-arc-executable",
        kind: "browser-profile",
        profile,
        trustUnfilteredEgress: true,
        browserExecutable: "/Applications/Arc.app/Contents/MacOS/Arc",
      })).toThrow("cannot use Arc as --browser-executable");
      expect(() => assertDerivationAuthCompatibility(target, {
        schemaVersion: 1,
        id: "linkedin-missing-executable",
        kind: "browser-profile",
        profile,
        trustUnfilteredEgress: true,
      })).toThrow("--browser-executable");
      expect(() => assertDerivationAuthCompatibility(target, {
        schemaVersion: 1,
        id: "linkedin-named-profile",
        kind: "browser-profile",
        profile: "Work",
        trustUnfilteredEgress: true,
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
      })).toThrow("path-backed browser-profile");
      expect(() => assertDerivationAuthCompatibility(new URL("https://news.ycombinator.com/"), {
        schemaVersion: 1,
        id: "public-cookie",
        kind: "cookie-source",
        source: "arc",
        profile: "Profile 1",
      })).not.toThrow();
      expect(() => assertDerivationAuthCompatibility(new URL("https://news.ycombinator.com/"), {
        schemaVersion: 1,
        id: "public-arc-executable",
        kind: "browser-profile",
        profile,
        trustUnfilteredEgress: true,
        browserExecutable: "/Applications/Arc.app/Contents/MacOS/Arc",
      })).toThrow("cannot use Arc as --browser-executable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an Arc executable reached through a differently named symlink without disclosing paths", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-arc-executable-alias-test-")));
    const profile = join(root, "profile");
    const arcExecutable = join(root, "Arc");
    const chromiumAlias = join(root, "Chromium");
    try {
      mkdirSync(profile, { mode: 0o700 });
      writeFileSync(arcExecutable, "test executable", { mode: 0o700 });
      symlinkSync(arcExecutable, chromiumAlias);
      let message = "";
      try {
        assertDerivationAuthCompatibility(new URL("https://www.linkedin.com/feed/"), {
          schemaVersion: 1,
          id: "linkedin-arc-executable-alias",
          kind: "browser-profile",
          profile,
          trustUnfilteredEgress: true,
          browserExecutable: chromiumAlias,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("cannot use Arc as --browser-executable");
      expect(message).not.toContain(root);
      expect(message).not.toContain(chromiumAlias);
      expect(message).not.toContain(arcExecutable);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a named LinkedIn profile before creating derivation state", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-linkedin-named-profile-test-")));
    const wrenchState = join(root, "io-state");
    try {
      await expectRejectedWith(startDerivation(
        "linkedin-web",
        "https://www.linkedin.com/feed/",
        {
          schemaVersion: 1,
          id: "linkedin-named-profile",
          kind: "browser-profile",
          profile: "Work",
          trustUnfilteredEgress: true,
          browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        },
        {
          allowRemoteActions: false,
          contentMode: "none",
          browserDomains: ["www.linkedin.com"],
          headed: false,
          environment: { WRENCH_STATE_HOME: wrenchState },
        },
      ), "path-backed browser-profile");
      expect(existsSync(wrenchState)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps LinkedIn capture navigation on its exact first-party origin", () => {
    const policy = { allowRemoteActions: false, targetOrigin: "https://www.linkedin.com" } as const;
    expect(() => validateDerivationBrowserCommand(
      policy,
      ["open", "https://www.linkedin.com/feed"],
    )).not.toThrow();
    expect(() => validateDerivationBrowserCommand(
      policy,
      ["open", "https://sales.linkedin.com/home"],
    )).toThrow("target origin");
  });

  test("launches private generic and selected-Chromium snapshots as paths", () => {
    const id = crypto.randomUUID();
    const directory = "/private/wrench/derivation";
    const base = sessionMetadata(id, directory) as DerivationSession;
    const generic = derivationGlobalArguments({ ...base, profilePath: join(directory, "profile") });
    const selected = derivationGlobalArguments({
      ...base,
      profilePath: join(directory, "profile-user-data"),
      browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    });
    const named = derivationGlobalArguments({ ...base, profilePath: "Work" });

    expect(generic.slice(generic.indexOf("--profile"), generic.indexOf("--profile") + 2)).toEqual(["--profile", "./profile"]);
    expect(generic).not.toContain("--profile-directory=Default");
    expect(selected.slice(selected.indexOf("--profile"), selected.indexOf("--profile") + 2)).toEqual(["--profile", "./profile-user-data"]);
    expect(selected).toContain("--profile-directory=Default");
    expect(selected.slice(
      selected.indexOf("--executable-path"),
      selected.indexOf("--executable-path") + 2,
    )).toEqual([
      "--executable-path",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]);
    expect(named.slice(named.indexOf("--profile"), named.indexOf("--profile") + 2)).toEqual(["--profile", "Work"]);
  });

  test("the browser launcher rejects a replaced cwd and policy-override arguments before startup", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-bound-command-test-")));
    chmodSync(directory, 0o700);
    const stats = lstatSync(directory, { bigint: true });
    const helper = join(import.meta.dir, "derive-command-helper.ts");
    const config = join(import.meta.dir, "state-helper.bunfig.toml");
    writeFileSync(join(directory, "agent-browser.json"), "{}\n", { mode: 0o600 });
    writeFileSync(
      join(directory, "action-policy.json"),
      `${JSON.stringify({ allow: derivationPolicyActions(false), default: "deny" })}\n`,
      { mode: 0o600 },
    );
    const base = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      expectedDirectory: { device: stats.dev.toString(), inode: stats.ino.toString() },
      socketDirectory: directory,
      expectedSocketDirectory: { device: stats.dev.toString(), inode: stats.ino.toString() },
      allowRemoteActions: false,
      allowFixtureUpload: false,
      timeoutMs: 10_000,
      maxOutputBytes: 1024 * 1024,
      arguments: ["close", "--json"],
      browserStdin: null,
    } as const;
    const invoke = (request: unknown) => Bun.spawnSync({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--no-install",
        "--no-macros",
        "--no-addons",
        `--config=${config}`,
        helper,
      ],
      cwd: directory,
      env: { NODE_ENV: "production" },
      stdin: new Blob([JSON.stringify(request)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const replaced = invoke({
        ...base,
        expectedDirectory: { ...base.expectedDirectory, inode: (stats.ino + 1n).toString() },
      });
      expect(replaced.exitCode).not.toBe(0);
      expect(replaced.stderr.toString()).toContain("no longer matches");

      const override = invoke({ ...base, arguments: ["--action-policy", "untrusted.json", "close"] });
      expect(override.exitCode).not.toBe(0);
      expect(override.stderr.toString()).toContain("request is invalid");

      const help = invoke({ ...base, requestId: crypto.randomUUID(), arguments: ["--help"] });
      expect(help.exitCode).toBe(0);
      expect(readdirSync(directory).sort()).toEqual(["action-policy.json", "agent-browser.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("removes partial control and socket trees when profile initialization fails", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-init-test-")));
    const wrenchState = join(root, "io-state");
    const beforeSockets = new Set(readdirSync(process.platform === "win32" ? tmpdir() : "/tmp").filter((name) => name.startsWith("io-derive-ab-")));
    try {
      await expectRejectedWith(startDerivation(
        "example",
        "https://example.com/messages",
        {
          schemaVersion: 1,
          id: "example",
          kind: "browser-profile",
          profile: join(root, "missing-profile"),
          trustUnfilteredEgress: true,
        },
        {
          allowRemoteActions: false,
          contentMode: "none",
          browserDomains: ["example.com"],
          headed: false,
          environment: { WRENCH_STATE_HOME: wrenchState },
        },
      ), "unavailable or unsafe");
      const derivations = join(wrenchState, "derivations");
      expect(existsSync(derivations) ? readdirSync(derivations) : []).toEqual([]);
      expect(JSON.parse(readFileSync(join(wrenchState, ".io-state.json"), "utf8")))
        .toEqual({ schemaVersion: 1, kind: "io-state" });
      const newSockets = readdirSync(process.platform === "win32" ? tmpdir() : "/tmp")
        .filter((name) => name.startsWith("io-derive-ab-") && !beforeSockets.has(name));
      expect(newSockets).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an active Chromium profile without retaining partial derivation state", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-active-profile-test-")));
    const wrenchState = join(root, "io-state");
    const userData = join(root, "User Data");
    const profile = join(userData, "Profile 1");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(join(userData, "Local State"), "{}\n", { mode: 0o600 });
    writeFileSync(join(userData, "SingletonLock"), "active\n", { mode: 0o600 });
    writeFileSync(join(profile, "Cookies"), "private\n", { mode: 0o600 });
    try {
      await expectRejectedWith(startDerivation(
        "example",
        "https://example.com/messages",
        {
          schemaVersion: 1,
          id: "example",
          kind: "browser-profile",
          profile,
          trustUnfilteredEgress: true,
        },
        {
          allowRemoteActions: false,
          contentMode: "none",
          browserDomains: ["example.com"],
          headed: false,
          environment: { WRENCH_STATE_HOME: wrenchState },
        },
      ), "fully quit the browser and retry");
      const derivations = join(wrenchState, "derivations");
      expect(existsSync(derivations) ? readdirSync(derivations) : []).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reloads freshly persisted metadata with a hyphen-free session suffix", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-reload-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeSessionFixture(id, expectedDirectory);

      expect(listDerivations({ WRENCH_STATE_HOME: wrenchState })).toEqual([{
        id,
        adapterId: "example",
        targetOrigin,
        createdAt: "2026-07-21T12:00:00.000Z",
        allowRemoteActions: false,
        contentMode: "none",
        headed: false,
        browserDomains: ["example.com"],
        rawHarPresent: false,
        reviewSealed: false,
        socketAvailable: true,
        ready: true,
      }]);

      await expectRejectedWith(
        runDerivationBrowserCommand(id, ["eval"], { WRENCH_STATE_HOME: wrenchState }),
        "does not allow eval",
      );
      expect(existsSync(expectedDirectory)).toBe(true);
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps init-only crashes visible and recoverable after their browser socket disappears", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-init-only-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeInitializationFixture(id, expectedDirectory);

      expect(listDerivations(environment)).toEqual([{
        id,
        ready: false,
        recoverable: true,
        socketAvailable: true,
      }]);
      await expectRejectedWith(
        discardDerivation(id, environment),
        "browser socket is still present",
      );
      expect(existsSync(expectedDirectory)).toBeTrue();
      rmSync(socketDirectory, { recursive: true });
      expect(await discardDerivation(id, environment)).toBeTrue();
      expect(existsSync(expectedDirectory)).toBeFalse();
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers a directory-phase crash before any browser socket exists", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-directory-phase-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      writeDirectoryPhaseFixture(id, expectedDirectory);

      expect(listDerivations(environment)).toEqual([{
        id,
        ready: false,
        recoverable: true,
        socketAvailable: false,
      }]);
      expect(await discardDerivation(id, environment)).toBeTrue();
      expect(existsSync(expectedDirectory)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves an unknown live socket from a crash before the socket-bound init marker", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-pre-init-socket-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      writeDirectoryPhaseFixture(id, expectedDirectory);
      mkdirSync(socketDirectory, { mode: 0o700 });

      expect(listDerivations(environment)).toEqual([{
        id,
        ready: false,
        recoverable: true,
        socketAvailable: true,
      }]);
      await expectRejectedWith(discardDerivation(id, environment), "unbound browser socket");
      expect(existsSync(expectedDirectory)).toBeTrue();
      expect(existsSync(socketDirectory)).toBeTrue();

      rmSync(socketDirectory, { recursive: true });
      expect(await discardDerivation(id, environment)).toBeTrue();
      expect(existsSync(expectedDirectory)).toBeFalse();
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not recover a replaced directory through a copied phase marker", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-phase-replacement-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const displacedDirectory = join(wrenchState, "derivations", `.displaced-session-${id}`);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      writeDirectoryPhaseFixture(id, expectedDirectory);
      const phaseText = readFileSync(join(expectedDirectory, "phase.json"), "utf8");
      renameSync(expectedDirectory, displacedDirectory);
      mkdirSync(expectedDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "phase.json"), phaseText, { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "sentinel"), "keep", { mode: 0o600 });

      expect(listDerivations(environment)).toEqual([{ id, invalid: true }]);
      await expectRejectedWith(discardDerivation(id, environment), "does not match its directory");
      expect(readFileSync(join(expectedDirectory, "sentinel"), "utf8")).toBe("keep");
      expect(existsSync(displacedDirectory)).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers the empty markerless create-to-phase kill window by exact identity", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-empty-markerless-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });

      expect(listDerivations(environment)).toEqual([{
        id,
        ready: false,
        recoverable: true,
        socketAvailable: false,
      }]);
      expect(await discardDerivation(id, environment)).toBeTrue();
      expect(existsSync(expectedDirectory)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not recover markerless state while an unknown socket exists", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-markerless-socket-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });

      expect(listDerivations(environment)).toEqual([{ id, invalid: true }]);
      await expectRejectedWith(discardDerivation(id, environment), "unbound browser socket");
      expect(existsSync(expectedDirectory)).toBeTrue();
      expect(existsSync(socketDirectory)).toBeTrue();

      rmSync(socketDirectory, { recursive: true });
      expect(await discardDerivation(id, environment)).toBeTrue();
      expect(existsSync(expectedDirectory)).toBeFalse();
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rechecks markerless state after list and preserves a nonempty replacement", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-markerless-replacement-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const displacedDirectory = join(wrenchState, "derivations", `.displaced-markerless-${id}`);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      expect(listDerivations(environment)).toEqual([{
        id,
        ready: false,
        recoverable: true,
        socketAvailable: false,
      }]);

      renameSync(expectedDirectory, displacedDirectory);
      mkdirSync(expectedDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "sentinel"), "keep", { mode: 0o600 });
      await expectRejectedWith(discardDerivation(id, environment), "session metadata");
      expect(readFileSync(join(expectedDirectory, "sentinel"), "utf8")).toBe("keep");
      expect(existsSync(displacedDirectory)).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("atomically refuses markerless removal when insertion or replacement wins the helper race", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-empty-remove-race-test-")));
    const wrenchState = join(root, "io-state");
    const derivations = join(wrenchState, "derivations");
    const environment = { WRENCH_STATE_HOME: wrenchState };
    const identity = (path: string) => {
      const stats = lstatSync(path, { bigint: true });
      return { device: stats.dev.toString(), inode: stats.ino.toString() };
    };
    try {
      const guardedId = crypto.randomUUID();
      const guardedDirectory = join(derivations, guardedId);
      mkdirSync(guardedDirectory, { recursive: true, mode: 0o700 });
      const previousNodeEnvironment = process.env.NODE_ENV;
      try {
        Reflect.set(process.env, "NODE_ENV", "production");
        expect(() => removePrivateEmptyStateDirectory(
          guardedDirectory,
          environment,
          identity(guardedDirectory),
          identity(derivations),
          { raceForTest: "insert-after-quarantine" },
        )).toThrow("only under the test runtime");
      } finally {
        if (previousNodeEnvironment === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
        else Reflect.set(process.env, "NODE_ENV", previousNodeEnvironment);
      }
      expect(existsSync(guardedDirectory)).toBeTrue();

      const insertionId = crypto.randomUUID();
      const insertionDirectory = join(derivations, insertionId);
      mkdirSync(insertionDirectory, { recursive: true, mode: 0o700 });
      expect(removePrivateEmptyStateDirectory(
        insertionDirectory,
        environment,
        identity(insertionDirectory),
        identity(derivations),
        { raceForTest: "insert-after-quarantine" },
      )).toBeFalse();
      expect(existsSync(insertionDirectory)).toBeFalse();
      const insertionQuarantine = readdirSync(derivations)
        .find((entry) => entry.startsWith(".io-remove-") && entry.endsWith(".quarantine"));
      expect(insertionQuarantine).toBeDefined();
      expect(readFileSync(join(derivations, insertionQuarantine ?? "missing", "arrived-late"), "utf8")).toBe("keep");
      listPrivateStateDirectory(
        derivations,
        environment,
        identity(derivations),
      );
      expect(readFileSync(
        join(derivations, insertionQuarantine ?? "missing", "arrived-late"),
        "utf8",
      )).toBe("keep");

      const replacementId = crypto.randomUUID();
      const replacementDirectory = join(derivations, replacementId);
      mkdirSync(replacementDirectory, { mode: 0o700 });
      const expectedIdentity = identity(replacementDirectory);
      expect(() => removePrivateEmptyStateDirectory(
        replacementDirectory,
        environment,
        expectedIdentity,
        identity(derivations),
        { raceForTest: "replace-target-after-validation" },
      )).toThrow("quarantine has the wrong identity");
      expect(existsSync(replacementDirectory)).toBeFalse();
      const entries = readdirSync(derivations);
      const replacementQuarantines = entries
        .filter((entry) => entry.startsWith(".io-remove-") && entry.endsWith(".quarantine"));
      expect(replacementQuarantines).toHaveLength(2);
      const replacementQuarantine = replacementQuarantines
        .find((entry) => !existsSync(join(derivations, entry, "arrived-late")));
      const preservedOriginal = entries.find((entry) => entry.startsWith(".wrench-test-preserved-"));
      expect(replacementQuarantine).toBeDefined();
      expect(preservedOriginal).toBeDefined();
      expect(identity(join(derivations, preservedOriginal ?? "missing"))).toEqual(expectedIdentity);
      expect(identity(join(derivations, replacementQuarantine ?? "missing"))).not.toEqual(expectedIdentity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves markerless UUID directories invalid instead of deleting unauthenticated state", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-markerless-state-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(expectedDirectory, "sentinel"), "keep", { mode: 0o600 });

      expect(listDerivations(environment)).toEqual([{ id, invalid: true }]);
      await expectRejectedWith(discardDerivation(id, environment), "session metadata");
      expect(readFileSync(join(expectedDirectory, "sentinel"), "utf8")).toBe("keep");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps valid legacy and interrupted sessions non-executable until a metadata-bound ready marker exists", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-unready-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const outputDirectory = join(root, "must-not-exist");
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeFileSync(
        join(expectedDirectory, "session.json"),
        JSON.stringify(sessionMetadata(id, expectedDirectory)),
        { mode: 0o600 },
      );

      expect(listDerivations(environment)).toEqual([{
        id,
        adapterId: "example",
        targetOrigin,
        createdAt: "2026-07-21T12:00:00.000Z",
        allowRemoteActions: false,
        contentMode: "none",
        headed: false,
        browserDomains: ["example.com"],
        rawHarPresent: false,
        reviewSealed: false,
        socketAvailable: true,
        ready: false,
        recoverable: true,
      }]);
      await expectRejectedWith(runDerivationBrowserCommand(id, ["reload"], environment), "not ready");
      await expectRejectedWith(
        reviewDerivation(id, { kind: "list", offset: 0, limit: 10 }, environment),
        "not ready",
      );
      await expectRejectedWith(
        finishDerivation(id, outputDirectory, { force: false, environment }),
        "not ready",
      );
      expect(existsSync(outputDirectory)).toBeFalse();

      rmSync(socketDirectory, { recursive: true });
      expect(await discardDerivation(id, environment)).toBeTrue();
      expect(existsSync(expectedDirectory)).toBeFalse();
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never executes a ready session after its final metadata file is replaced", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-ready-binding-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const metadataPath = join(expectedDirectory, "session.json");
    const displacedMetadataPath = join(expectedDirectory, "displaced-session.json");
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeSessionFixture(id, expectedDirectory);
      const metadataText = readFileSync(metadataPath, "utf8");
      renameSync(metadataPath, displacedMetadataPath);
      writeFileSync(metadataPath, metadataText, { mode: 0o600 });

      await expectRejectedWith(
        runDerivationBrowserCommand(id, ["reload"], environment),
        "does not match its final session metadata",
      );
      expect(listDerivations(environment)).toEqual([{ id, invalid: true }]);
      await expectRejectedWith(
        discardDerivation(id, environment),
        "does not match its final session metadata",
      );
      expect(existsSync(expectedDirectory)).toBeTrue();
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes browser and review windows while leaving list nonblocking", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-browser-review-gate-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeSessionFixture(id, expectedDirectory);

      const browserWindow = acquireDerivationLifecycleGate(id, environment);
      try {
        await expectRejectedWith(
          reviewDerivation(id, { kind: "list", offset: 0, limit: 10 }, environment),
          "lifecycle is busy",
        );
        expect(listDerivations(environment)).toHaveLength(1);
        expect(existsSync(join(expectedDirectory, "review.json"))).toBeFalse();
      } finally {
        browserWindow.release();
      }

      const reviewWindow = acquireDerivationLifecycleGate(id, environment);
      try {
        await expectRejectedWith(
          runDerivationBrowserCommand(id, ["reload"], environment),
          "lifecycle is busy",
        );
      } finally {
        reviewWindow.release();
      }
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes finish and review before output preflight or HAR sealing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-finish-review-gate-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const outputDirectory = join(root, "must-not-exist");
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeSessionFixture(id, expectedDirectory);

      const finishWindow = acquireDerivationLifecycleGate(id, environment);
      try {
        await expectRejectedWith(
          reviewDerivation(id, { kind: "list", offset: 0, limit: 10 }, environment),
          "lifecycle is busy",
        );
      } finally {
        finishWindow.release();
      }
      const reviewWindow = acquireDerivationLifecycleGate(id, environment);
      try {
        await expectRejectedWith(
          finishDerivation(id, outputDirectory, { force: false, environment }),
          "lifecycle is busy",
        );
        expect(existsSync(outputDirectory)).toBeFalse();
        expect(existsSync(join(expectedDirectory, "review.json"))).toBeFalse();
      } finally {
        reviewWindow.release();
      }
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers crashed lifecycle owners only after the full heartbeat grace", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-crash-gate-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      await leaveCrashedLifecycleGate(id, wrenchState);
      expect(() => acquireDerivationLifecycleGate(id, environment)).toThrow("lifecycle is busy");
      const recovered = acquireDerivationLifecycleGate(id, environment, {
        nowMs: Date.now() + DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS + 60_000,
      });
      recovered.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps the exact live lifecycle owner busy beyond the stale-heartbeat grace", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-exact-owner-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      const gate = acquireDerivationLifecycleGate(id, environment);
      try {
        expect(() => acquireDerivationLifecycleGate(id, environment, {
          nowMs: Date.now() + DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS + 60_000,
        })).toThrow("lifecycle is busy");
      } finally {
        gate.release();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers a stale lock when its PID was reused by a different process start", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-pid-reuse-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      const lockPath = await leaveCrashedLifecycleGate(id, wrenchState);
      const ownerPath = join(lockPath, "owner.json");
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
      writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: process.pid }), { mode: 0o600 });

      const recovered = acquireDerivationLifecycleGate(id, environment, {
        nowMs: Date.now() + DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS + 60_000,
      });
      recovered.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers a stale lock from a previous boot even when its PID is currently live", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-reboot-owner-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      const lockPath = await leaveCrashedLifecycleGate(id, wrenchState);
      const ownerPath = join(lockPath, "owner.json");
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
      const bootId = typeof owner.bootId === "string" ? owner.bootId : "";
      expect(bootId).toHaveLength(64);
      const differentBootId = `${bootId.startsWith("0") ? "1" : "0"}${bootId.slice(1)}`;
      writeFileSync(ownerPath, JSON.stringify({
        ...owner,
        pid: process.pid,
        bootId: differentBootId,
      }), { mode: 0o600 });

      const recovered = acquireDerivationLifecycleGate(id, environment, {
        nowMs: Date.now() + DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS + 60_000,
      });
      recovered.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains a markerless acquisition crash for the full recovery grace", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-markerless-gate-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      const seed = acquireDerivationLifecycleGate(crypto.randomUUID(), environment);
      seed.release();
      const lockPath = join(wrenchState, "derivations", `.lifecycle-${id}`);
      mkdirSync(lockPath, { mode: 0o700 });
      expect(() => acquireDerivationLifecycleGate(id, environment)).toThrow("lifecycle is busy");
      const recovered = acquireDerivationLifecycleGate(id, environment, {
        nowMs: Date.now() + DERIVATION_LIFECYCLE_ORPHAN_GRACE_MS + 60_000,
      });
      recovered.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not delete a replacement lifecycle lock during stale release", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-lock-aba-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      const gate = acquireDerivationLifecycleGate(id, environment);
      const displaced = join(wrenchState, "derivations", `.displaced-${id}`);
      renameSync(gate.path, displaced);
      mkdirSync(gate.path, { mode: 0o700 });
      expect(() => gate.release()).toThrow("ownership was lost");
      expect(existsSync(gate.path)).toBeTrue();
      expect(existsSync(displaced)).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lists and discards a retained derivation after its ephemeral socket disappears", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-missing-socket-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const outputDirectory = join(root, "must-not-be-created");
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeSessionFixture(id, expectedDirectory);
      writeFileSync(join(expectedDirectory, "capture.har"), '{"retained":"private"}\n', { mode: 0o600 });
      rmSync(socketDirectory, { recursive: true });

      expect(listDerivations(environment)).toEqual([{
        id,
        adapterId: "example",
        targetOrigin,
        createdAt: "2026-07-21T12:00:00.000Z",
        allowRemoteActions: false,
        contentMode: "none",
        headed: false,
        browserDomains: ["example.com"],
        rawHarPresent: true,
        reviewSealed: false,
        socketAvailable: false,
        ready: true,
      }]);
      await expectRejectedWith(
        runDerivationBrowserCommand(id, ["reload"], environment),
        "socket directory is unavailable",
      );
      await expectRejectedWith(
        reviewDerivation(id, { kind: "list", offset: 0, limit: 10 }, environment),
        "socket directory is unavailable",
      );
      await expectRejectedWith(
        finishDerivation(id, outputDirectory, { force: false, environment }),
        "socket directory is unavailable",
      );
      expect(existsSync(outputDirectory)).toBeFalse();

      expect(await discardDerivation(id, environment)).toBeTrue();
      expect(existsSync(expectedDirectory)).toBeFalse();
      expect(await discardDerivation(id, environment)).toBeFalse();
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not treat a replacement socket directory as recoverably missing", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-replaced-socket-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const replacementSocketDirectory = `${socketDirectory}-replacement`;
    const environment = { WRENCH_STATE_HOME: wrenchState };
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeSessionFixture(id, expectedDirectory);
      mkdirSync(replacementSocketDirectory, { mode: 0o700 });
      expect(lstatSync(replacementSocketDirectory, { bigint: true }).ino)
        .not.toBe(lstatSync(socketDirectory, { bigint: true }).ino);
      rmSync(socketDirectory, { recursive: true });
      renameSync(replacementSocketDirectory, socketDirectory);

      expect(listDerivations(environment)).toEqual([{ id, invalid: true }]);
      await expectRejectedWith(
        discardDerivation(id, environment),
        "socket directory changed identity",
      );
      expect(existsSync(expectedDirectory)).toBeTrue();
    } finally {
      rmSync(replacementSocketDirectory, { recursive: true, force: true });
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reviews an identity-bound retained HAR without reopening the browser and rejects later tampering", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-review-state-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(process.platform === "win32" ? tmpdir() : "/tmp", `io-derive-ab-${id}`);
    const harPath = join(expectedDirectory, "capture.har");
    const markerPath = join(expectedDirectory, "review.json");
    const harText = JSON.stringify({
      log: {
        entries: [{
          request: {
            method: "POST",
            url: "https://example.com/api/messages/conversation-one",
            headers: [{ name: "authorization", value: "Bearer never-print-this" }],
            postData: { mimeType: "application/json", text: JSON.stringify({ body: { text: "message-one" } }) },
          },
          response: {
            status: 200,
            content: { mimeType: "application/json", text: JSON.stringify({ data: { id: "message-id-one" } }) },
          },
        }],
      },
    });
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(join(expectedDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(expectedDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeSessionFixture(id, expectedDirectory, { contentMode: "text" });
      writeFileSync(harPath, harText, { mode: 0o600 });
      const stats = lstatSync(harPath, { bigint: true });
      const directoryStats = lstatSync(expectedDirectory, { bigint: true });
      const seal = {
        schemaVersion: 1,
        state: "sealed",
        har: {
          device: stats.dev.toString(),
          inode: stats.ino.toString(),
          byteLength: Buffer.byteLength(harText, "utf8"),
          sha256: sha256(harText),
        },
      } as const;
      const environment = { WRENCH_STATE_HOME: wrenchState };
      const expectedStateParent = {
        device: directoryStats.dev.toString(),
        inode: directoryStats.ino.toString(),
      };
      expect(createPrivateJsonIfAbsent(markerPath, seal, {
        environment,
        expectedStateParent,
        beforePublish: () => {
          expect(createPrivateJsonIfAbsent(markerPath, seal, {
            environment,
            expectedStateParent,
          })).toEqual({ created: true });
        },
      })).toEqual({ created: false });

      expect(await reviewDerivation(id, { kind: "list", offset: 0, limit: 10 }, environment)).toMatchObject({
        kind: "list",
        reviewableEntries: 1,
        entries: [{ entryIndex: 0, method: "POST", path: "/api/messages/:segment1" }],
      });
      const exact = await reviewDerivation(id, {
        kind: "entry",
        entryIndex: 0,
        fixtures: { message_text: "message-one", header_secret: "never-print-this" },
      }, environment);
      expect(exact).toMatchObject({
        kind: "entry",
        fixtureMatches: [
          { label: "message_text", locations: ["request.body.body.text"] },
          { label: "header_secret", locations: [] },
        ],
      });
      expect(JSON.stringify(exact)).not.toContain("message-one");
      expect(JSON.stringify(exact)).not.toContain("never-print-this");
      await expectRejectedWith(
        runDerivationBrowserCommand(id, ["reload"], environment),
        "sealed for private review",
      );

      writeFileSync(harPath, harText.replace("message-one", "message-two"), { mode: 0o600 });
      await expectRejectedWith(
        reviewDerivation(id, { kind: "list", offset: 0, limit: 10 }, environment),
        "changed after it was sealed",
      );
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the caller's active registry when finishing a sealed derivation", async () => {
    const root = realpathSync(mkdtempSync(
      join(tmpdir(), "wrench-derive-finish-registry-test-"),
    ));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const socketDirectory = join(
      process.platform === "win32" ? tmpdir() : "/tmp",
      `io-derive-ab-${id}`,
    );
    const outputDirectory = join(root, "derived");
    const environment = { WRENCH_STATE_HOME: wrenchState };
    const harText = JSON.stringify({ log: { entries: [] } });
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(socketDirectory, { mode: 0o700 });
      writeFileSync(
        join(expectedDirectory, "agent-browser.json"),
        "{}\n",
        { mode: 0o600 },
      );
      writeFileSync(
        join(expectedDirectory, "action-policy.json"),
        "{}\n",
        { mode: 0o600 },
      );
      writeSessionFixture(id, expectedDirectory);
      const harPath = join(expectedDirectory, "capture.har");
      writeFileSync(harPath, harText, { mode: 0o600 });
      const harStats = lstatSync(harPath, { bigint: true });
      writeFileSync(join(expectedDirectory, "review.json"), JSON.stringify({
        schemaVersion: 1,
        state: "sealed",
        har: {
          device: harStats.dev.toString(),
          inode: harStats.ino.toString(),
          byteLength: Buffer.byteLength(harText, "utf8"),
          sha256: sha256(harText),
        },
      }), { mode: 0o600 });

      let registryListCalls = 0;
      const registry: ProviderPluginRegistry = Object.freeze({
        ...providerPluginRegistry,
        list: () => {
          registryListCalls += 1;
          return providerPluginRegistry.list();
        },
      });
      await expectRejectedWith(
        finishDerivationWithRegistry(id, outputDirectory, {
          force: false,
          environment,
          registry,
        }),
        "finished its scaffold but the browser could not be closed",
      );
      expect(registryListCalls).toBeGreaterThan(0);
      expect(JSON.parse(
        readFileSync(join(outputDirectory, "wrench-adapter.json"), "utf8"),
      )).toMatchObject({
        schemaVersion: 5,
        id: "example",
        origins: [targetOrigin],
      });
      expect(existsSync(expectedDirectory)).toBeTrue();
      expect(existsSync(harPath)).toBeTrue();
    } finally {
      rmSync(socketDirectory, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(["..", ".", "--config", " leading-space", "trailing-space ", "name\u0000suffix"])(
    "rejects unsafe named profile metadata %j before launching or deleting",
    async (profilePath) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-profile-test-")));
      const wrenchState = join(root, "io-state");
      const id = crypto.randomUUID();
      const expectedDirectory = join(wrenchState, "derivations", id);
      try {
        mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(join(expectedDirectory, "sentinel"), "keep me", { mode: 0o600 });
        writeFileSync(
          join(expectedDirectory, "session.json"),
          JSON.stringify(sessionMetadata(id, expectedDirectory, { profilePath })),
          { mode: 0o600 },
        );

        await expectRejectedWith(discardDerivation(id, { WRENCH_STATE_HOME: wrenchState }), "paths do not match");
        expect(readFileSync(join(expectedDirectory, "sentinel"), "utf8")).toBe("keep me");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("rejects tampered deletion paths before deleting either tree", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-path-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const expectedDirectory = join(wrenchState, "derivations", id);
    const unrelatedDirectory = join(root, "must-survive");
    try {
      mkdirSync(expectedDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(unrelatedDirectory, { mode: 0o700 });
      writeFileSync(join(unrelatedDirectory, "sentinel"), "keep me", { mode: 0o600 });
      writeFileSync(
        join(expectedDirectory, "session.json"),
        JSON.stringify(sessionMetadata(id, unrelatedDirectory)),
        { mode: 0o600 },
      );

      await expectRejectedWith(discardDerivation(id, { WRENCH_STATE_HOME: wrenchState }), "paths do not match");
      expect(readFileSync(join(unrelatedDirectory, "sentinel"), "utf8")).toBe("keep me");
      expect(existsSync(expectedDirectory)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a symlinked session directory without deleting its target", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-derive-symlink-test-")));
    const wrenchState = join(root, "io-state");
    const id = crypto.randomUUID();
    const derivations = join(wrenchState, "derivations");
    const linkedDirectory = join(derivations, id);
    const externalDirectory = join(root, "external-session");
    try {
      mkdirSync(derivations, { recursive: true, mode: 0o700 });
      mkdirSync(externalDirectory, { mode: 0o700 });
      writeFileSync(join(externalDirectory, "agent-browser.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(externalDirectory, "action-policy.json"), "{}\n", { mode: 0o600 });
      writeFileSync(join(externalDirectory, "sentinel"), "keep me", { mode: 0o600 });
      writeFileSync(
        join(externalDirectory, "session.json"),
        JSON.stringify(sessionMetadata(id, linkedDirectory)),
        { mode: 0o600 },
      );
      symlinkSync(externalDirectory, linkedDirectory);

      await expectRejectedWith(discardDerivation(id, { WRENCH_STATE_HOME: wrenchState }), "unsafe");
      expect(readFileSync(join(externalDirectory, "sentinel"), "utf8")).toBe("keep me");
      expect(lstatSync(linkedDirectory).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("derivation scaffold boundaries", () => {
  const analysis = analyzeHarValue(
    { log: { entries: [] } },
    "example",
    targetOrigin,
    new Date("2026-07-21T12:00:00.000Z"),
  );

  test.each([
    ["https://www.linkedin.com", 4, "linkedin"],
    ["https://x.com", 4, "x"],
    ["https://mobile.twitter.com", 4, undefined],
    ["https://example.net", 5, undefined],
  ] as const)(
    "accepts direct internal-API evidence for %s with the expected schema",
    (origin, schemaVersion, surfaceId) => {
      const root = mkdtempSync(join(tmpdir(), "wrench-reviewed-surface-scaffold-"));
      const output = join(root, "adapter");
      try {
        const analysis = analyzeHarValue(
        { log: { entries: [] } },
        "provider-browser",
        origin,
        new Date("2026-07-21T12:00:00.000Z"),
        );
        const written = writeDerivationScaffold(output, analysis, { force: false });
        expect(JSON.parse(readFileSync(written.manifestPath, "utf8"))).toMatchObject({
          schemaVersion,
          origins: [origin],
          ...(surfaceId === undefined ? {} : { surfaceId }),
        });
        const reservation = JSON.parse(readFileSync(written.reservationPath, "utf8")) as {
          readonly instructions: readonly string[];
        };
        expect(reservation).toMatchObject({
          state: "capture-required",
          targetOrigin: origin,
          targetManifestSchemaVersion: schemaVersion,
        });
        expect(reservation.instructions.join(" ")).not.toContain("set to reviewed");
        if (schemaVersion === 5) {
          expect(reservation.instructions.join(" ")).toContain("cannot plan or execute even an R1 read");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("creates first-run nested parents and private outputs", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-scaffold-first-run-"));
    try {
      const output = join(root, "new", "nested", "adapter");
      const written = writeDerivationScaffold(output, analysis, { force: false });
      expect(lstatSync(output).mode & 0o777).toBe(0o700);
      expect(lstatSync(written.manifestPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(written.candidatesPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(written.reservationPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(written.manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 5,
        id: "example",
        origins: [targetOrigin],
        browserDomains: ["example.com"],
      });
      expect(JSON.parse(readFileSync(written.reservationPath, "utf8"))).toMatchObject({
        state: "capture-required",
        targetOrigin,
        targetManifestSchemaVersion: 5,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflights an existing output before changing its contents", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-scaffold-collision-"));
    const output = join(root, "adapter");
    try {
      mkdirSync(output, { mode: 0o700 });
      writeFileSync(join(output, "sentinel"), "original", { mode: 0o600 });
      expect(() => assertScaffoldOutput(output, false)).toThrow("output already exists");
      expect(() => writeDerivationScaffold(output, analysis, { force: false })).toThrow("output already exists");
      expect(readFileSync(join(output, "sentinel"), "utf8")).toBe("original");
      expect(existsSync(join(output, "wrench-adapter.json"))).toBe(false);
      expect(existsSync(join(output, "derivation.candidates.json"))).toBe(false);
      expect(existsSync(join(output, "reviewed-template.reservation.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks a live sibling transaction and leaves no partial first-write scaffold", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-scaffold-lock-"));
    const output = join(root, "adapter");
    const activeStage = join(root, `.adapter.wrench-scaffold-stage-${process.pid}-${crypto.randomUUID()}`);
    try {
      mkdirSync(activeStage, { mode: 0o700 });
      expect(() => writeDerivationScaffold(output, analysis, { force: false })).toThrow("owns a transaction");
      expect(existsSync(output)).toBeFalse();
      rmSync(activeStage, { recursive: true, force: true });

      const malformed = { ...analysis, observedEntries: 1n } as unknown as typeof analysis;
      expect(() => writeDerivationScaffold(output, malformed, { force: false })).toThrow("JSON-compatible");
      expect(existsSync(output)).toBeFalse();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers a dead whole-directory transaction before a forced update", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-scaffold-recovery-"));
    const output = join(root, "adapter");
    const token = `99999999-${crypto.randomUUID()}`;
    const backup = join(root, `.adapter.oh-scaffold-backup-${token}`);
    const staleStage = join(root, `.adapter.oh-scaffold-stage-${token}`);
    try {
      mkdirSync(backup, { mode: 0o700 });
      writeFileSync(join(backup, "sentinel"), "preserved", { mode: 0o600 });
      mkdirSync(staleStage, { mode: 0o700 });
      writeDerivationScaffold(output, analysis, { force: true });
      expect(readFileSync(join(output, "sentinel"), "utf8")).toBe("preserved");
      expect(existsSync(backup)).toBeFalse();
      expect(existsSync(staleStage)).toBeFalse();
      expect(readdirSync(root)).toEqual(["adapter"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a crowded parent could hide a transaction artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-scaffold-crowded-parent-"));
    const output = join(root, "adapter");
    try {
      for (let index = 0; index <= 10_000; index += 1) mkdirSync(join(root, `entry-${index}`));
      const backup = join(root, `.adapter.wrench-scaffold-backup-99999999-${crypto.randomUUID()}`);
      mkdirSync(backup, { mode: 0o700 });
      writeFileSync(join(backup, "sentinel"), "recover me", { mode: 0o600 });
      expect(() => writeDerivationScaffold(output, analysis, { force: true }))
        .toThrow("lacks bounded capacity");
      expect(readFileSync(join(output, "sentinel"), "utf8")).toBe("recover me");
      expect(existsSync(backup)).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows force only for a real directory and does not remove unrelated files", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-scaffold-force-"));
    const output = join(root, "adapter");
    try {
      mkdirSync(output, { mode: 0o700 });
      writeFileSync(join(output, "sentinel"), "preserve", { mode: 0o600 });
      writeDerivationScaffold(output, analysis, { force: true });
      expect(readFileSync(join(output, "sentinel"), "utf8")).toBe("preserve");

      const outputFile = join(root, "output-file");
      writeFileSync(outputFile, "not a directory", { mode: 0o600 });
      expect(() => writeDerivationScaffold(outputFile, analysis, { force: true })).toThrow("real directory");

      const linkedOutput = join(root, "linked-output");
      symlinkSync(output, linkedOutput);
      expect(() => writeDerivationScaffold(linkedOutput, analysis, { force: true })).toThrow("real directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves strict output modes even when the process umask is permissive", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-scaffold-mode-"));
    chmodSync(root, 0o777);
    try {
      const output = join(root, "adapter");
      const written = writeDerivationScaffold(output, analysis, { force: false });
      expect(lstatSync(output).mode & 0o777).toBe(0o700);
      expect(lstatSync(written.manifestPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(written.candidatesPath).mode & 0o777).toBe(0o600);
      expect(lstatSync(written.reservationPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
