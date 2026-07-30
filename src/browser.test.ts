import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import type { WrenchAuth } from "./auth";
import {
  browserCleanupBarrier,
  browserResultData,
  classifyBrowserProcessGroupProbe,
  cloneBrowserProfile,
  cloneProfile,
  createBrowserSession,
  executeBrowserRecipe,
  isolatedEnvironment,
  parseBrowserRecoveryHandle,
  parseLastJson,
  PreservedBrowserArtifactsError,
  profilePath,
  runCommand,
  runtimeBrowserPolicyActions,
} from "./browser";
import type { BrowserRecipe, WrenchManifest } from "./model";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "./operation-deadline";

const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;
const TEST_PROCESS_TIMEOUT_MS = 90_000;

class FakeMonotonicClock implements OperationDeadlineClock {
  #nowMs = 0;
  #nextId = 1;
  readonly #scheduled = new Map<number, {
    readonly at: number;
    readonly callback: () => void;
  }>();

  readonly now = (): number => this.#nowMs;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#scheduled.set(id, { at: this.#nowMs + delayMs, callback });
    return () => {
      this.#scheduled.delete(id);
    };
  };

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, value]) => value.at <= this.#nowMs)
        .sort((left, right) =>
          left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }
}

async function waitUntil(
  condition: () => boolean,
  maximumMs = TEST_CHILD_SIGNAL_TIMEOUT_MS,
): Promise<void> {
  const deadline = performance.now() + maximumMs;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

async function rejectionValue(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to reject");
}

function decodeBrowserRecoveryHandle(handle: string): Readonly<Record<
  "session" | "config" | "socket" | "artifacts",
  string
>> {
  const [version, ...segments] = handle.split(";");
  if (version !== "v1" || segments.length !== 4) {
    throw new Error("browser recovery handle has an unexpected version");
  }
  const decoded: Partial<Record<
    "session" | "config" | "socket" | "artifacts",
    string
  >> = {};
  for (const segment of segments) {
    const separator = segment.indexOf("=");
    if (separator < 1) throw new Error("browser recovery handle is malformed");
    const label = segment.slice(0, separator);
    if (
      label !== "session"
      && label !== "config"
      && label !== "socket"
      && label !== "artifacts"
    ) throw new Error("browser recovery handle has an unknown field");
    decoded[label] = Buffer.from(
      segment.slice(separator + 1),
      "base64url",
    ).toString("utf8");
  }
  if (
    decoded.session === undefined
    || decoded.config === undefined
    || decoded.socket === undefined
    || decoded.artifacts === undefined
  ) throw new Error("browser recovery handle omitted a field");
  return decoded as Readonly<Record<
    "session" | "config" | "socket" | "artifacts",
    string
  >>;
}

const manifest: WrenchManifest = {
  schemaVersion: 1,
  id: "example",
  version: "1.0.0",
  displayName: "Example",
  origins: ["https://example.com"],
  browserDomains: ["example.com", "*.example.com"],
  operations: {},
};

const auth: WrenchAuth = {
  schemaVersion: 1,
  id: "example",
  kind: "cookie-source",
  source: "chrome",
};

describe("retired DOM recipe boundary", () => {
  test("rejects every direct recipe execution before browser startup", () => {
    let startupCalls = 0;
    const recipe: BrowserRecipe = {
      steps: [{ kind: "navigate", path: "/" }, { kind: "read" }],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    };
    expect(executeBrowserRecipe(manifest, recipe, {}, auth, {
      headed: false,
      createSession: () => {
        startupCalls += 1;
        throw new Error("must not start");
      },
    })).rejects.toThrow("runtime DOM action recipes are disabled");
    expect(startupCalls).toBe(0);
  });
});

describe("browser process isolation helpers", () => {
  test("patched Chromium provider honors an explicit keychain for custom profile paths", async () => {
    const sweetCookieRoot = dirname(
      createRequire(import.meta.url).resolve("@steipete/sweet-cookie/package.json"),
    );
    const providerPath = [
      join(sweetCookieRoot, "dist", "providers", "chromeSqliteMac.js"),
      join(
        sweetCookieRoot,
        "packages",
        "core",
        "dist",
        "providers",
        "chromeSqliteMac.js",
      ),
    ].find(existsSync);
    if (providerPath === undefined) {
      throw new Error(
        "the pinned Sweet Cookie Chromium keychain seam is unavailable",
      );
    }
    type KeychainTarget = {
      readonly account: string;
      readonly services: readonly string[];
      readonly label: string;
    };
    type KeychainResolver = (
      dbPath: string,
      browser?: "chrome" | "brave" | "arc" | "chromium",
    ) => KeychainTarget;
    const providerModule: unknown = await import(pathToFileURL(providerPath).href);
    if (
      typeof providerModule !== "object"
      || providerModule === null
      || !("resolveKeychainForDb" in providerModule)
      || typeof providerModule.resolveKeychainForDb !== "function"
    ) throw new Error("the pinned Sweet Cookie Chromium keychain seam is unavailable");
    const resolveKeychain = providerModule.resolveKeychainForDb as KeychainResolver;

    expect(resolveKeychain(
      "/Users/example/Library/Application Support/Google/Chrome for Testing/Default/Cookies",
      "chromium",
    )).toEqual({
      account: "Chromium",
      services: ["Chromium Safe Storage"],
      label: "Chromium Safe Storage",
    });
    expect(resolveKeychain(
      "/Users/example/Library/Application Support/Chromium/Default/Cookies",
      "chrome",
    )).toEqual({
      account: "Chrome",
      services: ["Chrome Safe Storage"],
      label: "Chrome Safe Storage",
    });
    expect(resolveKeychain(
      "/Users/example/Library/Application Support/Arc/User Data/Default/Cookies",
    )).toEqual({
      account: "Arc",
      services: ["Arc Safe Storage"],
      label: "Arc Safe Storage",
    });
  });

  test("authorizes the pinned concrete actions emitted by every semantic recipe primitive", () => {
    for (const action of [
      "getbyrole", "getbytext", "getbylabel", "getbyplaceholder", "getbyalttext", "getbytitle", "getbytestid",
      "fill", "type", "hover", "focus", "click", "press", "upload", "select", "check", "uncheck", "ischecked",
      "waitfortext", "waitforurl", "url", "inputvalue", "close",
    ]) expect(runtimeBrowserPolicyActions.includes(action as (typeof runtimeBrowserPolicyActions)[number])).toBeTrue();
    expect(runtimeBrowserPolicyActions).not.toContain("evaluate");
  });

  test("treats a permission-denied process-group probe as live", () => {
    expect(classifyBrowserProcessGroupProbe(
      1,
      "kill: (-43124) - Operation not permitted\n",
    )).toBe("live");
    expect(classifyBrowserProcessGroupProbe(
      1,
      "kill: (-43124) - No such process\n",
    )).toBe("gone");
  });

  test("adds pinned evaluation only for an explicit code-owned session", async () => {
    const observedPolicies: string[][] = [];
    for (const allowCodeOwnedEvaluation of [false, true]) {
      let observed: string[] | null = null;
      const session = await createBrowserSession(manifest, auth, {
        headed: false,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
        ...(allowCodeOwnedEvaluation ? { allowCodeOwnedEvaluation: true } : {}),
        dependencies: {
          runCommand: (command, options) => {
            const policyIndex = command.indexOf("--action-policy");
            if (policyIndex >= 0) {
              const policyPath = command[policyIndex + 1];
              if (policyPath === undefined) throw new Error("missing fake action policy path");
              const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { readonly allow?: unknown };
              if (!Array.isArray(policy.allow) || !policy.allow.every((item) => typeof item === "string")) {
                throw new Error("invalid fake action policy");
              }
              observed = [...policy.allow];
            }
            if (command.includes("batch")) {
              const batch = JSON.parse(options.stdin ?? "[]") as readonly unknown[];
              return Promise.resolve({
                stdout: `${JSON.stringify(batch.map(() => ({ success: true, data: null })))}\n`,
                stderr: "",
                exitCode: 0,
              });
            }
            return Promise.resolve({ stdout: "{\"success\":true}\n", stderr: "", exitCode: 0 });
          },
          startNetworkProxy: () => Promise.resolve({
            url: "http://127.0.0.1:43124",
            port: 43_124,
            close: () => Promise.resolve(),
          }),
          acquireCookieRecords: () => Promise.resolve({ cookies: [], warnings: [] }),
        },
      });
      await session.close();
      await session.cleanup();
      if (observed === null) throw new Error("fake browser did not observe an action policy");
      observedPolicies.push(observed);
    }
    expect(observedPolicies[0]).not.toContain("evaluate");
    expect(observedPolicies[1]).toContain("evaluate");
  });

  test("publishes inode-bound cleanup identity before any proxy or browser can launch", async () => {
    const events: string[] = [];
    let published:
      | Parameters<
          NonNullable<
            Parameters<typeof createBrowserSession>[2]["publishCleanupResource"]
          >
        >[0]
      | undefined;
    const session = await createBrowserSession(manifest, auth, {
      headed: false,
      timeoutMs: 1_000,
      maxOutputBytes: 64 * 1024,
      publishCleanupResource: (resource) => {
        expect(events).toEqual([]);
        events.push("published");
        published = resource;
        const socket = lstatSync(resource.socketDirectory, {
          bigint: true,
        });
        const artifacts = lstatSync(resource.artifactsDirectory, {
          bigint: true,
        });
        expect(resource.socketDirectoryIdentity).toEqual({
          device: socket.dev.toString(),
          inode: socket.ino.toString(),
        });
        expect(resource.artifactsDirectoryIdentity).toEqual({
          device: artifacts.dev.toString(),
          inode: artifacts.ino.toString(),
        });
      },
      dependencies: {
        startNetworkProxy: () => {
          expect(events).toEqual(["published"]);
          events.push("proxy");
          return Promise.resolve({
            url: "http://127.0.0.1:43124",
            port: 43_124,
            close: () => Promise.resolve(),
          });
        },
        runCommand: (command, options) => {
          expect(events[0]).toBe("published");
          events.push("command");
          if (command.includes("batch")) {
            const batch = JSON.parse(
              options.stdin ?? "[]",
            ) as readonly unknown[];
            return Promise.resolve({
              stdout: `${JSON.stringify(batch.map(() => ({
                success: true,
                data: null,
              })))}\n`,
              stderr: "",
              exitCode: 0,
            });
          }
          return Promise.resolve({
            stdout: "{\"success\":true}\n",
            stderr: "",
            exitCode: 0,
          });
        },
        acquireCookieRecords: () =>
          Promise.resolve({ cookies: [], warnings: [] }),
      },
    });
    try {
      if (published === undefined) {
        throw new Error("browser cleanup resource was not published");
      }
      expect(parseBrowserRecoveryHandle(
        published.recoveryHandle,
      )).toMatchObject({
        session: published.session,
        socketDirectory: published.socketDirectory,
        artifactsDirectory: published.artifactsDirectory,
      });
      expect(session.cleanupResourceIdentity).toEqual(published);
      await session.close();
      await session.cleanup();
    } finally {
      if (session.cleanupResourceIdentity !== undefined) {
        rmSync(session.cleanupResourceIdentity.socketDirectory, {
          recursive: true,
          force: true,
        });
        rmSync(session.cleanupResourceIdentity.artifactsDirectory, {
          recursive: true,
          force: true,
        });
      }
    }
  });

  test("strips inherited agent-browser and proxy settings", () => {
    const environment = isolatedEnvironment("/tmp/wrench-test-socket", {
      PATH: "/usr/bin:/bin",
      AGENT_BROWSER_SESSION: "ambient-session",
      HTTPS_PROXY: "http://ambient-proxy.invalid",
      http_proxy: "http://ambient-proxy.invalid",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      AGENT_BROWSER_SOCKET_DIR: "/tmp/wrench-test-socket",
    });
  });

  test("parses only the last valid JSON diagnostic line", () => {
    expect(parseLastJson("diagnostic\n{not json}\n{\"success\":true}\nignored-after\n")).toEqual({ success: true });
    expect(() => parseLastJson("diagnostic only\n")).toThrow("did not return JSON");
  });

  test("reads pinned batch result envelopes and rejects missing results", () => {
    expect(browserResultData({ success: true, result: { url: "https://example.com/" } })).toEqual({ url: "https://example.com/" });
    expect(browserResultData({ success: true, data: { url: "https://legacy.example/" } })).toEqual({ url: "https://legacy.example/" });
    expect(() => browserResultData({ success: true })).toThrow("omitted its result");
    expect(() => browserResultData({ success: false, error: "denied" })).toThrow("denied");
  });

  test("clones profiles without symlinks, cache directories, or lock files", () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-profile-test-"));
    chmodSync(directory, 0o700);
    try {
      const source = join(directory, "source");
      const destination = join(directory, "destination");
      mkdirSync(source);
      writeFileSync(join(source, "Cookies"), "cookie-db", { mode: 0o600 });
      writeFileSync(join(source, "SingletonLock"), "lock", { mode: 0o600 });
      mkdirSync(join(source, "Cache"));
      writeFileSync(join(source, "Cache", "cached"), "cache", { mode: 0o600 });
      symlinkSync(join(source, "Cookies"), join(source, "linked-secret"));

      cloneProfile(source, destination);
      expect(existsSync(join(destination, "Cookies"))).toBeTrue();
      expect(existsSync(join(destination, "SingletonLock"))).toBeFalse();
      expect(existsSync(join(destination, "Cache"))).toBeFalse();
      expect(existsSync(join(destination, "linked-secret"))).toBeFalse();
      expect(lstatSync(destination).isDirectory()).toBeTrue();

      const sourceLink = join(directory, "source-link");
      symlinkSync(source, sourceLink);
      expect(() => cloneProfile(sourceLink, join(directory, "linked-destination"))).toThrow("real directory");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("maps one selected Chromium profile into a private Default user-data snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-selected-profile-test-"));
    chmodSync(directory, 0o700);
    try {
      const userData = join(directory, "Arc User Data");
      const source = join(userData, "Profile 1");
      const privateRoot = join(directory, "private");
      mkdirSync(userData);
      mkdirSync(source);
      mkdirSync(privateRoot, { mode: 0o700 });
      mkdirSync(join(source, "Local Storage"));
      mkdirSync(join(source, "IndexedDB"));
      mkdirSync(join(source, "Cache"));
      writeFileSync(join(userData, "Local State"), "{\"os_crypt\":{\"encrypted_key\":\"bounded\"}}", { mode: 0o600 });
      writeFileSync(join(source, "Preferences"), "{\"selected\":true}", { mode: 0o600 });
      writeFileSync(join(source, "Local Storage", "state"), "signed-in-local-state", { mode: 0o600 });
      writeFileSync(join(source, "IndexedDB", "state"), "signed-in-indexed-db", { mode: 0o600 });
      writeFileSync(join(source, "Cache", "discard"), "cache", { mode: 0o600 });
      const beforeLocalState = readFileSync(join(userData, "Local State"));
      const beforePreferences = readFileSync(join(source, "Preferences"));

      const cloned = cloneBrowserProfile(realpathSync(source), privateRoot);
      const clonedProfile = join(cloned.userDataPath, cloned.profileDirectory ?? "");

      expect(cloned).toEqual({
        userDataPath: join(privateRoot, "profile-user-data"),
        profileDirectory: "Default",
      });
      expect(readFileSync(join(privateRoot, "profile-user-data", "Local State"))).toEqual(beforeLocalState);
      expect(readFileSync(join(clonedProfile, "Preferences"))).toEqual(beforePreferences);
      expect(readFileSync(join(clonedProfile, "Local Storage", "state"), "utf8")).toBe("signed-in-local-state");
      expect(readFileSync(join(clonedProfile, "IndexedDB", "state"), "utf8")).toBe("signed-in-indexed-db");
      expect(existsSync(join(clonedProfile, "Cache"))).toBeFalse();
      expect(lstatSync(join(privateRoot, "profile-user-data")).mode & 0o777).toBe(0o700);
      expect(lstatSync(clonedProfile).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(privateRoot, "profile-user-data", "Local State")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(userData, "Local State"))).toEqual(beforeLocalState);
      expect(readFileSync(join(source, "Preferences"))).toEqual(beforePreferences);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps generic custom and named profiles compatible", () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-generic-profile-test-"));
    chmodSync(directory, 0o700);
    try {
      const source = join(directory, "custom-profile");
      const privateRoot = join(directory, "private");
      mkdirSync(source);
      mkdirSync(privateRoot, { mode: 0o700 });
      writeFileSync(join(source, "state"), "custom-state", { mode: 0o600 });
      const cloned = cloneBrowserProfile(realpathSync(source), privateRoot);
      expect(cloned).toEqual({ userDataPath: join(privateRoot, "profile") });
      expect(readFileSync(join(cloned.userDataPath, "state"), "utf8")).toBe("custom-state");
      expect(profilePath("Work")).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on linked, nonregular, or oversized Chromium Local State", () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-local-state-bound-test-"));
    chmodSync(directory, 0o700);
    try {
      const linkedData = join(directory, "linked-data");
      const linkedProfile = join(linkedData, "Profile 1");
      const linkedPrivate = join(directory, "linked-private");
      mkdirSync(linkedData);
      mkdirSync(linkedProfile);
      mkdirSync(linkedPrivate, { mode: 0o700 });
      writeFileSync(join(directory, "real-local-state"), "{}", { mode: 0o600 });
      symlinkSync(join(directory, "real-local-state"), join(linkedData, "Local State"));
      expect(() => cloneBrowserProfile(realpathSync(linkedProfile), linkedPrivate)).toThrow("regular file");

      const nonregularData = join(directory, "nonregular-data");
      const nonregularProfile = join(nonregularData, "Profile 1");
      mkdirSync(nonregularData);
      mkdirSync(nonregularProfile);
      mkdirSync(join(nonregularData, "Local State"));
      expect(() => cloneBrowserProfile(realpathSync(nonregularProfile), join(directory, "nonregular-private"))).toThrow("regular file");

      const oversizedData = join(directory, "oversized-data");
      const oversizedProfile = join(oversizedData, "Profile 1");
      mkdirSync(oversizedData);
      mkdirSync(oversizedProfile);
      const oversizedState = join(oversizedData, "Local State");
      writeFileSync(oversizedState, "", { mode: 0o600 });
      truncateSync(oversizedState, 16 * 1024 * 1024 + 1);
      expect(() => cloneBrowserProfile(realpathSync(oversizedProfile), join(directory, "oversized-private"))).toThrow("safety bound");

      const sourceLink = join(directory, "selected-profile-link");
      symlinkSync(oversizedProfile, sourceLink);
      let message = "";
      try {
        profilePath(sourceLink);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("real directory");
      expect(message).not.toContain(sourceLink);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("launches a hybrid Arc snapshot and seeds only cookies selected for each exact target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-hybrid-profile-test-"));
    chmodSync(directory, 0o700);
    try {
      const userData = join(directory, "Arc User Data");
      const source = join(userData, "Profile 1");
      mkdirSync(userData);
      mkdirSync(source);
      mkdirSync(join(source, "Local Storage"));
      mkdirSync(join(source, "IndexedDB"));
      writeFileSync(join(userData, "Local State"), "{\"os_crypt\":{}}", { mode: 0o600 });
      writeFileSync(join(source, "Preferences"), "source-must-not-change", { mode: 0o600 });
      writeFileSync(join(source, "Local Storage", "state"), "local", { mode: 0o600 });
      writeFileSync(join(source, "IndexedDB", "state"), "indexed", { mode: 0o600 });
      const before = readFileSync(join(source, "Preferences"));
      const invocations: { readonly command: readonly string[]; readonly stdin?: string }[] = [];
      const cookieSelections: {
        readonly sources: readonly string[];
        readonly profile?: string;
        readonly requireExplicitCookieScope: boolean;
        readonly url: string;
      }[] = [];
      let proxyClosed = 0;
      const session = await createBrowserSession(manifest, {
        schemaVersion: 1,
        id: "arc-main",
        kind: "browser-profile",
        profile: realpathSync(source),
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        trustUnfilteredEgress: true,
        cookieSource: "arc",
        cookieProfile: "Profile 1",
      }, {
        headed: false,
        timeoutMs: 30_000,
        maxOutputBytes: 64 * 1024,
        dependencies: {
          runCommand: (command, options) => {
            invocations.push({ command: [...command], ...(options.stdin === undefined ? {} : { stdin: options.stdin }) });
            if (command.includes("batch")) {
              const batch = JSON.parse(options.stdin ?? "[]") as readonly unknown[];
              return Promise.resolve({
                stdout: `${JSON.stringify(batch.map(() => ({ success: true, data: null })))}\n`,
                stderr: "",
                exitCode: 0,
              });
            }
            return Promise.resolve({ stdout: "{\"success\":true}\n", stderr: "", exitCode: 0 });
          },
          startNetworkProxy: (options) => {
            expect(options.allowPrivateNetwork).toBeFalse();
            return Promise.resolve({
              url: "http://127.0.0.1:43123",
              port: 43_123,
              close: () => {
                proxyClosed += 1;
                return Promise.resolve();
              },
            });
          },
          acquireCookieRecords: (options, target) => {
            cookieSelections.push({
              sources: options.cookieSources,
              ...(options.cookieProfile === undefined ? {} : { profile: options.cookieProfile }),
              requireExplicitCookieScope: options.requireExplicitCookieScope === true,
              url: target.href,
            });
            return Promise.resolve({
              cookies: [{
                name: "session",
                value: "private-cookie-value",
                domain: target.hostname,
                hostOnly: true,
                path: "/",
                secure: true,
                httpOnly: true,
                sameSite: "Lax" as const,
                expires: 0,
              }],
              warnings: [],
            });
          },
        },
      });
      const launch = invocations.find(({ command }) => command.includes("batch"));
      expect(launch).toBeDefined();
      const profileIndex = launch?.command.indexOf("--profile") ?? -1;
      const privateProfile = profileIndex < 0 ? undefined : launch?.command[profileIndex + 1];
      expect(privateProfile).toEndWith("/profile-user-data");
      expect(privateProfile).not.toBe(realpathSync(source));
      expect(launch?.command).not.toContain("--allowed-domains");
      const executableIndex = launch?.command.indexOf("--executable-path") ?? -1;
      expect(executableIndex).toBeGreaterThan(-1);
      expect(launch?.command[executableIndex + 1]).toBe(
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      );
      const browserArgumentsIndex = launch?.command.indexOf("--args") ?? -1;
      expect(browserArgumentsIndex < 0 ? "" : launch?.command[browserArgumentsIndex + 1]).toContain("--profile-directory=Default");
      expect(privateProfile === undefined ? false : existsSync(join(privateProfile, "Default", "Local Storage", "state"))).toBeTrue();
      expect(privateProfile === undefined ? false : existsSync(join(privateProfile, "Local State"))).toBeTrue();
      expect(cookieSelections).toEqual([{
        sources: ["arc"],
        profile: "Profile 1",
        requireExplicitCookieScope: true,
        url: "https://example.com/",
      }]);
      const batches = invocations.flatMap(({ stdin }) => stdin === undefined ? [] : [JSON.parse(stdin) as readonly (readonly string[])[]]);
      expect(batches.some((batch) => batch.some((command) =>
        command[0] === "cookies" && command[1] === "set" && command.includes("--url") && command.includes("https://example.com")))).toBeTrue();
      expect(invocations.some(({ command }) => command.includes(realpathSync(source)))).toBeFalse();
      expect(readFileSync(join(source, "Preferences"))).toEqual(before);

      await session.close();
      await session.cleanup();
      expect(proxyClosed).toBe(1);
      expect(privateProfile === undefined ? true : existsSync(privateProfile)).toBeFalse();
      expect(readFileSync(join(source, "Preferences"))).toEqual(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports an actionable encoded handle when early rollback cannot remove every private root", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-browser-rollback-test-"));
    const specialTempRoot = join(directory, "private root ü\\segment");
    mkdirSync(specialTempRoot, { recursive: true });
    const previousTempRoot = process.env.TMPDIR;
    const cleanupAttempts: string[] = [];
    process.env.TMPDIR = specialTempRoot;
    try {
      const failure = await rejectionValue(browserCleanupBarrier(
        createBrowserSession(manifest, {
          schemaVersion: 1,
          id: "missing-profile",
          kind: "browser-profile",
          profile: join(specialTempRoot, "missing profile"),
          trustUnfilteredEgress: true,
        }, {
          headed: false,
          timeoutMs: 1_000,
          maxOutputBytes: 64 * 1024,
          dependencies: {
            removePrivateArtifact: (path) => {
              cleanupAttempts.push(path);
              throw new Error("simulated private-root removal failure");
            },
          },
        }),
      ));

      expect(failure).toBeInstanceOf(PreservedBrowserArtifactsError);
      if (!(failure instanceof PreservedBrowserArtifactsError)) {
        throw new Error("expected preserved browser artifacts");
      }
      expect(cleanupAttempts).toHaveLength(2);
      expect(new Set(cleanupAttempts).size).toBe(2);
      expect(failure.recoveryHandle).toMatch(/^[A-Za-z0-9_;=-]+$/u);
      expect(failure.recoveryHandle).not.toContain(" ");
      expect(failure.recoveryHandle).not.toContain("ü");
      expect(failure.recoveryHandle).not.toContain("\\");

      const recovered = decodeBrowserRecoveryHandle(failure.recoveryHandle);
      // Recovery handles retain their frozen pre-Wrench session identity.
      expect(recovered.session).toStartWith("io-");
      expect(recovered.artifacts).toStartWith(specialTempRoot);
      expect(recovered.artifacts).toContain("io-browser-");
      expect(recovered.config).toBe(join(
        recovered.artifacts,
        "agent-browser.json",
      ));
      expect(recovered.socket).toContain("io-ab-");
      expect(cleanupAttempts).toEqual([
        recovered.socket,
        recovered.artifacts,
      ]);
      expect(existsSync(recovered.socket)).toBeTrue();
      expect(existsSync(recovered.artifacts)).toBeTrue();
    } finally {
      if (previousTempRoot === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTempRoot;
      for (const path of cleanupAttempts) {
        rmSync(path, { recursive: true, force: true });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains setup roots when proxy cleanup cannot be verified", async () => {
    let proxyCloseCalls = 0;
    let recovered:
      | Readonly<Record<"session" | "config" | "socket" | "artifacts", string>>
      | undefined;
    try {
      const failure = await rejectionValue(browserCleanupBarrier(
        createBrowserSession(manifest, {
          schemaVersion: 1,
          id: "browser-work",
          kind: "browser-profile",
          profile: "Work",
          trustUnfilteredEgress: true,
        }, {
          headed: false,
          timeoutMs: 1_000,
          maxOutputBytes: 64 * 1024,
          dependencies: {
            startNetworkProxy: () => Promise.resolve({
              url: "http://127.0.0.1:43124",
              port: 43_124,
              close: () => {
                proxyCloseCalls += 1;
                return new Promise<never>(() => undefined);
              },
            }),
            runCommand: (command) => {
              if (command.includes("batch")) {
                return Promise.resolve({
                  stdout: "",
                  stderr: "",
                  exitCode: 1,
                });
              }
              return Promise.resolve({
                stdout: "{\"success\":true}\n",
                stderr: "",
                exitCode: 0,
              });
            },
          },
        }),
      ));

      expect(failure).toBeInstanceOf(PreservedBrowserArtifactsError);
      if (!(failure instanceof PreservedBrowserArtifactsError)) {
        throw new Error("expected preserved browser artifacts");
      }
      recovered = decodeBrowserRecoveryHandle(failure.recoveryHandle);
      expect(proxyCloseCalls).toBe(1);
      expect(existsSync(recovered.socket)).toBeTrue();
      expect(existsSync(recovered.artifacts)).toBeTrue();
    } finally {
      if (recovered !== undefined) {
        rmSync(recovered.socket, { recursive: true, force: true });
        rmSync(recovered.artifacts, { recursive: true, force: true });
      }
    }
  });

  test("rejects a pre-aborted browser budget before setup has any side effect", async () => {
    const caller = new AbortController();
    caller.abort("private cancellation reason");
    const deadline = new OperationDeadline(1_000, { signal: caller.signal });
    let dependencyCalls = 0;

    try {
      expect(await rejectionMessage(createBrowserSession(manifest, auth, {
        headed: false,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
        operationDeadline: deadline,
        dependencies: {
          runCommand: () => {
            dependencyCalls += 1;
            return Promise.reject(new Error("must not run"));
          },
          startNetworkProxy: () => {
            dependencyCalls += 1;
            return Promise.reject(new Error("must not start"));
          },
          acquireCookieRecords: () => {
            dependencyCalls += 1;
            return Promise.reject(new Error("must not read"));
          },
        },
      }))).toContain("browser session setup was cancelled");
      expect(dependencyCalls).toBe(0);
    } finally {
      deadline.dispose();
    }

    expect(await rejectionMessage(runCommand(
      ["/wrench-test-command-must-not-exist"],
      {
        cwd: tmpdir(),
        environment: {},
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        signal: caller.signal,
      },
    ))).toContain("agent-browser command was cancelled");
  });

  test("spends one descending budget across proxy, launch, cookie read, and injection", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(1_000, { clock });
    const observed: { readonly step: string; readonly timeoutMs: number }[] = [];
    const session = await createBrowserSession(manifest, auth, {
      headed: false,
      timeoutMs: 1_000,
      maxOutputBytes: 64 * 1024,
      operationDeadline: deadline,
      dependencies: {
        startNetworkProxy: (options) => {
          observed.push({
            step: "proxy",
            timeoutMs: options.timeoutMs ?? -1,
          });
          clock.advance(100);
          return Promise.resolve({
            url: "http://127.0.0.1:43124",
            port: 43_124,
            close: () => Promise.resolve(),
          });
        },
        runCommand: (command, options) => {
          if (command.includes("batch")) {
            const batch = JSON.parse(options.stdin ?? "[]") as readonly unknown[];
            observed.push({
              step: observed.some(({ step }) => step === "launch")
                ? "inject"
                : "launch",
              timeoutMs: options.timeoutMs,
            });
            clock.advance(100);
            return Promise.resolve({
              stdout: `${JSON.stringify(batch.map(() => ({
                success: true,
                data: null,
              })))}\n`,
              stderr: "",
              exitCode: 0,
            });
          }
          return Promise.resolve({
            stdout: "{\"success\":true}\n",
            stderr: "",
            exitCode: 0,
          });
        },
        acquireCookieRecords: (options, target) => {
          observed.push({ step: "cookies", timeoutMs: options.timeoutMs });
          clock.advance(100);
          return Promise.resolve({
            cookies: [{
              name: "session",
              value: "private",
              domain: target.hostname,
              hostOnly: true,
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "Lax" as const,
              expires: 0,
            }],
            warnings: [],
          });
        },
      },
    });

    expect(observed).toEqual([
      { step: "proxy", timeoutMs: 1_000 },
      { step: "launch", timeoutMs: 900 },
      { step: "cookies", timeoutMs: 800 },
      { step: "inject", timeoutMs: 700 },
    ]);
    await session.close();
    await session.cleanup();
    deadline.dispose();
  });

  test("does not begin cookie injection after the total setup deadline expires", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(1_000, { clock });
    const batches: (readonly (readonly string[])[])[] = [];
    let proxyClosed = 0;

    try {
      expect(await rejectionMessage(createBrowserSession(manifest, auth, {
        headed: false,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
        operationDeadline: deadline,
        dependencies: {
          startNetworkProxy: () => {
            clock.advance(100);
            return Promise.resolve({
              url: "http://127.0.0.1:43124",
              port: 43_124,
              close: () => {
                proxyClosed += 1;
                return Promise.resolve();
              },
            });
          },
          runCommand: (command, options) => {
            if (command.includes("batch")) {
              const batch = JSON.parse(options.stdin ?? "[]") as readonly (readonly string[])[];
              batches.push(batch);
              clock.advance(100);
              return Promise.resolve({
                stdout: `${JSON.stringify(batch.map(() => ({
                  success: true,
                  data: null,
                })))}\n`,
                stderr: "",
                exitCode: 0,
              });
            }
            return Promise.resolve({
              stdout: "{\"success\":true}\n",
              stderr: "",
              exitCode: 0,
            });
          },
          acquireCookieRecords: () => {
            clock.advance(800);
            return Promise.resolve({ cookies: [], warnings: [] });
          },
        },
      }))).toContain("browser session setup timed out");
      expect(batches).toEqual([[["open", "https://example.com"]]]);
      expect(proxyClosed).toBe(1);
    } finally {
      deadline.dispose();
    }
  });

  test("never lets close or cleanup race an unsettled aborted batch", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(1_000, { clock });
    let batchCalls = 0;
    let closeCalls = 0;
    let proxyClosed = 0;
    const activeBatchState: {
      resolve: ((result: {
        readonly stdout: string;
        readonly stderr: string;
        readonly exitCode: number;
      }) => void) | null;
    } = { resolve: null };
    const activeBatch = new Promise<{
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    }>((resolve) => {
      activeBatchState.resolve = resolve;
    });
    const session = await createBrowserSession(manifest, {
      schemaVersion: 1,
      id: "browser-work",
      kind: "browser-profile",
      profile: "Work",
      trustUnfilteredEgress: true,
    }, {
      headed: false,
      timeoutMs: 1_000,
      maxOutputBytes: 64 * 1024,
      operationDeadline: deadline,
      dependencies: {
        startNetworkProxy: () => Promise.resolve({
          url: "http://127.0.0.1:43124",
          port: 43_124,
          close: () => {
            proxyClosed += 1;
            return Promise.resolve();
          },
        }),
        runCommand: (command, options) => {
          if (command.includes("close")) {
            closeCalls += 1;
            return Promise.resolve({
              stdout: "{\"success\":true}\n",
              stderr: "",
              exitCode: 0,
            });
          }
          const batch = JSON.parse(options.stdin ?? "[]") as readonly unknown[];
          batchCalls += 1;
          if (batchCalls === 2) return activeBatch;
          return Promise.resolve({
            stdout: `${JSON.stringify(batch.map(() => ({
              success: true,
              data: null,
            })))}\n`,
            stderr: "",
            exitCode: 0,
          });
        },
        acquireCookieRecords: () =>
          Promise.resolve({ cookies: [], warnings: [] }),
      },
    });

    const operation = session.runBatch(
      [["get", "url"]],
      1_000,
      64 * 1024,
    );
    clock.advance(1_000);
    expect(await rejectionMessage(operation)).toContain(
      "browser session setup timed out",
    );
    expect(await rejectionMessage(session.cleanup())).toContain(
      "before the session closes",
    );
    expect(proxyClosed).toBe(0);

    const closing = session.close();
    await Promise.resolve();
    expect(closeCalls).toBe(0);
    activeBatchState.resolve?.({
      stdout: "[{\"success\":true,\"data\":null}]\n",
      stderr: "",
      exitCode: 0,
    });
    await closing;
    expect(closeCalls).toBe(1);
    await session.cleanup();
    expect(proxyClosed).toBe(1);
    deadline.dispose();
  });

  test("aborting a SIGTERM-ignoring command escalates and reaps its process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-browser-abort-test-"));
    const pidPath = join(directory, "pid");
    const controller = new AbortController();
    let pid: number | null = null;
    try {
      const operation = runCommand(
        [
          process.execPath,
          "-e",
          [
            "import { writeFileSync } from 'node:fs';",
            `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
            "process.on('SIGTERM', () => undefined);",
            "setInterval(() => undefined, 1_000);",
          ].join("\n"),
        ],
        {
          cwd: directory,
          environment: {
            LANG: "C",
            LC_ALL: "C",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
          },
          timeoutMs: TEST_PROCESS_TIMEOUT_MS,
          maxOutputBytes: 4_096,
          signal: controller.signal,
        },
      );
      await waitUntil(() => existsSync(pidPath));
      pid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(pid)).toBeTrue();

      controller.abort();
      expect(await rejectionMessage(operation)).toContain(
        "agent-browser command was cancelled",
      );

      let processIsLive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        ) processIsLive = false;
        else throw error;
      }
      expect(processIsLive).toBeFalse();
    } finally {
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The expected path has already reaped the test helper.
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports forced termination as unsafe when a descendant escapes the process group", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "wrench-browser-escape-test-"));
    const escapedPidPath = join(directory, "escaped-pid");
    const controller = new AbortController();
    let escapedPid: number | null = null;
    try {
      const operation = runCommand(
        [
          process.execPath,
          "-e",
          [
            "import { spawn } from 'node:child_process';",
            "import { writeFileSync } from 'node:fs';",
            "const escaped = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], { detached: true, stdio: 'ignore' });",
            `writeFileSync(${JSON.stringify(escapedPidPath)}, String(escaped.pid));`,
            "escaped.unref();",
            "setInterval(() => undefined, 1_000);",
          ].join("\n"),
        ],
        {
          cwd: directory,
          environment: {
            LANG: "C",
            LC_ALL: "C",
            PATH: process.env.PATH ?? "/usr/bin:/bin",
          },
          timeoutMs: TEST_PROCESS_TIMEOUT_MS,
          maxOutputBytes: 4_096,
          signal: controller.signal,
        },
      );
      await waitUntil(() => existsSync(escapedPidPath));
      escapedPid = Number(readFileSync(escapedPidPath, "utf8"));
      expect(Number.isSafeInteger(escapedPid)).toBeTrue();

      controller.abort();
      expect(await rejectionMessage(operation)).toContain(
        "descendant process cleanup could not be verified",
      );

      expect(() => process.kill(escapedPid!, 0)).not.toThrow();
    } finally {
      if (escapedPid !== null) {
        try {
          process.kill(escapedPid, "SIGKILL");
        } catch {
          // The regression helper may already have exited after a test error.
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves private roots when command cleanup becomes unsafe after the setup deadline", async () => {
    if (process.platform === "win32") return;
    const helperDirectory = mkdtempSync(join(
      tmpdir(),
      "wrench-browser-late-cleanup-test-",
    ));
    const pidPath = join(helperDirectory, "pid");
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(1_000, { clock });
    let helperPid: number | null = null;
    let artifactsDirectory: string | null = null;
    let socketDirectory: string | null = null;
    let closeCalls = 0;
    try {
      const operation = createBrowserSession(manifest, {
        schemaVersion: 1,
        id: "browser-work",
        kind: "browser-profile",
        profile: "Work",
        trustUnfilteredEgress: true,
      }, {
        headed: false,
        timeoutMs: TEST_PROCESS_TIMEOUT_MS,
        maxOutputBytes: 4_096,
        operationDeadline: deadline,
        dependencies: {
          startNetworkProxy: () => Promise.resolve({
            url: "http://127.0.0.1:43124",
            port: 43_124,
            close: () => Promise.resolve(),
          }),
          runCommand: (command, options) => {
            artifactsDirectory = options.cwd;
            socketDirectory = options.environment.AGENT_BROWSER_SOCKET_DIR
              ?? null;
            if (command.includes("close")) {
              closeCalls += 1;
              return Promise.resolve({
                stdout: "{\"success\":true}\n",
                stderr: "",
                exitCode: 0,
              });
            }
            return runCommand([
              process.execPath,
              "-e",
              [
                "import { writeFileSync } from 'node:fs';",
                `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
                "setInterval(() => undefined, 1_000);",
              ].join("\n"),
            ], {
              ...options,
              cwd: helperDirectory,
              environment: {
                LANG: "C",
                LC_ALL: "C",
                PATH: process.env.PATH ?? "/usr/bin:/bin",
              },
              timeoutMs: TEST_PROCESS_TIMEOUT_MS,
            });
          },
        },
      });
      await waitUntil(() => existsSync(pidPath));
      helperPid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(helperPid)).toBeTrue();

      clock.advance(1_000);
      const failure = await rejectionValue(operation);
      expect(failure).toBeInstanceOf(PreservedBrowserArtifactsError);
      expect(closeCalls).toBe(0);
      if (!(failure instanceof PreservedBrowserArtifactsError)) {
        throw new Error("expected preserved browser artifacts");
      }
      const recovered = decodeBrowserRecoveryHandle(failure.recoveryHandle);
      if (artifactsDirectory === null || socketDirectory === null) {
        throw new Error("browser command did not expose its private roots");
      }
      expect(recovered.artifacts).toBe(artifactsDirectory);
      expect(recovered.socket).toBe(socketDirectory);
      expect(existsSync(recovered.artifacts)).toBeTrue();
      expect(existsSync(recovered.socket)).toBeTrue();
    } finally {
      deadline.dispose();
      if (helperPid !== null) {
        try {
          process.kill(helperPid, "SIGKILL");
        } catch {
          // The contained helper should already be gone.
        }
      }
      if (socketDirectory !== null) {
        rmSync(socketDirectory, { recursive: true, force: true });
      }
      if (artifactsDirectory !== null) {
        rmSync(artifactsDirectory, { recursive: true, force: true });
      }
      rmSync(helperDirectory, { recursive: true, force: true });
    }
  });

  test("bounds a stalled proxy cleanup and preserves the private roots", async () => {
    let proxyCloseCalls = 0;
    let recovered:
      | Readonly<Record<"session" | "config" | "socket" | "artifacts", string>>
      | undefined;
    try {
      const session = await createBrowserSession(manifest, {
        schemaVersion: 1,
        id: "browser-work",
        kind: "browser-profile",
        profile: "Work",
        trustUnfilteredEgress: true,
      }, {
        headed: false,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
        dependencies: {
          startNetworkProxy: () => Promise.resolve({
            url: "http://127.0.0.1:43124",
            port: 43_124,
            close: () => {
              proxyCloseCalls += 1;
              return new Promise<never>(() => undefined);
            },
          }),
          runCommand: (command, options) => {
            if (command.includes("batch")) {
              const batch = JSON.parse(options.stdin ?? "[]") as readonly unknown[];
              return Promise.resolve({
                stdout: `${JSON.stringify(batch.map(() => ({
                  success: true,
                  data: null,
                })))}\n`,
                stderr: "",
                exitCode: 0,
              });
            }
            return Promise.resolve({
              stdout: "{\"success\":true}\n",
              stderr: "",
              exitCode: 0,
            });
          },
        },
      });
      if (session.recoveryHandle === undefined) {
        throw new Error("browser session omitted its recovery handle");
      }
      recovered = decodeBrowserRecoveryHandle(session.recoveryHandle);
      await session.close();

      const startedAt = performance.now();
      expect(await rejectionMessage(session.cleanup())).toContain(
        "cleanup did not remove every private resource",
      );
      expect(performance.now() - startedAt).toBeLessThan(3_500);
      expect(proxyCloseCalls).toBe(1);
      expect(existsSync(recovered.socket)).toBeTrue();
      expect(existsSync(recovered.artifacts)).toBeTrue();
    } finally {
      if (recovered !== undefined) {
        rmSync(recovered.socket, { recursive: true, force: true });
        rmSync(recovered.artifacts, { recursive: true, force: true });
      }
    }
  });

  test("closes the network proxy after browser close fails while preserving private roots", async () => {
    let proxyCloseCalls = 0;
    let recovered:
      | Readonly<Record<"session" | "config" | "socket" | "artifacts", string>>
      | undefined;
    try {
      const session = await createBrowserSession(manifest, {
        schemaVersion: 1,
        id: "browser-work",
        kind: "browser-profile",
        profile: "Work",
        trustUnfilteredEgress: true,
      }, {
        headed: false,
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024,
        dependencies: {
          startNetworkProxy: () => Promise.resolve({
            url: "http://127.0.0.1:43124",
            port: 43_124,
            close: () => {
              proxyCloseCalls += 1;
              return Promise.resolve();
            },
          }),
          runCommand: (command, options) => {
            if (command.includes("batch")) {
              const batch = JSON.parse(options.stdin ?? "[]") as readonly unknown[];
              return Promise.resolve({
                stdout: `${JSON.stringify(batch.map(() => ({
                  success: true,
                  data: null,
                })))}\n`,
                stderr: "",
                exitCode: 0,
              });
            }
            return Promise.resolve({
              stdout: "",
              stderr: "simulated close failure",
              exitCode: 1,
            });
          },
        },
      });
      if (session.recoveryHandle === undefined) {
        throw new Error("browser session omitted its recovery handle");
      }
      recovered = decodeBrowserRecoveryHandle(session.recoveryHandle);

      expect(await rejectionMessage(session.close())).toContain(
        "agent-browser close failed",
      );
      const cleanupFailure = await rejectionValue(session.cleanup());
      expect(cleanupFailure).toBeInstanceOf(AggregateError);
      expect(cleanupFailure).toHaveProperty(
        "message",
        "browser session cleanup did not remove every private resource",
      );
      expect(
        cleanupFailure instanceof AggregateError
          ? cleanupFailure.errors.map((error) =>
              error instanceof Error ? error.message : String(error))
          : [],
      ).toContain(
        "refusing to delete private browser artifacts before the session closes",
      );
      expect(proxyCloseCalls).toBe(1);
      expect(existsSync(recovered.socket)).toBeTrue();
      expect(existsSync(recovered.artifacts)).toBeTrue();
    } finally {
      if (recovered !== undefined) {
        rmSync(recovered.socket, { recursive: true, force: true });
        rmSync(recovered.artifacts, { recursive: true, force: true });
      }
    }
  });

  test("bounds an unkillable command and reports preserved browser artifacts", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), "wrench-browser-unkillable-test-"));
    const pidPath = join(directory, "pid");
    const originalKill: typeof process.kill = process.kill.bind(process);
    let pid: number | null = null;
    let artifactsDirectory: string | null = null;
    let socketDirectory: string | null = null;
    let proxyClosed = 0;
    try {
      process.kill = (
        target: number,
        signal?: number | NodeJS.Signals,
      ): true => {
        if (target < 0) return true;
        return originalKill(target, signal);
      };
      const startedAt = performance.now();
      const operation = browserCleanupBarrier(createBrowserSession(manifest, {
        schemaVersion: 1,
        id: "browser-work",
        kind: "browser-profile",
        profile: "Work",
        trustUnfilteredEgress: true,
      }, {
        headed: false,
        timeoutMs: 100,
        maxOutputBytes: 4_096,
        dependencies: {
          startNetworkProxy: () => Promise.resolve({
            url: "http://127.0.0.1:43124",
            port: 43_124,
            close: () => {
              proxyClosed += 1;
              return Promise.resolve();
            },
          }),
          runCommand: (_command, options) => {
            artifactsDirectory = options.cwd;
            socketDirectory = options.environment.AGENT_BROWSER_SOCKET_DIR ?? null;
            return runCommand([
              process.execPath,
              "-e",
              [
                "import { writeFileSync } from 'node:fs';",
                "process.on('SIGTERM', () => undefined);",
                `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
                "setInterval(() => undefined, 1_000);",
              ].join("\n"),
            ], {
              ...options,
              cwd: directory,
              environment: {
                LANG: "C",
                LC_ALL: "C",
                PATH: process.env.PATH ?? "/usr/bin:/bin",
              },
              timeoutMs: 100,
            });
          },
        },
      }));
      await waitUntil(() => existsSync(pidPath));
      pid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isSafeInteger(pid)).toBeTrue();

      const failure = await rejectionValue(operation);
      const elapsedMs = performance.now() - startedAt;
      expect(elapsedMs).toBeLessThan(5_000);
      expect(failure).toBeInstanceOf(PreservedBrowserArtifactsError);
      if (!(failure instanceof PreservedBrowserArtifactsError)) {
        throw new Error("expected preserved browser artifacts");
      }
      expect(proxyClosed).toBe(1);
      const recovered = decodeBrowserRecoveryHandle(failure.recoveryHandle);
      if (artifactsDirectory === null || socketDirectory === null) {
        throw new Error("browser command did not expose its private roots");
      }
      expect(recovered.artifacts).toBe(artifactsDirectory);
      expect(recovered.config).toBe(join(
        recovered.artifacts,
        "agent-browser.json",
      ));
      expect(recovered.socket).toBe(socketDirectory);
      expect(existsSync(recovered.artifacts)).toBeTrue();
      expect(existsSync(recovered.socket)).toBeTrue();
    } finally {
      process.kill = originalKill;
      if (pid !== null) {
        try {
          originalKill(-pid, "SIGKILL");
        } catch {
          // A concurrent test failure may have already released the helper.
        }
      }
      if (socketDirectory !== null) {
        rmSync(socketDirectory, { recursive: true, force: true });
      }
      if (artifactsDirectory !== null) {
        rmSync(artifactsDirectory, { recursive: true, force: true });
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
