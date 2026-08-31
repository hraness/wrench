import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import type { WebSessionRecipe } from "../model";
import {
  executeTelegramTdlibOperation,
  inspectTelegramTdlibRuntime,
  pairTelegramAuth,
  probeTelegramSubject,
  runTelegramTdlibHelperChild,
  syncTelegramAuthOnce,
  type TelegramTdlibInvocation,
  type TelegramTdlibInvocationResult,
} from "./telegram-tdlib-runtime";
import { TELEGRAM_TDLIB_PIN } from "./telegram-tdlib";

const subject = "telegram:user:7000000001";

function withTemporaryRoot(
  name: string,
  body: (root: string) => Promise<void> | void,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wrench-telegram-${name}-`)));
  chmodSync(root, 0o700);
  return Promise.resolve(body(root)).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

function sha256(pathValue: string): string {
  return createHash("sha256").update(readFileSync(pathValue)).digest("hex");
}

function createStateRoot(root: string): Readonly<Record<string, string>> {
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(
    join(state, ".io-state.json"),
    '{"kind":"io-state","schemaVersion":1}\n',
    { mode: 0o600 },
  );
  mkdirSync(join(state, "tools"), { mode: 0o700 });
  return Object.freeze({ WRENCH_STATE_HOME: state });
}

function createRuntime(
  environment: Readonly<Record<string, string>>,
): Readonly<{ directory: string; binary: string; manifest: string }> {
  const state = environment.WRENCH_STATE_HOME;
  if (state === undefined) throw new Error("fixture omitted state root");
  const parent = join(
    state,
    "tools",
    "telegram-tdlib",
    TELEGRAM_TDLIB_PIN.version,
    TELEGRAM_TDLIB_PIN.sourceCommit,
  );
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  for (
    let pathValue = join(state, "tools", "telegram-tdlib");
    pathValue !== parent;
    pathValue = join(pathValue, pathValue.endsWith("telegram-tdlib")
      ? TELEGRAM_TDLIB_PIN.version
      : TELEGRAM_TDLIB_PIN.sourceCommit)
  ) chmodSync(pathValue, 0o700);
  chmodSync(parent, 0o700);
  const directory = join(parent, `${process.platform}-${process.arch}`);
  mkdirSync(directory, { mode: 0o700 });
  const binary = join(directory, "wrench-telegram-tdlib");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o500 });
  chmodSync(binary, 0o500);
  const manifest = join(directory, "install-manifest.json");
  writeFileSync(manifest, `${JSON.stringify({
    arch: process.arch,
    binaryFile: "wrench-telegram-tdlib",
    binarySha256: sha256(binary),
    implementation: "wrench-telegram-tdlib",
    platform: process.platform,
    protocolVersion: 1,
    schemaVersion: 1,
    sourceCommit: TELEGRAM_TDLIB_PIN.sourceCommit,
    tdlibVersion: TELEGRAM_TDLIB_PIN.version,
  })}\n`, { mode: 0o400 });
  chmodSync(manifest, 0o400);
  return Object.freeze({ directory, binary, manifest });
}

function createStore(root: string): string {
  const store = join(root, "telegram-store");
  mkdirSync(store, { mode: 0o700 });
  writeFileSync(
    join(store, "client.conf"),
    "api_id=123456\napi_hash=0123456789abcdef0123456789abcdef\n",
    { mode: 0o600 },
  );
  chmodSync(join(store, "client.conf"), 0o600);
  mkdirSync(join(store, "tdlib"), { mode: 0o700 });
  mkdirSync(join(store, "tdlib-files"), { mode: 0o700 });
  return store;
}

function auth(path: string, accountSubject?: string): WrenchAuth {
  return {
    schemaVersion: 1,
    id: "telegram-main",
    kind: "linked-device-store",
    provider: "telegram",
    path,
    ...(accountSubject === undefined ? {} : { subject: accountSubject }),
  };
}

function identityResult(): TelegramTdlibInvocationResult {
  return Object.freeze({
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      schemaVersion: 1,
      operation: "identity",
      status: "ok",
      implementation: "wrench-telegram-tdlib",
      tdlibVersion: TELEGRAM_TDLIB_PIN.version,
      sourceCommit: TELEGRAM_TDLIB_PIN.sourceCommit,
    })}\n`,
  });
}

function captureResult(
  operation: "pair" | "sync",
  accountSubject = subject,
): TelegramTdlibInvocationResult {
  return Object.freeze({
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify({
      schemaVersion: 1,
      operation,
      status: "ok",
      sourceCommit: TELEGRAM_TDLIB_PIN.sourceCommit,
      accountSubject,
      contacts: [{
        userId: "2",
        firstName: "Ada",
        lastName: "Fixture",
        displayName: "Ada Fixture",
        username: "ada_fixture",
        phoneNumber: "15551234567",
        isMutualContact: true,
        isPremium: false,
        isVerified: true,
      }, {
        userId: "10",
        firstName: "",
        lastName: "",
        displayName: "Telegram user 10",
        username: null,
        phoneNumber: null,
        isMutualContact: false,
        isPremium: true,
        isVerified: false,
      }],
    })}\n`,
  });
}

function operationFrom(invocation: TelegramTdlibInvocation): string {
  const value = JSON.parse(invocation.stdin) as { readonly operation?: unknown };
  if (typeof value.operation !== "string") throw new Error("fixture request omitted operation");
  return value.operation;
}

function recipe(maxOutputBytes = 128 * 1024): WebSessionRecipe {
  return {
    site: "telegram",
    action: "contacts.list",
    contractVersion: 1,
    timeoutMs: 10_000,
    maxOutputBytes,
  };
}

describe("Telegram TDLib runtime", () => {
  test("accepts an exact runtime manifest, SHA, permissions, and embedded identity", () =>
    withTemporaryRoot("inspect", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const invocations: TelegramTdlibInvocation[] = [];
      const status = await inspectTelegramTdlibRuntime(environment, {
        run: async (invocation) => {
          invocations.push(invocation);
          return identityResult();
        },
      });
      expect(status).toMatchObject({
        ready: true,
        version: "1.8.67",
        integrity: "source-commit+manifest-sha256+embedded-identity",
      });
      expect(invocations.map(operationFrom)).toEqual(["identity"]);
      expect(invocations[0]?.environment).toEqual({
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        TZ: "UTC",
      });
    }));

  test("pairs only after identity preflight and one durable external fence", () =>
    withTemporaryRoot("pair", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      const events: string[] = [];
      const invocations: TelegramTdlibInvocation[] = [];
      const phone = "+15551234567";
      const paired = await pairTelegramAuth(auth(store), {
        phone,
        environment,
        attempt: {
          journalId: "fixture-pair",
          beforeExternalBegin: async () => {
            events.push("fence");
          },
        },
        dependencies: {
          run: async (invocation) => {
            invocations.push(invocation);
            const operation = operationFrom(invocation);
            events.push(operation);
            return operation === "identity" ? identityResult() : captureResult("pair");
          },
        },
      });
      expect(paired).toBe(subject);
      expect(events).toEqual(["identity", "fence", "pair"]);
      expect(invocations).toHaveLength(2);
      expect(invocations[1]?.stdin).toContain(phone);
      expect(invocations[1]?.binary).not.toContain(phone);
      expect(invocations[1]?.cwd).not.toContain(phone);
      expect(JSON.stringify(invocations[1]?.environment)).not.toContain(phone);
      const projectionPath = join(store, "contacts.v1.json");
      expect(lstatSync(projectionPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(projectionPath, "utf8")).not.toContain(phone);
    }));

  test("performs account-bound sync and stores the exact contact count", () =>
    withTemporaryRoot("sync", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      await pairTelegramAuth(auth(store), {
        environment,
        attempt: { journalId: "pair", beforeExternalBegin: async () => {} },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("pair"),
        },
      });
      let fences = 0;
      const result = await syncTelegramAuthOnce(auth(store, subject), {
        environment,
        attempt: {
          journalId: "sync",
          beforeExternalBegin: async () => { fences += 1; },
        },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("sync"),
        },
      });
      expect(result).toEqual({ contactsStored: 2 });
      expect(fences).toBe(1);
    }));

  test("sync repairs a missing projection only after confirming the bound account", () =>
    withTemporaryRoot("sync-repair", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      await pairTelegramAuth(auth(store), {
        environment,
        attempt: { journalId: "pair", beforeExternalBegin: async () => {} },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("pair"),
        },
      });
      unlinkSync(join(store, "contacts.v1.json"));
      const result = await syncTelegramAuthOnce(auth(store, subject), {
        environment,
        attempt: { journalId: "sync", beforeExternalBegin: async () => {} },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("sync"),
        },
      });
      expect(result).toEqual({ contactsStored: 2 });
      expect(await probeTelegramSubject(auth(store, subject))).toBe(subject);
    }));

  test("accepts TDLib-owned directory writes while retaining directory bindings", () =>
    withTemporaryRoot("tdlib-write", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      const paired = await pairTelegramAuth(auth(store), {
        environment,
        attempt: { journalId: "pair", beforeExternalBegin: async () => {} },
        dependencies: {
          run: async (invocation) => {
            if (operationFrom(invocation) === "identity") return identityResult();
            writeFileSync(join(store, "tdlib", "td.binlog"), "state", { mode: 0o600 });
            writeFileSync(join(store, "tdlib-files", "contact-photo"), "photo", {
              mode: 0o600,
            });
            return captureResult("pair");
          },
        },
      });
      expect(paired).toBe(subject);
      expect(readFileSync(join(store, "contacts.v1.json"), "utf8"))
        .toContain(subject);
    }));

  test("probe and contacts.list stay offline, account-bound, bounded, and truthful", () =>
    withTemporaryRoot("offline", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      await pairTelegramAuth(auth(store), {
        environment,
        attempt: { journalId: "pair", beforeExternalBegin: async () => {} },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("pair"),
        },
      });
      expect(await probeTelegramSubject(auth(store, subject))).toBe(subject);
      const result = await executeTelegramTdlibOperation(
        recipe(),
        { limit: 1 },
        auth(store, subject),
      );
      expect(result.dispatchStarted).toBe(false);
      expect(result.dispatch).toEqual({ planned: 0, started: 0, verified: 0 });
      expect(result.output).toMatchObject({
        accountSubject: subject,
        projection: "tdlib-get-contacts-snapshot",
        contacts: [{
          userId: "2",
          sentCount: null,
          receivedCount: null,
          sentStatsIncompleteReasons: [
            "tdlib-contacts-do-not-include-message-history",
          ],
          receivedStatsIncompleteReasons: [
            "tdlib-contacts-do-not-include-message-history",
          ],
        }],
        nextCursor: "2",
        pageComplete: false,
        contactSetComplete: true,
      });
      await expect(executeTelegramTdlibOperation(
        recipe(8),
        {},
        auth(store, subject),
      )).rejects.toThrow("byte limit");
      await expect(probeTelegramSubject(auth(store, "telegram:user:9")))
        .rejects.toThrow("did not match");
    }));

  test("preflight rejects bad config, permissive directories, symlinks, and hardlinks without a child or fence", () =>
    withTemporaryRoot("preflight", async (root) => {
      const environment = createStateRoot(root);
      const runtime = createRuntime(environment);
      const store = createStore(root);
      let children = 0;
      let fences = 0;
      const options = {
        environment,
        attempt: {
          journalId: "preflight",
          beforeExternalBegin: async () => { fences += 1; },
        },
        dependencies: {
          run: async (): Promise<TelegramTdlibInvocationResult> => {
            children += 1;
            return identityResult();
          },
        },
      };
      writeFileSync(join(store, "client.conf"), "api_id=1\napi_hash=SECRET\n", { mode: 0o600 });
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("client.conf");
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });

      writeFileSync(
        join(store, "client.conf"),
        "api_id=1\napi_hash=0123456789abcdef0123456789abcdef\n",
        { mode: 0o600 },
      );
      chmodSync(store, 0o755);
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("mode-0700");
      expect(lstatSync(store).mode & 0o777).toBe(0o755);
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });
      chmodSync(store, 0o700);

      const linkedStore = join(root, "linked-store");
      symlinkSync(store, linkedStore);
      await expect(pairTelegramAuth(auth(linkedStore), options)).rejects.toThrow("mode-0700");
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });

      chmodSync(join(store, "tdlib"), 0o755);
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("mode-0700");
      expect(lstatSync(join(store, "tdlib")).mode & 0o777).toBe(0o755);
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });
      chmodSync(join(store, "tdlib"), 0o700);

      const configPath = join(store, "client.conf");
      linkSync(configPath, `${configPath}.hardlink`);
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("one link");
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });
      unlinkSync(`${configPath}.hardlink`);

      chmodSync(runtime.manifest, 0o600);
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("mode-400");
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });
      chmodSync(runtime.manifest, 0o400);

      const manifestReal = `${runtime.manifest}.real`;
      renameSync(runtime.manifest, manifestReal);
      symlinkSync(manifestReal, runtime.manifest);
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("mode-400");
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });
      unlinkSync(runtime.manifest);
      renameSync(manifestReal, runtime.manifest);

      const canonicalManifest = readFileSync(runtime.manifest, "utf8");
      chmodSync(runtime.manifest, 0o600);
      writeFileSync(
        runtime.manifest,
        `${JSON.stringify(JSON.parse(canonicalManifest), null, 2)}\n`,
        { mode: 0o400 },
      );
      chmodSync(runtime.manifest, 0o400);
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("canonical JSON");
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });
      chmodSync(runtime.manifest, 0o600);
      writeFileSync(runtime.manifest, canonicalManifest, { mode: 0o400 });
      chmodSync(runtime.manifest, 0o400);

      linkSync(runtime.binary, `${runtime.binary}.hardlink`);
      await expect(pairTelegramAuth(auth(store), options)).rejects.toThrow("one link");
      expect({ children, fences }).toEqual({ children: 0, fences: 0 });
    }));

  test("detects installation-directory replacement after embedded identity", () =>
    withTemporaryRoot("runtime-directory-swap", async (root) => {
      const environment = createStateRoot(root);
      const runtime = createRuntime(environment);
      const store = createStore(root);
      let children = 0;
      await expect(pairTelegramAuth(auth(store), {
        environment,
        attempt: {
          journalId: "replace-runtime-directory",
          beforeExternalBegin: async () => {
            throw new Error("external fence must not be reached");
          },
        },
        dependencies: {
          run: async () => {
            children += 1;
            renameSync(runtime.directory, `${runtime.directory}.moved`);
            createRuntime(environment);
            return identityResult();
          },
        },
      })).rejects.toThrow("installation directory identity changed");
      expect(children).toBe(1);
      expect(() => lstatSync(join(store, "contacts.v1.json"))).toThrow();
    }));

  test("detects runtime or store replacement and never publishes the captured account", () =>
    withTemporaryRoot("replacement", async (root) => {
      const environment = createStateRoot(root);
      const runtime = createRuntime(environment);
      const store = createStore(root);
      let fence = 0;
      let call = 0;
      await expect(pairTelegramAuth(auth(store), {
        environment,
        attempt: {
          journalId: "replace-runtime",
          beforeExternalBegin: async () => { fence += 1; },
        },
        dependencies: {
          run: async (invocation) => {
            call += 1;
            if (operationFrom(invocation) === "identity") {
              renameSync(runtime.binary, `${runtime.binary}.moved`);
              writeFileSync(runtime.binary, "#!/bin/sh\nexit 1\n", { mode: 0o500 });
              chmodSync(runtime.binary, 0o500);
              return identityResult();
            }
            return captureResult("pair");
          },
        },
      })).rejects.toThrow("identity changed");
      expect({ call, fence }).toEqual({ call: 1, fence: 0 });
      expect(() => lstatSync(join(store, "contacts.v1.json"))).toThrow();
    }));

  test("detects store swaps after the external fence before projection publication", () =>
    withTemporaryRoot("store-swap", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      let fence = 0;
      await expect(pairTelegramAuth(auth(store), {
        environment,
        attempt: {
          journalId: "replace-store",
          beforeExternalBegin: async () => { fence += 1; },
        },
        dependencies: {
          run: async (invocation) => {
            if (operationFrom(invocation) === "identity") return identityResult();
            renameSync(store, `${store}.moved`);
            mkdirSync(store, { mode: 0o700 });
            writeFileSync(
              join(store, "client.conf"),
              "api_id=1\napi_hash=0123456789abcdef0123456789abcdef\n",
              { mode: 0o600 },
            );
            mkdirSync(join(store, "tdlib"), { mode: 0o700 });
            mkdirSync(join(store, "tdlib-files"), { mode: 0o700 });
            return captureResult("pair");
          },
        },
      })).rejects.toThrow("store identity changed");
      expect(fence).toBe(1);
      expect(() => lstatSync(join(store, "contacts.v1.json"))).toThrow();
    }));

  test("detects same-inode same-size client configuration mutation", () =>
    withTemporaryRoot("config-mutation", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      await expect(pairTelegramAuth(auth(store), {
        environment,
        attempt: {
          journalId: "mutate-config",
          beforeExternalBegin: async () => {},
        },
        dependencies: {
          run: async (invocation) => {
            if (operationFrom(invocation) === "identity") return identityResult();
            writeFileSync(
              join(store, "client.conf"),
              "api_id=654321\napi_hash=0123456789abcdef0123456789abcdef\n",
              { mode: 0o600 },
            );
            return captureResult("pair");
          },
        },
      })).rejects.toThrow("configuration identity changed");
      expect(() => lstatSync(join(store, "contacts.v1.json"))).toThrow();
    }));

  test("detects a TDLib private-directory swap after the external fence", () =>
    withTemporaryRoot("tdlib-directory-swap", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      const tdlibDirectory = join(store, "tdlib");
      await expect(pairTelegramAuth(auth(store), {
        environment,
        attempt: {
          journalId: "replace-tdlib-directory",
          beforeExternalBegin: async () => {},
        },
        dependencies: {
          run: async (invocation) => {
            if (operationFrom(invocation) === "identity") return identityResult();
            renameSync(tdlibDirectory, `${tdlibDirectory}.moved`);
            mkdirSync(tdlibDirectory, { mode: 0o700 });
            return captureResult("pair");
          },
        },
      })).rejects.toThrow("tdlib directory identity changed");
      expect(() => lstatSync(join(store, "contacts.v1.json"))).toThrow();
    }));

  test("rejects a sync account mismatch after fencing without replacing the old projection", () =>
    withTemporaryRoot("account-swap", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      await pairTelegramAuth(auth(store), {
        environment,
        attempt: { journalId: "pair", beforeExternalBegin: async () => {} },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("pair"),
        },
      });
      const before = readFileSync(join(store, "contacts.v1.json"), "utf8");
      let fence = 0;
      await expect(syncTelegramAuthOnce(auth(store, subject), {
        environment,
        attempt: {
          journalId: "sync",
          beforeExternalBegin: async () => { fence += 1; },
        },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("sync", "telegram:user:9"),
        },
      })).rejects.toThrow("did not match");
      expect(fence).toBe(1);
      expect(readFileSync(join(store, "contacts.v1.json"), "utf8")).toBe(before);
    }));

  test("offline projection reads reject mode, hardlink, and symlink drift", () =>
    withTemporaryRoot("projection-drift", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      await pairTelegramAuth(auth(store), {
        environment,
        attempt: { journalId: "pair", beforeExternalBegin: async () => {} },
        dependencies: {
          run: async (invocation) => operationFrom(invocation) === "identity"
            ? identityResult()
            : captureResult("pair"),
        },
      });
      const projectionPath = join(store, "contacts.v1.json");
      chmodSync(projectionPath, 0o644);
      await expect(probeTelegramSubject(auth(store, subject))).rejects.toThrow("mode-600");
      chmodSync(projectionPath, 0o600);

      linkSync(projectionPath, `${projectionPath}.hardlink`);
      await expect(probeTelegramSubject(auth(store, subject))).rejects.toThrow("one link");
      unlinkSync(`${projectionPath}.hardlink`);

      const projectionReal = `${projectionPath}.real`;
      renameSync(projectionPath, projectionReal);
      symlinkSync(projectionReal, projectionPath);
      await expect(probeTelegramSubject(auth(store, subject))).rejects.toThrow("mode-600");
    }));

  test("does not cross the effect boundary when its durable fence fails", () =>
    withTemporaryRoot("fence", async (root) => {
      const environment = createStateRoot(root);
      createRuntime(environment);
      const store = createStore(root);
      const operations: string[] = [];
      await expect(pairTelegramAuth(auth(store), {
        environment,
        attempt: {
          journalId: "fence",
          beforeExternalBegin: async () => {
            throw new Error("durable fence unavailable");
          },
        },
        dependencies: {
          run: async (invocation) => {
            operations.push(operationFrom(invocation));
            return identityResult();
          },
        },
      })).rejects.toThrow("durable fence unavailable");
      expect(operations).toEqual(["identity"]);
    }));

  test("bounds helper output and terminates the exact helper on timeout", () =>
    withTemporaryRoot("process", async (root) => {
      const overflow = join(root, "overflow.sh");
      writeFileSync(overflow, "#!/bin/sh\nexec /usr/bin/yes x\n", { mode: 0o500 });
      chmodSync(overflow, 0o500);
      const base = {
        cwd: root,
        environment: { LANG: "C.UTF-8" },
        stdin: "{}\n",
        maxStderrBytes: 128,
      } as const;
      await expect(runTelegramTdlibHelperChild({
        ...base,
        binary: overflow,
        timeoutMs: 5_000,
        maxOutputBytes: 128,
      })).rejects.toThrow("streams failed");

      const invalidUtf8 = join(root, "invalid-utf8.sh");
      writeFileSync(invalidUtf8, "#!/bin/sh\nprintf '\\377'\n", { mode: 0o500 });
      chmodSync(invalidUtf8, 0o500);
      await expect(runTelegramTdlibHelperChild({
        ...base,
        binary: invalidUtf8,
        timeoutMs: 5_000,
        maxOutputBytes: 128,
      })).rejects.toThrow("streams failed");

      const sleeper = join(root, "sleeper.sh");
      writeFileSync(sleeper, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o500 });
      chmodSync(sleeper, 0o500);
      await expect(runTelegramTdlibHelperChild({
        ...base,
        binary: sleeper,
        timeoutMs: 20,
        maxOutputBytes: 128,
      })).rejects.toThrow("timed out");

      const controller = new AbortController();
      controller.abort();
      await expect(runTelegramTdlibHelperChild({
        ...base,
        binary: sleeper,
        timeoutMs: 5_000,
        maxOutputBytes: 128,
        signal: controller.signal,
      })).rejects.toThrow("cancelled");
    }));
});
