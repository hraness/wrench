import { describe, expect, test } from "bun:test";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createAuth, saveAuth, type WrenchAuth } from "./auth";
import {
  PreservedBrowserArtifactsError,
  type BrowserExecution,
} from "./browser";
import {
  canonicalJson,
  parseManifest,
  sha256,
  type FileInputValue,
  type WrenchManifest,
} from "./model";
import {
  readRecoveryCapsule,
  writeRecoveryCapsule,
  type RecoveryCapsule,
} from "./recovery";
import type { ProviderExecution } from "./provider";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  createRunJournal,
  parseRunJournal,
  readRunJournal,
} from "./run-journal";
import {
  PLAN_TTL_MS,
  cancelInvocationPlan,
  confirmInvocation,
  createAndSaveInvocationPlan,
  createInvocationPlan,
  executeReadInvocation,
  listInvocationPlans,
  listRunReceipts,
  loadInvocationPlan,
  prepareInvocation,
  purgeExpiredPlans,
  readRunReceipt,
  repairInterruptedRunJournals,
  saveInvocationPlan,
  type StoredPlan,
} from "./runtime";
import {
  acquireWebSessionCleanupAdmission,
  listWebSessionCleanupAdmissions,
} from "./web-session-cleanup-admission";
import { PLAN_ASSET_GC_GRACE_MS, planAssetBundlePath } from "./plan-assets";
import {
  ensurePrivateStateDirectory,
  installManifest as installManifestWithRegistry,
  wrenchStateHome,
  writePrivateJson,
} from "./storage";

const installManifest = (
  manifest: Parameters<typeof installManifestWithRegistry>[0],
  options: Parameters<typeof installManifestWithRegistry>[1],
) => installManifestWithRegistry(manifest, {
  ...options,
  registry: options.registry ?? providerPluginRegistry,
});

const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

function state(): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-runtime-test-"));
  chmodSync(directory, 0o700);
  return { directory, environment: { WRENCH_STATE_HOME: directory } };
}

async function holdReadProjectionAdmissionInChild(
  testState: TestState,
  authId: string,
) {
  const readyPath = join(testState.directory, `.admission-ready-${randomUUID()}`);
  const admissionModuleUrl = pathToFileURL(
    join(import.meta.dir, "read-projection-admission.ts"),
  ).href;
  const child = Bun.spawn([
    process.execPath,
    "--eval",
    `
      const { writeFileSync } = await import("node:fs");
      const { acquireReadProjectionAuthAdmission } = await import(${JSON.stringify(admissionModuleUrl)});
      const admission = acquireReadProjectionAuthAdmission(
        process.env.WRENCH_TEST_AUTH_ID,
        process.env,
      );
      writeFileSync(process.env.WRENCH_TEST_READY_PATH, "ready\\n", { mode: 0o600 });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      admission.release();
    `,
  ], {
    env: {
      ...process.env,
      WRENCH_STATE_HOME: testState.directory,
      WRENCH_TEST_AUTH_ID: authId,
      WRENCH_TEST_READY_PATH: readyPath,
    },
    detached: true,
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  const killAndReap = async (): Promise<void> => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The direct child and its owned group already exited.
      }
    }
    await Promise.allSettled([child.exited, stderr]);
  };
  const deadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
  while (
    !existsSync(readyPath)
    && child.exitCode === null
    && performance.now() < deadline
  ) {
    await Bun.sleep(25);
  }
  if (!existsSync(readyPath)) {
    const observedExitCode = child.exitCode;
    await killAndReap();
    const exitCode = observedExitCode ?? await child.exited;
    const stderrText = await stderr;
    throw new Error(
      `cross-process admission holder did not become ready (exit ${exitCode}): ${stderrText}`,
    );
  }
  return Object.freeze({ child, killAndReap, stderr });
}

function auth(source: "chrome" | "firefox" = "chrome"): WrenchAuth {
  return { schemaVersion: 1, id: "example", kind: "cookie-source", source };
}

function manifest(
  risk: "R1" | "R2" | "R3" = "R2",
  options: { readonly version?: string; readonly dedupeWindowMs?: number } = {},
): WrenchManifest {
  const mutating = risk === "R2" || risk === "R3";
  return {
    schemaVersion: 1,
    id: "example",
    version: options.version ?? "1.0.0",
    displayName: "Example",
    origins: ["https://example.com"],
    browserDomains: ["example.com", "*.example.com"],
    operations: {
      "messaging.send": {
        description: mutating ? "Send one message" : "Read messages",
        risk,
        sideEffect: mutating ? "Sends one external message" : "none",
        idempotency: mutating ? "local-at-most-once" : "none",
        dedupeWindowMs: mutating ? options.dedupeWindowMs ?? 86_400_000 : 0,
        input: {
          properties: {
            message: {
              type: "string",
              description: "Message body",
              minLength: 1,
              maxLength: 2_000,
            },
          },
          required: ["message"],
        },
        browser: {
          steps: mutating
            ? [
                { kind: "navigate", path: "/messaging/compose" },
                {
                  kind: "find",
                  locator: { by: "role", value: "textbox", name: "Write a message" },
                  action: "fill",
                  with: "message",
                },
                {
                  kind: "find",
                  locator: { by: "role", value: "button", name: "Send" },
                  action: "click",
                  dispatch: true,
                },
                { kind: "assert-url", pattern: "https://example.com/messaging/thread/*" },
              ]
            : [
                { kind: "navigate", path: "/messaging" },
                { kind: "read" },
              ],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      },
    },
  };
}


function xProviderManifest(): WrenchManifest {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.json"),
    "utf8",
  )) as WrenchManifest;
}

function linkedinWebManifest(): WrenchManifest {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-web-adapter.json"),
    "utf8",
  )) as WrenchManifest;
}

function xWebManifest(): WrenchManifest {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", "x", "wrench-web-adapter.json"),
    "utf8",
  )) as WrenchManifest;
}

function reviewedTemplateManifest(
  risk: "R1" | "R3",
  method: "GET" | "DELETE" | "POST" = risk === "R3" ? "POST" : "GET",
): WrenchManifest {
  const write = risk === "R3";
  const operationId = write ? "messaging.send" : "content.read";
  return {
    schemaVersion: 5,
    id: "example-api",
    version: "1.0.0",
    displayName: "Example API",
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: {
      [operationId]: {
        description: write ? "Send one message" : "Read one target",
        risk,
        sideEffect: write ? "Sends one externally visible message" : "none",
        idempotency: write ? "local-at-most-once" : "none",
        dedupeWindowMs: write ? 86_400_000 : 0,
        input: {
          properties: {
            target_id: {
              type: "string",
              description: "Exact target",
              minLength: 1,
              maxLength: 128,
              format: "path-segment",
            },
            body: { type: "string", description: "Exact body", minLength: 1, maxLength: 2_000 },
          },
          required: write ? ["target_id", "body"] : ["target_id"],
        },
        reviewedTemplate: {
          state: "reviewed",
          contractVersion: 1,
          reviewedAt: "2026-07-22T12:00:00.000Z",
          evidenceSha256: "a".repeat(64),
          timeoutMs: 30_000,
          template: {
            schemaVersion: 1,
            origin: "https://example.com",
            request: {
              method,
              path: [
                { kind: "literal", value: "api" },
                { kind: "input", name: "target_id", valueType: "string" },
              ],
              query: [],
              headers: [{ name: "accept", value: { kind: "literal", value: "application/json" } }],
              body: write
                ? {
                    kind: "json",
                    value: {
                      kind: "object",
                      entries: [{ name: "body", value: { kind: "input", name: "body", valueType: "string" } }],
                    },
                  }
                : { kind: "none" },
            },
            response: {
              maxBytes: 65_536,
              variants: [{
                status: 200,
                contentType: "application/json",
                body: {
                  kind: "json",
                  projections: [{
                    name: "id",
                    path: [{ kind: "key", key: "data" }, { kind: "key", key: "id" }],
                    valueType: "string",
                    required: true,
                  }],
                  bindings: write
                    ? [{
                        path: [{ kind: "key", key: "data" }, { kind: "key", key: "target" }],
                        expected: { kind: "input", name: "target_id", valueType: "string" },
                      }]
                    : [],
                },
              }],
            },
          },
        },
      },
    },
  };
}

function installXProviderFixture(testState: TestState): void {
  installManifest(xProviderManifest(), { force: false, environment: testState.environment });
  saveAuth(createAuth("x-official", {
    oauthProvider: "x",
    tokenFile: join(testState.directory, "x-token.json"),
    scopes: ["tweet.read", "tweet.write", "users.read"],
    subject: "12345",
  }), testState.environment);
}

function installFixture(testState: TestState, risk: "R1" | "R2" | "R3" = "R2"): void {
  void risk;
  installXProviderFixture(testState);
}

function prepared(testState: TestState, message = "private-message-value") {
  return prepareInvocation("x", "posts.publish", { body: message }, "x-official", testState.environment);
}

function preparedRead(testState: TestState) {
  return prepareInvocation(
    "x",
    "posts.read",
    { post_ids: ["2078889282404569267"] },
    "x-official",
    testState.environment,
  );
}

function preparedUpload(testState: TestState, source: string) {
  installFixture(testState);
  return prepareInvocation(
    "x",
    "posts.publish",
    { body: "reviewed media fixture", media: [source] },
    "x-official",
    testState.environment,
  );
}

function firstBoundFile(value: unknown): FileInputValue {
  const values: readonly unknown[] = Array.isArray(value) ? value : [];
  const candidate = values[0];
  if (
    typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
    || !("kind" in candidate)
    || candidate.kind !== "file"
    || !("reference" in candidate)
    || typeof candidate.reference !== "string"
  ) throw new Error("expected a bound upload");
  return { kind: "file", reference: candidate.reference };
}

function forgedProtectedBrowserInvocation(
  schemaVersion: 2 | 3,
  risk: "R1" | "R3",
  origin: "https://api.x.com" | "https://api.linkedin.com",
) {
  const protectedManifest: WrenchManifest = {
    ...manifest(risk),
    schemaVersion,
    id: `forged-${schemaVersion}`,
    origins: [origin],
    browserDomains: [new URL(origin).hostname],
  };
  return {
    manifest: protectedManifest,
    operationId: "messaging.send",
    input: { message: "must-not-run" },
    auth: auth(),
  };
}

function execution(
  status: BrowserExecution["status"] = "succeeded",
  dispatchStarted = status === "succeeded" || status === "indeterminate",
  error?: string,
  planned = 1,
): BrowserExecution {
  return {
    status,
    output: { observed: true },
    finalUrl: "https://example.com/messaging/thread/123",
    dispatchStarted,
    dispatch: {
      planned,
      started: dispatchStarted ? 1 : 0,
      verified: status === "succeeded" && dispatchStarted ? 1 : 0,
    },
    ...(error === undefined ? {} : { error }),
  };
}

function foreignProviderExecution(value: unknown): ProviderExecution {
  return value as ProviderExecution;
}

function providerReadExecution(output: unknown): ProviderExecution {
  return {
    status: "succeeded",
    output,
    finalUrl: null,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
  };
}

type TestProviderExecutor = NonNullable<
  Parameters<typeof confirmInvocation>[1]["executeProvider"]
>;
type TestProviderExecutionOptions = Parameters<TestProviderExecutor>[4];

async function reportProviderExecutionProgress(
  result: ProviderExecution,
  options: TestProviderExecutionOptions,
  dispatchIds: readonly string[] = ["posts-publish"],
): Promise<void> {
  if (dispatchIds.length !== result.dispatch.planned) {
    throw new Error("test executor dispatch IDs do not match the result schedule");
  }
  for (let index = 1; index <= result.dispatch.started; index += 1) {
    const id = dispatchIds[index - 1];
    if (id === undefined) throw new Error("test executor dispatch ID disappeared");
    await options?.beforeDispatch?.({
      id,
      index,
      progress: { planned: result.dispatch.planned, started: index - 1, verified: index - 1 },
    });
    if (index <= result.dispatch.verified) {
      await options?.afterDispatchVerified?.({
        id,
        index,
        progress: { planned: result.dispatch.planned, started: index, verified: index },
      });
    }
  }
}

function providerExecutor(
  result: ProviderExecution = execution(),
  onCall?: () => void,
): TestProviderExecutor {
  return async (_manifest, _recipe, _input, _auth, options) => {
    onCall?.();
    await reportProviderExecutionProgress(result, options);
    return result;
  };
}

function allFileText(root: string): string {
  const values: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) values.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return values.join("\n");
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}

function thrownMessage(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected callback to throw");
}

function testPlanKeyId(key: Uint8Array): string {
  return createHash("sha256")
    .update("io-plan-key-id-v1\0", "utf8")
    .update(key)
    .digest("hex");
}

function legacyEncryptedPlan(stored: StoredPlan, key: Uint8Array) {
  const iv = Buffer.from("legacy-plan!", "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(canonicalJson(stored), "utf8")),
    cipher.final(),
  ]);
  return {
    schemaVersion: 1,
    encryption: "aes-256-gcm",
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  } as const;
}

describe("read projection preparation", () => {
  test("prepares a read after another process settles its auth coordinate", async () => {
    const testState = state();
    let child: Awaited<
      ReturnType<typeof holdReadProjectionAdmissionInChild>
    > | null = null;
    try {
      installFixture(testState);
      child = await holdReadProjectionAdmissionInChild(
        testState,
        "x-official",
      );
      const invocation = preparedRead(testState);
      expect(invocation).toMatchObject({
        operationId: "posts.read",
        auth: { id: "x-official", subject: "12345" },
      });
      expect(await child.child.exited).toBe(0);
      expect(await child.stderr).toBe("");
      child = null;
    } finally {
      if (child !== null) await child.killAndReap();
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("protected browser action boundaries", () => {
  test("rejects forged schema-v2/v3 invocations before planning, staging, or execution", () => {
    for (const [schemaVersion, origin] of [
      [2, "https://api.x.com"],
      [3, "https://api.linkedin.com"],
    ] as const) {
      const write = forgedProtectedBrowserInvocation(schemaVersion, "R3", origin);
      expect(() => createInvocationPlan(write)).toThrow("browser actions are prohibited");

      const testState = state();
      let executorCalls = 0;
      try {
        expect(() => createAndSaveInvocationPlan(write, testState.environment)).toThrow(
          "browser actions are prohibited",
        );
        expect(readdirSync(testState.directory)).toHaveLength(0);

        const read = forgedProtectedBrowserInvocation(schemaVersion, "R1", origin);
        expect(executeReadInvocation(read, {
          headed: false,
          environment: testState.environment,
          executeProvider: () => {
            executorCalls += 1;
            return Promise.resolve(execution("succeeded", false, undefined, 0));
          },
        })).rejects.toThrow("browser actions are prohibited");
        expect(executorCalls).toBe(0);
        expect(readdirSync(testState.directory)).toHaveLength(0);
      } finally {
        rmSync(testState.directory, { recursive: true, force: true });
      }
    }
  });

  test("rejects a protected extra browser domain even when every declared origin is benign", () => {
    const protectedManifest: WrenchManifest = {
      ...manifest("R1"),
      schemaVersion: 2,
      browserDomains: ["example.com", "*.x.com"],
    };
    const invocation = {
      manifest: protectedManifest,
      operationId: "messaging.send",
      input: { message: "must-not-run" },
      auth: auth(),
    };
    expect(() => createInvocationPlan(invocation)).toThrow("protected signed-in site domain");

    const testState = state();
    let executorCalls = 0;
    try {
      expect(executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          executorCalls += 1;
          return Promise.resolve(execution("succeeded", false, undefined, 0));
        },
      })).rejects.toThrow("protected signed-in site domain");
      expect(executorCalls).toBe(0);
      expect(readdirSync(testState.directory)).toHaveLength(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects a syntactically valid generic schema-v2 DOM read before every direct boundary", () => {
    const operation = manifest("R1").operations["messaging.send"];
    if (operation === undefined) throw new Error("missing retired fixture operation");
    const retired: WrenchManifest = {
      ...manifest("R1"),
      schemaVersion: 2,
      operations: { "content.read": operation },
    };
    const invocation = {
      manifest: retired,
      operationId: "content.read",
      input: { message: "must-not-run" },
      auth: auth(),
    };
    const testState = state();
    let executorCalls = 0;
    try {
      expect(() => installManifest(retired, { force: false, environment: testState.environment }))
        .toThrow("runtime DOM action recipes are disabled");
      expect(() => createInvocationPlan(invocation)).toThrow("runtime DOM action recipes are disabled");
      expect(() => createAndSaveInvocationPlan(invocation, testState.environment))
        .toThrow("runtime DOM action recipes are disabled");
      expect(executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          executorCalls += 1;
          return Promise.resolve(execution("succeeded", false, undefined, 0));
        },
      })).rejects.toThrow("runtime DOM action recipes are disabled");
      expect(executorCalls).toBe(0);
      expect(readdirSync(testState.directory)).toHaveLength(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps the exact archived schema-v1 LinkedIn manifest parseable but runtime-inert", () => {
    const parsed = parseManifest(JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.v0.4.0.json"),
      "utf8",
    )) as unknown, providerPluginRegistry);
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) return;
    const invocation = {
      manifest: parsed.value,
      operationId: "profile.read",
      input: { profile_slug: "archived-member" },
      auth: auth(),
    };
    expect(() => createInvocationPlan(invocation)).toThrow("runtime DOM action recipes are disabled");

    const testState = state();
    let executorCalls = 0;
    try {
      expect(executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          executorCalls += 1;
          return Promise.resolve(execution("succeeded", false, undefined, 0));
        },
      })).rejects.toThrow("runtime DOM action recipes are disabled");
      expect(executorCalls).toBe(0);
      expect(readdirSync(testState.directory)).toHaveLength(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects every generic profile recipe before an injected executor or browser session can start", () => {
    const testState = state();
    const invocation = (selectedAuth: WrenchAuth) => ({
      manifest: manifest("R1"),
      operationId: "messaging.send",
      input: { message: "read-only-input" },
      auth: selectedAuth,
    });
    try {
      for (const selectedAuth of [
        {
          schemaVersion: 1,
          id: "arc-main",
          kind: "browser-profile",
          profile: "Profile 1",
          trustUnfilteredEgress: true,
          subject: "viewer-123",
        },
        {
          schemaVersion: 1,
          id: "arc-main",
          kind: "browser-profile",
          profile: "Profile 1",
          trustUnfilteredEgress: true,
          cookieSource: "arc",
          cookieProfile: "Profile 2",
          subject: "viewer-123",
        },
      ] satisfies readonly WrenchAuth[]) {
        let executorCalls = 0;
        expect(executeReadInvocation(invocation(selectedAuth), {
          headed: false,
          environment: testState.environment,
          executeProvider: () => {
            executorCalls += 1;
            return Promise.resolve(execution("succeeded", false, undefined, 0));
          },
        })).rejects.toThrow("runtime DOM action recipes are disabled");
        expect(executorCalls).toBe(0);
      }
      expect(readdirSync(testState.directory)).toHaveLength(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("encrypted confirmation plans", () => {
  test("rejects capture-required web capabilities through every exported invocation boundary", () => {
    const testState = state();
    try {
      const selectedManifest = linkedinWebManifest();
      const selectedAuth: WrenchAuth = {
        schemaVersion: 1,
        id: "linkedin-web-test",
        kind: "cookie-source",
        source: "arc",
        profile: "Default",
        subject: "urn:li:fsd_profile:123",
      };
      installManifest(selectedManifest, { force: false, environment: testState.environment });
      saveAuth(selectedAuth, testState.environment);
      for (const [operationId, input] of [
        ["articles.read", { author_urn: "urn:li:fsd_profile:123", limit: 20 }],
        ["messaging.list", { folder: "focused", limit: 20 }],
      ] as const) {
        expect(() => prepareInvocation(
          "linkedin-web",
          operationId,
          input,
          "linkedin-web-test",
          testState.environment,
        )).toThrow("is capture-required");
        const direct = {
          manifest: selectedManifest,
          operationId,
          input,
          auth: selectedAuth,
        };
        expect(() => createInvocationPlan(direct)).toThrow("is capture-required");
        expect(() => createAndSaveInvocationPlan(direct, testState.environment)).toThrow("is capture-required");
        let executorCalls = 0;
        expect(executeReadInvocation(direct, {
          headed: false,
          environment: testState.environment,
          executeWebSession: () => {
            executorCalls += 1;
            return Promise.reject(new Error("must not execute"));
          },
        })).rejects.toThrow("is capture-required");
        expect(executorCalls).toBe(0);
      }
      expect(listInvocationPlans(testState.environment)).toEqual([]);
      expect(existsSync(join(testState.directory, "plans"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("never persists a capture-required X write reached through a direct prepared invocation", () => {
    const testState = state();
    try {
      const direct = {
        manifest: xWebManifest(),
        operationId: "posts.publish",
        input: { body: "This capture-required write must remain inert" },
        auth: createAuth("x-web-test", {
          source: "arc",
          profile: "Profile 1",
          subject: "12345",
        }),
      };
      expect(() => createInvocationPlan(direct)).toThrow("is capture-required");
      expect(() => createAndSaveInvocationPlan(direct, testState.environment)).toThrow("is capture-required");
      expect(existsSync(join(testState.directory, "plans"))).toBeFalse();
      expect(readdirSync(testState.directory)).toHaveLength(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects an unbound or malformed X web-session write before creating durable preview state", () => {
    for (const subject of [undefined, "viewer-not-an-x-id"] as const) {
      const testState = state();
      try {
        installManifest(xWebManifest(), { force: false, environment: testState.environment });
        const selectedAuth = createAuth("x-web-test", {
          source: "arc",
          profile: "Profile 1",
          ...(subject === undefined ? {} : { subject }),
        });
        saveAuth(selectedAuth, testState.environment);
        expect(() => prepareInvocation(
          "x-web",
          "likes.set",
          { post_id: "2078889282404569267", liked: true },
          "x-web-test",
          testState.environment,
        )).toThrow(subject === undefined ? "account-bound auth subject" : "exact current-account subject");
        expect(() => createAndSaveInvocationPlan({
          manifest: xWebManifest(),
          operationId: "likes.set",
          input: { post_id: "2078889282404569267", liked: true },
          auth: selectedAuth,
        }, testState.environment)).toThrow(
          subject === undefined ? "account-bound auth subject" : "exact current-account subject",
        );
        expect(existsSync(join(testState.directory, "plans"))).toBeFalse();
      } finally {
        rmSync(testState.directory, { recursive: true, force: true });
      }
    }
  });

  test("rejects an unbound provider write and an unverified LinkedIn actor before preview", () => {
    const xAuth = createAuth("x-official", {
      oauthProvider: "x",
      tokenFile: "/private/x-token.json",
      scopes: ["tweet.read", "tweet.write", "users.read"],
    });
    expect(() => createInvocationPlan({
      manifest: xProviderManifest(),
      operationId: "threads.publish",
      input: { items: ["one bounded item"] },
      auth: xAuth,
    })).toThrow("account-bound auth subject");

    const linkedinManifest = JSON.parse(readFileSync(
      join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.json"),
      "utf8",
    )) as WrenchManifest;
    const linkedinAuth = createAuth("linkedin-official", {
      oauthProvider: "linkedin",
      tokenFile: "/private/linkedin-token.json",
      scopes: ["w_organization_social"],
      subject: "urn:li:person:member-1",
    });
    expect(() => createInvocationPlan({
      manifest: linkedinManifest,
      operationId: "posts.publish",
      input: {
        author: "urn:li:organization:123",
        body: "A bounded organization post",
      },
      auth: linkedinAuth,
    })).toThrow("administered-organization delegation has no reviewed preflight");
  });

  test("revalidates exact LinkedIn provider input before binding its requested actor", () => {
    const testState = state();
    try {
      const linkedinManifest = JSON.parse(readFileSync(
        join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.json"),
        "utf8",
      )) as WrenchManifest;
      const linkedinAuth = createAuth("linkedin-official", {
        oauthProvider: "linkedin",
        tokenFile: "/private/linkedin-token.json",
        scopes: ["w_member_social"],
        subject: "urn:li:person:member-1",
      });
      const forgedInput = {
        author: "urn:li:organization:123",
        actor: "urn:li:person:member-1",
        body: "A bounded organization post",
      };
      const direct = {
        manifest: linkedinManifest,
        operationId: "posts.publish",
        input: forgedInput,
        auth: linkedinAuth,
      };
      expect(() => createInvocationPlan(direct)).toThrow("input.actor is not supported");
      expect(() => createAndSaveInvocationPlan(direct, testState.environment))
        .toThrow("input.actor is not supported");
      expect(existsSync(join(testState.directory, "plans"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects forged provider risk semantics and wrong auth before planning or execution", () => {
    const testState = state();
    try {
      const selectedManifest = xProviderManifest();
      const selectedOperation = selectedManifest.operations["posts.publish"];
      if (selectedOperation === undefined) throw new Error("X provider fixture is missing posts.publish");
      const forgedManifest: WrenchManifest = {
        ...selectedManifest,
        operations: {
          ...selectedManifest.operations,
          "posts.publish": {
            ...selectedOperation,
            risk: "R1",
            sideEffect: "none",
            idempotency: "none",
            dedupeWindowMs: 0,
          },
        },
      };
      const selectedAuth = createAuth("x-official", {
        oauthProvider: "x",
        tokenFile: "/private/x-token.json",
        scopes: ["tweet.read", "tweet.write", "users.read"],
        subject: "12345",
      });
      const forged = {
        manifest: forgedManifest,
        operationId: "posts.publish",
        input: { body: "This must never be dispatched" },
        auth: selectedAuth,
      };
      expect(() => createInvocationPlan(forged)).toThrow("risk must match provider contract risk R3");
      let providerCalls = 0;
      expect(executeReadInvocation(forged, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          providerCalls += 1;
          return Promise.reject(new Error("must not execute"));
        },
      })).rejects.toThrow("risk must match provider contract risk R3");
      expect(providerCalls).toBe(0);

      const wrongTransport = {
        manifest: selectedManifest,
        operationId: "feeds.read",
        input: { feed: "bookmarks" },
        auth: auth(),
      };
      expect(() => createInvocationPlan(wrongTransport)).toThrow("require an oauth-token-file");
      expect(executeReadInvocation(wrongTransport, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          providerCalls += 1;
          return Promise.reject(new Error("must not execute"));
        },
      })).rejects.toThrow("require an oauth-token-file");
      expect(providerCalls).toBe(0);
      expect(readdirSync(testState.directory)).toHaveLength(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("prepares the observed X bookmark contract as one confirmed desired-state dispatch", () => {
    const testState = state();
    try {
      installManifest(xWebManifest(), { force: false, environment: testState.environment });
      saveAuth({
        schemaVersion: 1,
        id: "x-web-test",
        kind: "cookie-source",
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      }, testState.environment);
      const invocation = prepareInvocation(
        "x-web",
        "content.save",
        { post_id: "2078889282404569267", saved: true },
        "x-web-test",
        testState.environment,
      );
      const plan = createInvocationPlan(invocation, new Date("2026-07-22T20:00:00.000Z"));
      expect(plan.plan.dispatches).toEqual([expect.objectContaining({ id: "content.save" })]);
      expect(plan.plan.risk).toBe("R2");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("round-trips semantic dotted web-session dispatch IDs through encrypted plans", () => {
    const testState = state();
    try {
      const webAuth = {
        schemaVersion: 1,
        id: "x-web-test",
        kind: "cookie-source",
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      } as const satisfies WrenchAuth;
      const invocation = {
        manifest: xWebManifest(),
        operationId: "content.save",
        input: { post_id: "2078889282404569267", saved: true },
        auth: webAuth,
      };
      const plan = createInvocationPlan(invocation, new Date("2026-07-22T20:00:00.000Z"));
      expect(plan.plan.dispatches).toEqual([expect.objectContaining({ id: "content.save" })]);
      saveInvocationPlan(plan, testState.environment);
      expect(loadInvocationPlan(plan.digest, testState.environment)).toEqual(plan);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps an R2 confirmation plan reusable when cleanup admission blocks execution", async () => {
    const testState = state();
    try {
      const selectedManifest = xWebManifest();
      const selectedAuth = createAuth("x-web-test", {
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      });
      installManifest(selectedManifest, {
        force: false,
        environment: testState.environment,
      });
      saveAuth(selectedAuth, testState.environment);
      const invocation = prepareInvocation(
        "x-web",
        "content.save",
        { post_id: "2078889282404569267", saved: true },
        selectedAuth.id,
        testState.environment,
      );
      const stored = createAndSaveInvocationPlan(
        invocation,
        testState.environment,
      );
      const admission = acquireWebSessionCleanupAdmission(
        {
          runId: "00000000-0000-4000-8000-000000000002",
          pluginId: "x-web",
          pluginVersion: "1.0.0",
          pluginImplementationHash: "a".repeat(64),
          adapterId: selectedManifest.id,
          adapterHash: sha256(canonicalJson(selectedManifest)),
          surfaceId: "x",
          authId: selectedAuth.id,
          authHash: sha256(canonicalJson(selectedAuth)),
        },
        testState.environment,
      );
      admission.registerCleanupBarrier(
        Promise.reject(new Error("synthetic cleanup uncertainty")),
      );
      admission.closeRegistration();
      admission.cleanupUnsafe();
      let executorCalls = 0;

      expect(await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeWebSession: () => {
          executorCalls += 1;
          throw new Error("cleanup-unsafe writes must not start");
        },
      }))).toContain("active or cleanup-unsafe state");

      expect(executorCalls).toBe(0);
      expect(loadInvocationPlan(stored.digest, testState.environment))
        .toEqual(stored);
      expect(existsSync(join(testState.directory, "runs"))).toBeFalse();
      expect(listWebSessionCleanupAdmissions(testState.environment))
        .toHaveLength(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("records an independently verified desired-state no-op without fabricating a dispatch", async () => {
    const testState = state();
    try {
      installManifest(xWebManifest(), { force: false, environment: testState.environment });
      saveAuth({
        schemaVersion: 1,
        id: "x-web-test",
        kind: "cookie-source",
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      }, testState.environment);
      const invocation = prepareInvocation(
        "x-web",
        "content.save",
        { post_id: "2078889282404569267", saved: true },
        "x-web-test",
        testState.environment,
      );
      const firstPlan = createAndSaveInvocationPlan(invocation, testState.environment);
      let executorCalls = 0;
      const first = await confirmInvocation(firstPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeWebSession: () => {
          executorCalls += 1;
          return Promise.resolve({
            status: "succeeded",
            output: {
              effect: "already-satisfied",
              kind: "bookmark",
              enabled: true,
              postId: "2078889282404569267",
            },
            finalUrl: "https://x.com/i/status/2078889282404569267",
            noOp: true,
            dispatchStarted: false,
            dispatch: { planned: 1, started: 0, verified: 0 },
          });
        },
      });

      expect(first.receipt.status).toBe("succeeded");
      expect(first.receipt.dispatchStarted).toBeFalse();
      expect(first.receipt.dispatch).toEqual({ planned: 1, started: 0, verified: 0 });
      expect(first.output).toEqual(expect.objectContaining({ effect: "already-satisfied" }));

      const replayPlan = createAndSaveInvocationPlan(invocation, testState.environment);
      const replay = await confirmInvocation(replayPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeWebSession: () => {
          executorCalls += 1;
          throw new Error("a successful desired-state no-op must deduplicate");
        },
      });
      expect(replay.replayed).toBeTrue();
      expect(replay.receipt.runId).toBe(first.receipt.runId);
      expect(executorCalls).toBe(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("encrypts exact inputs at rest and uses private state modes", () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState), new Date("2026-07-21T12:00:00.000Z"));
      const path = saveInvocationPlan(stored, testState.environment);
      const raw = readFileSync(path, "utf8");

      expect(raw).toContain('"encryption":"aes-256-gcm"');
      expect(raw).not.toContain("private-message-value");
      expect(loadInvocationPlan(stored.digest, testState.environment)).toEqual(stored);
      expect(lstatSync(testState.directory).mode & 0o777).toBe(0o700);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(testState.directory, ".plan-encryption-key")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("writes a key-identified v2 envelope authenticated with plan AAD", () => {
    const testState = state();
    try {
      installFixture(testState);
      const secret = "private-v2-plan-aad-value";
      const stored = createInvocationPlan(prepared(testState, secret));
      const path = saveInvocationPlan(stored, testState.environment);
      const envelopeText = readFileSync(path, "utf8");
      const envelope = JSON.parse(envelopeText) as {
        readonly schemaVersion: number;
        readonly encryption: string;
        readonly keyId: string;
        readonly iv: string;
        readonly ciphertext: string;
        readonly tag: string;
      };
      const keyText = readFileSync(join(testState.directory, ".plan-encryption-key"), "utf8");
      const keyDocument = JSON.parse(keyText) as {
        readonly schemaVersion: number;
        readonly keyId: string;
        readonly key: string;
      };
      const key = Buffer.from(keyDocument.key, "hex");

      expect(Object.keys(envelope).sort()).toEqual([
        "ciphertext",
        "encryption",
        "iv",
        "keyId",
        "schemaVersion",
        "tag",
      ]);
      expect(envelope.schemaVersion).toBe(2);
      expect(envelope.encryption).toBe("aes-256-gcm");
      expect(keyDocument.schemaVersion).toBe(2);
      expect(keyDocument.keyId).toBe(testPlanKeyId(key));
      expect(envelope.keyId).toBe(keyDocument.keyId);
      expect(envelopeText).not.toContain(keyDocument.key);
      expect(envelopeText).not.toContain(secret);

      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(`io-plan-v2\0${envelope.keyId}`, "utf8"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      expect(JSON.parse(plaintext.toString("utf8"))).toEqual(stored);

      expect(() => {
        const unauthenticated = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(envelope.iv, "base64"),
        );
        unauthenticated.setAuthTag(Buffer.from(envelope.tag, "base64"));
        unauthenticated.update(Buffer.from(envelope.ciphertext, "base64"));
        unauthenticated.final();
      }).toThrow();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reads a legacy v1 key and unauthenticated-metadata envelope without rewriting either", () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState, "legacy-private-plan-value"));
      const path = saveInvocationPlan(stored, testState.environment);
      const keyPath = join(testState.directory, ".plan-encryption-key");
      const legacyKey = Buffer.from("17".repeat(32), "hex");
      const legacyKeyText = `${JSON.stringify({
        schemaVersion: 1,
        key: legacyKey.toString("hex"),
      })}\n`;
      const legacyEnvelopeText = `${JSON.stringify(legacyEncryptedPlan(stored, legacyKey))}\n`;
      writeFileSync(keyPath, legacyKeyText, { mode: 0o600 });
      writeFileSync(path, legacyEnvelopeText, { mode: 0o600 });

      expect(loadInvocationPlan(stored.digest, testState.environment)).toEqual(stored);
      expect(readFileSync(keyPath, "utf8")).toBe(legacyKeyText);
      expect(readFileSync(path, "utf8")).toBe(legacyEnvelopeText);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses to replace a missing key while ciphertext exists", () => {
    const testState = state();
    try {
      installFixture(testState);
      const secret = "private-missing-key-plan-value";
      const stored = createInvocationPlan(prepared(testState, secret));
      const path = saveInvocationPlan(stored, testState.environment);
      const keyPath = join(testState.directory, ".plan-encryption-key");
      const envelopeText = readFileSync(path, "utf8");
      const ciphertext = (JSON.parse(envelopeText) as { readonly ciphertext: string }).ciphertext;
      unlinkSync(keyPath);

      const message = thrownMessage(() => saveInvocationPlan(stored, testState.environment));
      expect(message).toContain("key is missing while encrypted plans still exist");
      expect(message).toContain("refusing to replace it");
      expect(message).not.toContain(secret);
      expect(message).not.toContain(ciphertext);
      expect(existsSync(keyPath)).toBeFalse();
      expect(readFileSync(path, "utf8")).toBe(envelopeText);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on a malformed key without replacing the key or plan", () => {
    const testState = state();
    try {
      installFixture(testState);
      const secret = "private-malformed-key-plan-value";
      const stored = createInvocationPlan(prepared(testState, secret));
      const path = saveInvocationPlan(stored, testState.environment);
      const keyPath = join(testState.directory, ".plan-encryption-key");
      const envelopeText = readFileSync(path, "utf8");
      const ciphertext = (JSON.parse(envelopeText) as { readonly ciphertext: string }).ciphertext;
      const malformedKeySecret = "private-malformed-key-material";
      const malformedKeyText = `${JSON.stringify({
        schemaVersion: 2,
        key: malformedKeySecret,
      })}\n`;
      writeFileSync(keyPath, malformedKeyText, { mode: 0o600 });

      const message = thrownMessage(() => saveInvocationPlan(stored, testState.environment));
      expect(message).toContain("plan encryption key is malformed");
      expect(message).not.toContain(secret);
      expect(message).not.toContain(malformedKeySecret);
      expect(message).not.toContain(ciphertext);
      expect(readFileSync(keyPath, "utf8")).toBe(malformedKeyText);
      expect(readFileSync(path, "utf8")).toBe(envelopeText);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on a replaced valid key without overwriting unreadable ciphertext", () => {
    const testState = state();
    try {
      installFixture(testState);
      const secret = "private-replaced-key-plan-value";
      const stored = createInvocationPlan(prepared(testState, secret));
      const path = saveInvocationPlan(stored, testState.environment);
      const keyPath = join(testState.directory, ".plan-encryption-key");
      const envelopeText = readFileSync(path, "utf8");
      const ciphertext = (JSON.parse(envelopeText) as { readonly ciphertext: string }).ciphertext;
      const replacementKey = Buffer.from("e3".repeat(32), "hex");
      const replacementKeyText = `${JSON.stringify({
        schemaVersion: 2,
        keyId: testPlanKeyId(replacementKey),
        key: replacementKey.toString("hex"),
      })}\n`;
      writeFileSync(keyPath, replacementKeyText, { mode: 0o600 });

      const message = thrownMessage(() => saveInvocationPlan(stored, testState.environment));
      expect(message).toMatch(/encrypted plan|key identity|overwrite/iu);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(replacementKey.toString("hex"));
      expect(message).not.toContain(ciphertext);
      expect(readFileSync(keyPath, "utf8")).toBe(replacementKeyText);
      expect(readFileSync(path, "utf8")).toBe(envelopeText);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects authenticated-ciphertext tampering", () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState));
      const path = saveInvocationPlan(stored, testState.environment);
      const encrypted = JSON.parse(readFileSync(path, "utf8")) as { ciphertext: string };
      encrypted.ciphertext = `${encrypted.ciphertext.startsWith("A") ? "B" : "A"}${encrypted.ciphertext.slice(1)}`;
      writeFileSync(path, `${JSON.stringify(encrypted)}\n`, { mode: 0o600 });
      expect(() => loadInvocationPlan(stored.digest, testState.environment)).toThrow();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("purges expired plans but leaves malformed evidence for inspection", () => {
    const testState = state();
    try {
      installFixture(testState);
      const createdAt = new Date("2026-07-21T12:00:00.000Z");
      const stored = createInvocationPlan(prepared(testState), createdAt);
      const planPath = saveInvocationPlan(stored, testState.environment);
      const malformedPath = join(testState.directory, "plans", `${"f".repeat(64)}.json`);
      writeFileSync(malformedPath, "not-json\n", { mode: 0o600 });

      expect(purgeExpiredPlans(testState.environment, new Date(createdAt.getTime() + PLAN_TTL_MS + 1))).toBe(1);
      expect(existsSync(planPath)).toBeFalse();
      expect(existsSync(malformedPath)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("lists only plan metadata and explicitly cancels one encrypted preview", () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState, "private-message-value"));
      saveInvocationPlan(stored, testState.environment);
      const listed = listInvocationPlans(testState.environment);
      expect(listed).toEqual([{
        digest: stored.digest,
        createdAt: stored.plan.createdAt,
        expiresAt: stored.plan.expiresAt,
        adapter: { id: "x", version: "1.2.0" },
        operation: "posts.publish",
        risk: "R3",
        auth: { id: "x-official", kind: "oauth-token-file" },
      }]);
      expect(JSON.stringify(listed)).not.toContain("private-message-value");
      expect(cancelInvocationPlan(stored.digest, testState.environment)).toBeTrue();
      expect(cancelInvocationPlan(stored.digest, testState.environment)).toBeFalse();
      expect(listInvocationPlans(testState.environment)).toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("round-trips a bounded long-form article near the contract maximum", () => {
    const testState = state();
    try {
      installFixture(testState);
      const body = "a".repeat(20_000);
      expect(Buffer.byteLength(body, "utf8")).toBe(20_000);
      const invocation = prepareInvocation(
        "x",
        "articles.publish",
        { title: "Bounded article", body },
        "x-official",
        testState.environment,
      );
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      expect(loadInvocationPlan(stored.digest, testState.environment)).toEqual(stored);
      expect(cancelInvocationPlan(stored.digest, testState.environment)).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("confirmation binding and consumption", () => {
  test("consumes a successful plan exactly once and retains no input secret", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const secret = "private-message-value-☃";
      const stored = createInvocationPlan(prepared(testState, secret));
      const path = saveInvocationPlan(stored, testState.environment);
      let calls = 0;
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(execution(), () => { calls += 1; }),
      });

      expect(result.receipt.status).toBe("submitted");
      expect(result.receipt.dispatchStarted).toBeTrue();
      expect(calls).toBe(1);
      expect(existsSync(path)).toBeFalse();
      expect(readdirSync(join(testState.directory, "recovery", "capsules"))).toEqual([]);
      expect(existsSync(join(testState.directory, ".recovery-encryption-key"))).toBeTrue();
      expect(await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve(execution("succeeded", false, undefined, 0)),
      }))).toContain("could not safely open encrypted plan");
      expect(allFileText(testState.directory)).not.toContain(secret);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("consumes an expired plan without dispatching", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const createdAt = new Date("2026-07-21T12:00:00.000Z");
      const stored = createInvocationPlan(prepared(testState), createdAt);
      const path = saveInvocationPlan(stored, testState.environment);
      let calls = 0;
      expect(await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        now: new Date(createdAt.getTime() + PLAN_TTL_MS + 1),
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution());
        },
      }))).toContain("expired");
      expect(calls).toBe(0);
      expect(existsSync(path)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects and consumes plans after adapter drift", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState));
      const path = saveInvocationPlan(stored, testState.environment);
      installManifest({ ...xProviderManifest(), displayName: "Drifted X" }, {
        force: true,
        environment: testState.environment,
      });

      expect(await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve(execution("succeeded", false, undefined, 0)),
      }))).toContain("adapter changed after preview");
      expect(existsSync(path)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects and consumes plans after auth drift", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState));
      const path = saveInvocationPlan(stored, testState.environment);
      saveAuth(createAuth("x-official", {
        oauthProvider: "x",
        tokenFile: join(testState.directory, "different-x-token.json"),
        scopes: ["tweet.read", "tweet.write", "users.read"],
        subject: "12345",
      }), testState.environment, { force: true });

      expect(await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve(execution()),
      }))).toContain("authentication selection changed after preview");
      expect(existsSync(path)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("local at-most-once dispatch ledger", () => {
  test("terminal repair preserves a successor that reused the old ledger coordinate", () => {
    const testState = state();
    try {
      const runId = "60000000-0000-4000-8000-000000000006";
      const successorRunId = "70000000-0000-4000-8000-000000000007";
      const inputHash = "d".repeat(64);
      const ledgerRelativePath = `idempotency/aa/${inputHash}.json`;
      const journal = parseRunJournal({
        schemaVersion: 1,
        revision: 4,
        runId,
        planDigest: "e".repeat(64),
        adapter: { id: "x", version: "1.0.0", hash: "a".repeat(64) },
        operation: "posts.publish",
        risk: "R3",
        inputHash,
        auth: {
          id: "x-official",
          hash: "b".repeat(64),
          kind: "oauth-token-file",
        },
        contract: { transport: "provider-api", hash: "c".repeat(64) },
        planHasAssets: false,
        planState: "consumed",
        phase: "terminal",
        status: "failed",
        dispatch: { planned: 1, started: 0, verified: 0 },
        ledgerRelativePath,
        ledgerState: "released",
        recoveryState: "released",
        assetState: "none",
        owner: {
          pid: 2_147_483_647,
          token: "60000000-0000-4000-8000-000000000006",
          bootId: "f".repeat(64),
          processStartId: "0".repeat(64),
          leaseUntil: "2026-07-25T12:01:00.000Z",
        },
        startedAt: "2026-07-25T12:00:00.000Z",
        updatedAt: "2026-07-25T12:00:01.000Z",
        dedupeExpiresAt: "2026-07-26T12:00:00.000Z",
        finalOrigin: null,
        error: "execution failed before dispatch",
      });
      createRunJournal(journal, testState.environment);
      if (journal.contract.transport !== "provider-api") {
        throw new Error("test journal changed provider transport");
      }
      writePrivateJson(
        join(wrenchStateHome(testState.environment), "runs", `${runId}.json`),
        {
          schemaVersion: 3,
          transport: "provider-api",
          runId,
          planDigest: journal.planDigest,
          adapter: journal.adapter,
          operation: journal.operation,
          risk: journal.risk,
          inputHash: journal.inputHash,
          auth: journal.auth,
          status: journal.status,
          dispatchStarted: false,
          dispatch: journal.dispatch,
          startedAt: journal.startedAt,
          finishedAt: journal.updatedAt,
          finalOrigin: journal.finalOrigin,
          error: journal.error,
          providerContractHash: journal.contract.hash,
        },
        { privateParent: true },
      );
      const ledgerPath = join(
        testState.directory,
        ...ledgerRelativePath.split("/"),
      );
      writePrivateJson(ledgerPath, {
        schemaVersion: 2,
        keyHash: inputHash,
        adapterHash: journal.adapter.hash,
        authHash: journal.auth.hash,
        inputHash,
        planDigest: "1".repeat(64),
        status: "pending",
        dispatch: { planned: 1, started: 0, verified: 0 },
        runId: successorRunId,
        updatedAt: "2026-07-25T12:02:00.000Z",
        expiresAt: "2026-07-26T12:02:00.000Z",
      }, { privateParent: true });
      ensurePrivateStateDirectory(
        join(wrenchStateHome(testState.environment), "recovery", "capsules"),
        testState.environment,
      );
      const successorBefore = readFileSync(ledgerPath, "utf8");

      expect(repairInterruptedRunJournals(
        testState.environment,
        new Date("2026-07-25T12:03:00.000Z"),
      )).toEqual({
        inspected: 1,
        repaired: 0,
        projected: 1,
        invalid: 0,
        issues: [],
      });

      expect(readFileSync(ledgerPath, "utf8")).toBe(successorBefore);
      expect(readRunReceipt(runId, testState.environment)).toMatchObject({
        status: "failed",
        dispatch: { planned: 1, started: 0, verified: 0 },
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("admits only one concurrent confirmation for the same action scope", async () => {
    const testState = state();
    const control: { release?: () => void } = {};
    try {
      installFixture(testState);
      const firstPlan = createInvocationPlan(prepared(testState));
      const secondPlan = createInvocationPlan(prepared(testState));
      saveInvocationPlan(firstPlan, testState.environment);
      saveInvocationPlan(secondPlan, testState.environment);
      let calls = 0;
      const gate = new Promise<void>((resolve) => {
        control.release = resolve;
      });
      const first = confirmInvocation(firstPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: async (_manifest, _recipe, _input, _auth, options) => {
          calls += 1;
          await gate;
          const result = execution();
          await reportProviderExecutionProgress(result, options);
          return result;
        },
      });
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const secondMessage = await rejectionMessage(confirmInvocation(secondPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution());
        },
      }));
      expect(secondMessage).toContain("may have reached the provider");
      expect(calls).toBe(1);
      control.release?.();
      expect((await first).receipt.status).toBe("submitted");
    } finally {
      control.release?.();
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("elects only one successor after an expired successful generation", async () => {
    const testState = state();
    const control: { release?: () => void } = {};
    try {
      installFixture(testState);
      const started = new Date();
      const firstPlan = createInvocationPlan(prepared(testState), started);
      saveInvocationPlan(firstPlan, testState.environment);
      let calls = 0;
      await confirmInvocation(firstPlan.digest, {
        headed: false,
        environment: testState.environment,
        now: started,
        executeProvider: providerExecutor(execution(), () => { calls += 1; }),
      });

      const nextWindow = new Date(started.getTime() + 86_400_001);
      const secondPlan = createInvocationPlan(prepared(testState), nextWindow);
      const thirdPlan = createInvocationPlan(prepared(testState), nextWindow);
      saveInvocationPlan(secondPlan, testState.environment);
      saveInvocationPlan(thirdPlan, testState.environment);
      const gate = new Promise<void>((resolve) => {
        control.release = resolve;
      });
      const second = confirmInvocation(secondPlan.digest, {
        headed: false,
        environment: testState.environment,
        now: nextWindow,
        executeProvider: async (_manifest, _recipe, _input, _auth, options) => {
          calls += 1;
          await gate;
          const result = execution();
          await reportProviderExecutionProgress(result, options);
          return result;
        },
      });
      while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1));
      const thirdMessage = await rejectionMessage(confirmInvocation(thirdPlan.digest, {
        headed: false,
        environment: testState.environment,
        now: nextWindow,
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution());
        },
      }));
      expect(thirdMessage).toContain("may have reached the provider");
      expect(calls).toBe(2);
      control.release?.();
      expect((await second).receipt.status).toBe("submitted");
    } finally {
      control.release?.();
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("stores a provisional run receipt before crossing into browser execution", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState));
      saveInvocationPlan(stored, testState.environment);
      const observed: { status: string | null } = { status: null };
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(execution(), () => {
          const runFiles = readdirSync(join(testState.directory, "runs"));
          expect(runFiles).toHaveLength(1);
          observed.status = (JSON.parse(readFileSync(join(testState.directory, "runs", runFiles[0] as string), "utf8")) as { status: string }).status;
        }),
      });
      expect(observed.status).toBe("pending");
      expect(result.receipt.status).toBe("submitted");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses dispatch and preserves immutable failed evidence when the recovery capsule cannot be stored", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const invocation = prepared(testState);
      const first = createAndSaveInvocationPlan(invocation, testState.environment);
      const keyPath = join(testState.directory, ".recovery-encryption-key");
      writePrivateJson(keyPath, { schemaVersion: 1, key: "malformed" }, {
        privateParent: true,
      });
      let calls = 0;
      expect(await rejectionMessage(confirmInvocation(first.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution());
        },
      }))).toContain("recovery capsule could not be stored");
      expect(calls).toBe(0);
      const [failed] = listRunReceipts(testState.environment);
      expect(failed).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
      });
      if (failed === undefined || "invalid" in failed) {
        throw new Error("expected immutable failed receipt evidence");
      }
      expect(failed.error).toContain(
        "encrypted recovery state could not be made durable before dispatch",
      );
      expect(readRunJournal(failed.runId, testState.environment)?.journal)
        .toMatchObject({
          phase: "terminal",
          status: "failed",
          planState: "consumed",
          ledgerState: "released",
          recoveryState: "released",
          dispatch: { planned: 1, started: 0, verified: 0 },
        });
      expect(readdirSync(join(testState.directory, "recovery", "capsules"))).toEqual([]);
      const ledgerEntries = readdirSync(join(testState.directory, "idempotency"), {
        recursive: true,
      }).filter((entry) => String(entry).endsWith(".json"));
      expect(ledgerEntries).toEqual([]);

      rmSync(keyPath);
      const retry = createAndSaveInvocationPlan(invocation, testState.environment);
      const retried = await confirmInvocation(retry.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(execution(), () => { calls += 1; }),
      });
      expect(retried.receipt.status).toBe("submitted");
      expect(calls).toBe(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses dispatch rather than replacing a lost recovery key for an older capsule", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const priorInput = { post_id: "2078889282404569267", saved: true };
      const priorRunId = "90000000-0000-4000-8000-000000000009";
      const priorCapsule: RecoveryCapsule = {
        schemaVersion: 1,
        runId: priorRunId,
        createdAt: "2026-07-23T12:00:00.000Z",
        planDigest: "a".repeat(64),
        adapter: { id: "x-web", version: "1.0.0", hash: "b".repeat(64) },
        operation: "content.save",
        risk: "R2",
        input: priorInput,
        inputHash: sha256(canonicalJson(priorInput)),
        auth: { id: "x-main", hash: "c".repeat(64), kind: "cookie-source" },
        contract: {
          transport: "web-session-api",
          site: "x",
          action: "content.save",
          version: 1,
          hash: "d".repeat(64),
        },
      };
      writeRecoveryCapsule(priorCapsule, testState.environment);
      const keyPath = join(testState.directory, ".recovery-encryption-key");
      rmSync(keyPath);
      const invocation = prepared(testState, "new write must not dispatch");
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      let calls = 0;

      expect(await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution());
        },
      }))).toContain("recovery capsule could not be stored");

      expect(calls).toBe(0);
      expect(existsSync(keyPath)).toBeFalse();
      expect(existsSync(join(
        testState.directory,
        "recovery",
        "capsules",
        `${priorRunId}.json`,
      ))).toBeTrue();
      expect(readdirSync(join(testState.directory, "recovery", "capsules")))
        .toEqual([`${priorRunId}.json`]);
      const [failed] = listRunReceipts(testState.environment);
      expect(failed).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
      });
      if (failed === undefined || "invalid" in failed) {
        throw new Error("expected immutable failed receipt evidence");
      }
      expect(readRunJournal(failed.runId, testState.environment)?.journal)
        .toMatchObject({
          phase: "terminal",
          status: "failed",
          planState: "consumed",
          ledgerState: "released",
          recoveryState: "released",
          dispatch: { planned: 1, started: 0, verified: 0 },
        });
      const ledgerEntries = readdirSync(join(testState.directory, "idempotency"), {
        recursive: true,
      }).filter((entry) => String(entry).endsWith(".json"));
      expect(ledgerEntries).toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("stores an encrypted exact-input capsule before web dispatch and retains it for an indeterminate run", async () => {
    const testState = state();
    try {
      installManifest(xWebManifest(), { force: false, environment: testState.environment });
      const selectedAuth = createAuth("x-web-test", {
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      });
      saveAuth(selectedAuth, testState.environment);
      const input = { post_id: "2078889282404569267", saved: true };
      const invocation = prepareInvocation(
        "x-web",
        "content.save",
        input,
        selectedAuth.id,
        testState.environment,
      );
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      let observedRunId: string | null = null;
      let calls = 0;
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeWebSession: async (_manifest, _recipe, _input, _auth, options) => {
          calls += 1;
          const runFiles = readdirSync(join(testState.directory, "runs"));
          expect(runFiles).toHaveLength(1);
          observedRunId = (runFiles[0] as string).slice(0, -5);
          const recovered = readRecoveryCapsule(
            observedRunId,
            selectedAuth.id,
            sha256(canonicalJson(selectedAuth)),
            testState.environment,
          );
          expect(recovered).toMatchObject({
            runId: observedRunId,
            planDigest: stored.digest,
            operation: "content.save",
            risk: "R2",
            input,
            inputHash: sha256(canonicalJson(input)),
            contract: {
              transport: "web-session-api",
              site: "x",
              action: "content.save",
              version: 1,
            },
          });
          const raw = readFileSync(
            join(testState.directory, "recovery", "capsules", `${observedRunId}.json`),
            "utf8",
          );
          expect(raw).not.toContain(input.post_id);
          await options?.beforeDispatch?.({
            id: "content.save",
            index: 1,
            progress: { planned: 1, started: 0, verified: 0 },
          });
          return {
            status: "indeterminate",
            output: null,
            finalUrl: "https://x.com/i/status/2078889282404569267",
            dispatchStarted: true,
            dispatch: { planned: 1, started: 1, verified: 0 },
            error: "synthetic post-dispatch response loss",
          };
        },
      });

      expect(result.receipt).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
      });
      expect(result.receipt.error).toContain("indeterminate after the dispatch boundary");
      expect<string | null>(observedRunId).toBe(result.receipt.runId);
      expect(readRecoveryCapsule(
        result.receipt.runId,
        selectedAuth.id,
        sha256(canonicalJson(selectedAuth)),
        testState.environment,
      )?.input).toEqual(input);

      const duplicate = createAndSaveInvocationPlan(invocation, testState.environment);
      expect(await rejectionMessage(confirmInvocation(duplicate.digest, {
        headed: false,
        environment: testState.environment,
        executeWebSession: () => {
          calls += 1;
          throw new Error("indeterminate writes must never retry");
        },
      }))).toContain("reconcile it before retrying");
      expect(calls).toBe(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps a cancelled post-dispatch web hook indeterminate and blocks late verification", async () => {
    const testState = state();
    try {
      installManifest(xWebManifest(), {
        force: false,
        environment: testState.environment,
      });
      const selectedAuth = createAuth("x-web-test", {
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      });
      saveAuth(selectedAuth, testState.environment);
      const invocation = prepareInvocation(
        "x-web",
        "content.save",
        { post_id: "2078889282404569267", saved: true },
        selectedAuth.id,
        testState.environment,
      );
      const stored = createAndSaveInvocationPlan(
        invocation,
        testState.environment,
      );
      const caller = new AbortController();
      let lateVerification:
        | ((event: {
            readonly id: string;
            readonly index: number;
            readonly progress: {
              readonly planned: number;
              readonly started: number;
              readonly verified: number;
            };
          }) => Promise<void>)
        | undefined;
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        signal: caller.signal,
        executeWebSession: async (
          _manifest,
          _recipe,
          _input,
          _auth,
          options,
        ) => {
          if (options.signal === caller.signal) {
            throw new Error("web executor received the caller signal directly");
          }
          lateVerification = options.afterDispatchVerified;
          await options.beforeDispatch?.({
            id: "content.save",
            index: 1,
            progress: { planned: 1, started: 0, verified: 0 },
          });
          caller.abort("private cancellation reason");
          return new Promise<never>(() => undefined);
        },
      });

      expect(result.receipt).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
      });
      const verify = lateVerification;
      if (verify === undefined) {
        throw new Error("web executor did not receive a verification callback");
      }
      const lateMessage = await rejectionMessage(verify({
        id: "content.save",
        index: 1,
        progress: { planned: 1, started: 1, verified: 1 },
      }));
      expect(lateMessage).toContain("was cancelled");
      expect(lateMessage).not.toContain("private cancellation reason");
      expect(readRunJournal(
        result.receipt.runId,
        testState.environment,
      )?.journal).toMatchObject({
        phase: "terminal",
        status: "indeterminate",
        dispatch: { planned: 1, started: 1, verified: 0 },
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("uses the terminal run journal as source of truth beyond the legacy receipt persistence seam", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const invocation = prepared(testState);
      const stored = createInvocationPlan(invocation);
      saveInvocationPlan(stored, testState.environment);
      let receiptWrites = 0;
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(),
        persistReceipt: (receipt, environment) => {
          receiptWrites += 1;
          if (receipt.status !== "pending") {
            throw new Error("legacy terminal receipt projection must not run");
          }
          writePrivateJson(join(environment.WRENCH_STATE_HOME as string, "runs", `${receipt.runId}.json`), receipt, { privateParent: true });
        },
      });
      expect(receiptWrites).toBe(1);
      expect(result.receipt).toMatchObject({
        status: "submitted",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      expect(readRunReceipt(result.receipt.runId, testState.environment))
        .toEqual(result.receipt);
      expect(readRunJournal(result.receipt.runId, testState.environment)?.journal)
        .toMatchObject({
          phase: "terminal",
          status: "submitted",
          ledgerState: "succeeded",
          recoveryState: "released",
          dispatch: { planned: 1, started: 1, verified: 1 },
        });
      expect(readRecoveryCapsule(
        result.receipt.runId,
        invocation.auth.id,
        sha256(canonicalJson(invocation.auth)),
        testState.environment,
      )).toBeNull();

      const retry = createInvocationPlan(invocation);
      saveInvocationPlan(retry, testState.environment);
      let retryCalls = 0;
      const replay = await confirmInvocation(retry.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          retryCalls += 1;
          return Promise.resolve(execution());
        },
      });
      expect(replay.replayed).toBeTrue();
      expect(replay.receipt).toEqual(result.receipt);
      expect(retryCalls).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("replays a completed identical action without a second dispatch and reads a legacy ledger", async () => {
    const testState = state();
    try {
      installFixture(testState);
      let calls = 0;
      const executor = providerExecutor(execution(), () => { calls += 1; });
      const firstPlan = createInvocationPlan(prepared(testState));
      saveInvocationPlan(firstPlan, testState.environment);
      const first = await confirmInvocation(firstPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: executor,
      });
      const idempotencyRoot = join(testState.directory, "idempotency");
      const bucketPrefix = readdirSync(idempotencyRoot)[0] as string;
      const ledgerName = readdirSync(join(idempotencyRoot, bucketPrefix))[0] as string;
      const ledgerPath = join(idempotencyRoot, bucketPrefix, ledgerName);
      const legacyLedger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, unknown>;
      legacyLedger.schemaVersion = 1;
      delete legacyLedger.dispatch;
      writeFileSync(ledgerPath, `${JSON.stringify(legacyLedger)}\n`, { mode: 0o600 });
      const secondPlan = createInvocationPlan(prepared(testState));
      saveInvocationPlan(secondPlan, testState.environment);
      const second = await confirmInvocation(secondPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: executor,
      });

      expect(first.replayed).toBeFalse();
      expect(second.replayed).toBeTrue();
      expect(second.receipt.runId).toBe(first.receipt.runId);
      expect(calls).toBe(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("allows retry after a known pre-dispatch failure", async () => {
    const testState = state();
    try {
      installFixture(testState);
      let calls = 0;
      const firstPlan = createInvocationPlan(prepared(testState));
      saveInvocationPlan(firstPlan, testState.environment);
      const first = await confirmInvocation(firstPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution("failed", false, "synthetic provider failure"));
        },
      });
      expect(first.receipt).toMatchObject({ status: "failed", dispatchStarted: false });
      expect(first.receipt.error).toBe(
        "official API operation failed before the dispatch boundary; reason: synthetic provider failure",
      );
      expect(readdirSync(join(testState.directory, "recovery", "capsules"))).toEqual([]);

      const secondPlan = createInvocationPlan(prepared(testState));
      saveInvocationPlan(secondPlan, testState.environment);
      const second = await confirmInvocation(secondPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(execution(), () => { calls += 1; }),
      });
      expect(second.receipt.status).toBe("submitted");
      expect(calls).toBe(2);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("blocks retry after an indeterminate post-dispatch failure", async () => {
    const testState = state();
    try {
      installFixture(testState);
      let calls = 0;
      const firstPlan = createInvocationPlan(prepared(testState));
      saveInvocationPlan(firstPlan, testState.environment);
      const first = await confirmInvocation(firstPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(
          execution("indeterminate", true, "synthetic provider failure"),
          () => { calls += 1; },
        ),
      });
      expect(first.receipt).toMatchObject({ status: "indeterminate", dispatchStarted: true });
      expect(first.receipt.error).toBe(
        "official API result is indeterminate after the dispatch boundary; reason: synthetic provider failure",
      );

      const secondPlan = createInvocationPlan(prepared(testState));
      saveInvocationPlan(secondPlan, testState.environment);
      expect(await rejectionMessage(confirmInvocation(secondPlan.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution());
        },
      }))).toContain("reconcile it before retrying");
      expect(calls).toBe(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("turns an unexpected pre-dispatch executor throw into a durable failed run", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState));
      saveInvocationPlan(stored, testState.environment);
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.reject(new Error("private unexpected diagnostic")),
      });
      expect(result.receipt).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
      });
      expect(result.receipt.error).toBe(
        "official API operation failed before the dispatch boundary; reason: provider executor terminated without returning a bounded result",
      );
      expect(JSON.stringify(readRunReceipt(result.receipt.runId, testState.environment))).not.toContain("private unexpected diagnostic");
      expect(readdirSync(join(testState.directory, "recovery", "capsules"))).toEqual([]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects executor-reported success that has no durable dispatch callbacks", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const invocation = prepared(testState, "unreported provider dispatch");
      const stored = createInvocationPlan(invocation);
      saveInvocationPlan(stored, testState.environment);
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve(execution()),
      });
      expect(result.receipt).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 1, started: 0, verified: 0 },
      });
      expect(result.receipt.error).toContain("invalid dispatch progress");
      expect(result.output).toBeNull();
      expect(readdirSync(join(testState.directory, "recovery", "capsules"))).toEqual([]);

      const retry = createAndSaveInvocationPlan(invocation, testState.environment);
      const retried = await confirmInvocation(retry.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(),
      });
      expect(retried.receipt.status).toBe("submitted");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("uses durable progress when a post-dispatch executor result is null or contradictory", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const candidates: readonly unknown[] = [
        null,
        {
          status: "failed",
          output: { private: "executor-private-contradictory-output" },
          finalUrl: null,
          dispatchStarted: false,
          dispatch: { planned: 1, started: 0, verified: 0 },
          error: "executor-private-contradictory-error",
        },
      ];
      for (const [index, candidate] of candidates.entries()) {
        const stored = createInvocationPlan(prepared(testState, `durable progress ${index}`));
        saveInvocationPlan(stored, testState.environment);
        const result = await confirmInvocation(stored.digest, {
          headed: false,
          environment: testState.environment,
          executeProvider: async (_manifest, _recipe, _input, _auth, executionOptions) => {
            if (executionOptions === undefined) {
              throw new Error("provider execution options are required");
            }
            await executionOptions.beforeDispatch?.({
              id: "posts-publish",
              index: 1,
              progress: { planned: 1, started: 0, verified: 0 },
            });
            return foreignProviderExecution(candidate);
          },
        });
        expect(result.receipt).toMatchObject({
          status: "indeterminate",
          dispatchStarted: true,
          dispatch: { planned: 1, started: 1, verified: 0 },
        });
        expect(result.output).toBeNull();
      }
      expect(allFileText(testState.directory)).not.toContain("executor-private");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects a stale progress callback without regressing a terminal receipt or journal", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createAndSaveInvocationPlan(
        prepared(testState, "stale progress regression"),
        testState.environment,
      );
      let staleProgress: (() => Promise<void>) | undefined;
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: async (_manifest, _recipe, _input, _auth, options) => {
          if (options === undefined) {
            throw new Error("provider execution options are required");
          }
          const starting = {
            id: "posts-publish",
            index: 1,
            progress: { planned: 1, started: 0, verified: 0 },
          } as const;
          await options.beforeDispatch?.(starting);
          await options.afterDispatchVerified?.({
            id: "posts-publish",
            index: 1,
            progress: { planned: 1, started: 1, verified: 1 },
          });
          staleProgress = () => {
            const callback = options.beforeDispatch;
            return callback === undefined
              ? Promise.reject(new Error("missing progress callback"))
              : callback(starting);
          };
          return {
            status: "succeeded",
            output: null,
            finalUrl: "https://api.x.com/2/tweets",
            dispatchStarted: true,
            dispatch: { planned: 1, started: 1, verified: 1 },
          };
        },
      });
      const receiptBefore = readFileSync(
        join(testState.directory, "runs", `${result.receipt.runId}.json`),
        "utf8",
      );
      if (staleProgress === undefined) {
        throw new Error("expected the executor to retain a stale callback");
      }

      expect(await rejectionMessage(staleProgress()))
        .toContain("dispatch progress diverged from the confirmed schedule");
      expect(readFileSync(
        join(testState.directory, "runs", `${result.receipt.runId}.json`),
        "utf8",
      )).toBe(receiptBefore);
      expect(readRunReceipt(result.receipt.runId, testState.environment))
        .toEqual(result.receipt);
      expect(readRunJournal(result.receipt.runId, testState.environment)?.journal)
        .toMatchObject({
          phase: "terminal",
          status: "submitted",
          dispatch: { planned: 1, started: 1, verified: 1 },
        });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("provider dispatch schedules and attachments", () => {
  test("preserves an old attachment bundle while its preview plan is active", () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wrench-upload-active-plan-source-"));
    const source = join(sourceDirectory, "reviewed.png");
    writeFileSync(source, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]), { mode: 0o600 });
    try {
      const invocation = preparedUpload(testState, source);
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      const bundle = planAssetBundlePath(stored.digest, testState.environment);
      const old = new Date(Date.now() - PLAN_ASSET_GC_GRACE_MS - 1_000);
      utimesSync(bundle, old, old);

      purgeExpiredPlans(testState.environment);

      expect(existsSync(bundle)).toBeTrue();
      expect(cancelInvocationPlan(stored.digest, testState.environment)).toBeTrue();
      expect(existsSync(bundle)).toBeFalse();
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("only one same-digest confirmer owns and cleans the attachment bundle", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wrench-upload-race-source-"));
    const source = join(sourceDirectory, "reviewed.png");
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    writeFileSync(source, png, { mode: 0o600 });
    const control: { release?: () => void } = {};
    try {
      const invocation = preparedUpload(testState, source);
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      const bundle = planAssetBundlePath(stored.digest, testState.environment);
      let entered = false;
      const gate = new Promise<void>((resolve) => { control.release = resolve; });
      const winner = confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: async (_manifest, _recipe, input, _auth, options) => {
          entered = true;
          await gate;
          const media = firstBoundFile(input.media);
          const paths = await options?.fileResolver?.([media]);
          expect(paths === undefined ? null : readFileSync(paths[0] as string)).toEqual(png);
          const result = execution("succeeded", true);
          await reportProviderExecutionProgress(result, options);
          return result;
        },
      });
      while (!entered) await new Promise((resolve) => setTimeout(resolve, 1));

      expect(await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve(execution()),
      }))).toContain("encrypted plan");
      expect(cancelInvocationPlan(stored.digest, testState.environment)).toBeFalse();
      const old = new Date(Date.now() - PLAN_ASSET_GC_GRACE_MS - 1_000);
      utimesSync(bundle, old, old);
      purgeExpiredPlans(testState.environment);
      expect(existsSync(bundle)).toBeTrue();

      control.release?.();
      expect((await winner).receipt.status).toBe("submitted");
      expect(existsSync(bundle)).toBeFalse();
    } finally {
      control.release?.();
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("binds an upload to a private plan bundle and removes it after verified dispatch", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wrench-upload-source-"));
    const source = join(sourceDirectory, "personal-file-name.png");
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    writeFileSync(source, png, { mode: 0o600 });
    try {
      const invocation = preparedUpload(testState, source);
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      expect(stored.plan.dispatches).toEqual([{ id: "posts-publish", description: "Execute x posts.publish" }]);
      expect(JSON.stringify(stored.plan.input)).not.toContain(source);
      expect(existsSync(planAssetBundlePath(stored.digest, testState.environment))).toBeTrue();

      const progress: Array<{ readonly planned: number; readonly started: number; readonly verified: number }> = [];
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        persistReceipt: (receipt, environment) => {
          progress.push(receipt.dispatch);
          writePrivateJson(join(environment.WRENCH_STATE_HOME as string, "runs", `${receipt.runId}.json`), receipt, { privateParent: true });
        },
        executeProvider: async (_manifest, _recipe, input, _auth, options) => {
          const media = firstBoundFile(input.media);
          await options?.beforeDispatch?.({
            id: "posts-publish",
            index: 1,
            progress: { planned: 1, started: 0, verified: 0 },
          });
          const paths = await options?.fileResolver?.([media]);
          expect(paths).toHaveLength(1);
          expect(paths?.[0]).toEndWith("asset-01.png");
          expect(paths === undefined ? null : readFileSync(paths[0] as string)).toEqual(png);
          await options?.afterDispatchVerified?.({
            id: "posts-publish",
            index: 1,
            progress: { planned: 1, started: 1, verified: 1 },
          });
          return {
            status: "succeeded",
            output: null,
            finalUrl: "https://api.x.com/2/tweets",
            dispatchStarted: true,
            dispatch: { planned: 1, started: 1, verified: 1 },
          };
        },
      });

      expect(result.receipt).toMatchObject({
        status: "submitted",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
      expect(progress).toEqual([
        { planned: 1, started: 0, verified: 0 },
      ]);
      expect(readRunReceipt(result.receipt.runId, testState.environment))
        .toEqual(result.receipt);
      expect(readRunJournal(result.receipt.runId, testState.environment)?.journal)
        .toMatchObject({
          phase: "terminal",
          status: "submitted",
          dispatch: { planned: 1, started: 1, verified: 1 },
        });
      expect(existsSync(planAssetBundlePath(stored.digest, testState.environment))).toBeFalse();
      expect(allFileText(testState.directory)).not.toContain(source);
      expect(allFileText(testState.directory)).not.toContain("personal-file-name");
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test.each([
    {
      status: "pending" as const,
      dispatch: { planned: 1, started: 1, verified: 0 },
    },
    {
      status: "partial" as const,
      dispatch: { planned: 2, started: 1, verified: 1 },
    },
    {
      status: "indeterminate" as const,
      dispatch: { planned: 1, started: 1, verified: 0 },
    },
  ])("retains a confirmed attachment bundle while its run is $status", async ({ status, dispatch }) => {
    const testState = state();
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wrench-unsettled-upload-source-"));
    const source = join(sourceDirectory, "reviewed.png");
    writeFileSync(source, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]), { mode: 0o600 });
    try {
      const invocation = preparedUpload(testState, source);
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      const bundle = planAssetBundlePath(stored.digest, testState.environment);
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: async (_manifest, _recipe, _input, _auth, options) => {
          await options?.beforeDispatch?.({
            id: "posts-publish",
            index: 1,
            progress: { planned: 1, started: 0, verified: 0 },
          });
          return {
            status: "indeterminate",
            output: null,
            finalUrl: "https://api.x.com/2/tweets",
            dispatchStarted: true,
            dispatch: { planned: 1, started: 1, verified: 0 },
            error: "synthetic response loss",
          };
        },
      });

      expect(result.receipt.status).toBe("indeterminate");
      expect(existsSync(bundle)).toBeTrue();
      const retainedReceipt = {
        ...result.receipt,
        status,
        dispatchStarted: dispatch.started > 0,
        dispatch,
      };
      writePrivateJson(
        join(testState.directory, "runs", `${result.receipt.runId}.json`),
        retainedReceipt,
        { privateParent: true },
      );
      const old = new Date(Date.now() - PLAN_ASSET_GC_GRACE_MS - 1_000);
      utimesSync(bundle, old, old);

      purgeExpiredPlans(testState.environment);

      expect(existsSync(bundle)).toBeTrue();
      expect(readRecoveryCapsule(
        result.receipt.runId,
        invocation.auth.id,
        sha256(canonicalJson(invocation.auth)),
        testState.environment,
      )?.planDigest).toBe(stored.digest);
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("removes a bound attachment bundle when preflight hash verification fails", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wrench-corrupt-upload-source-"));
    const source = join(sourceDirectory, "reviewed.png");
    writeFileSync(source, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]), { mode: 0o600 });
    try {
      const invocation = preparedUpload(testState, source);
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      const bundle = planAssetBundlePath(stored.digest, testState.environment);
      const fileName = readdirSync(bundle).find((name) => name.startsWith("asset-"));
      if (fileName === undefined) throw new Error("expected a staged attachment");
      writeFileSync(join(bundle, fileName), Buffer.alloc(16, 0xff), { mode: 0o600 });
      let browserCalls = 0;

      const message = await rejectionMessage(confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          browserCalls += 1;
          return Promise.resolve(execution());
        },
      }));

      expect(message).toContain("plan-bound attachment");
      expect(browserCalls).toBe(0);
      expect(existsSync(bundle)).toBeFalse();
      expect(listInvocationPlans(testState.environment)).toEqual([]);
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("records partial multi-dispatch progress and permanently blocks automatic retry", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const invocation = prepareInvocation(
        "x",
        "threads.publish",
        { items: ["first", "second"] },
        "x-official",
        testState.environment,
      );
      const first = createAndSaveInvocationPlan(invocation, testState.environment);
      expect(first.plan.dispatches.map(({ id }) => id)).toEqual(["publish-item[1]", "publish-item[2]"]);
      const result = await confirmInvocation(first.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: async (_manifest, _recipe, _input, _auth, options) => {
          await options?.beforeDispatch?.({
            id: "publish-item[1]",
            index: 1,
            progress: { planned: 2, started: 0, verified: 0 },
          });
          await options?.afterDispatchVerified?.({
            id: "publish-item[1]",
            index: 1,
            progress: { planned: 2, started: 1, verified: 1 },
          });
          return {
            status: "partial",
            output: null,
            finalUrl: "https://api.x.com/2/tweets",
            dispatchStarted: true,
            dispatch: { planned: 2, started: 1, verified: 1 },
            error: "provider stopped after the first verified dispatch",
          };
        },
      });
      expect(result.receipt).toMatchObject({
        status: "partial",
        dispatch: { planned: 2, started: 1, verified: 1 },
      });
      expect(result.receipt.error).toContain("reconcile before retrying");
      expect(result.receipt.error).toContain("provider stopped after the first verified dispatch");

      const retry = createAndSaveInvocationPlan(invocation, testState.environment);
      let calls = 0;
      const message = await rejectionMessage(confirmInvocation(retry.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => {
          calls += 1;
          return Promise.resolve(execution());
        },
      }));
      expect(message).toContain(result.receipt.runId);
      expect(message).toContain("reconcile");
      expect(calls).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("reviewed authenticated-template plans and receipts", () => {
  test("rejects DELETE disguised as R1 during validation, planning, and execution", () => {
    const testState = state();
    try {
      const unsafe = reviewedTemplateManifest("R1", "DELETE");
      const forgedInvocation = {
        manifest: unsafe,
        operationId: "content.read",
        input: { target_id: "target-1" },
        auth: auth(),
      };
      expect(() => createInvocationPlan(forgedInvocation))
        .toThrow("contractVersion 2 with a current-account identity preflight");
      let executorCalls = 0;
      expect(executeReadInvocation(forgedInvocation, {
        headed: false,
        environment: testState.environment,
        executeReviewedTemplate: () => {
          executorCalls += 1;
          return Promise.reject(new Error("must not execute"));
        },
      })).rejects.toThrow("contractVersion 2 with a current-account identity preflight");
      expect(executorCalls).toBe(0);

      expect(() => installManifest(unsafe, { force: false, environment: testState.environment }))
        .toThrow("reviewed-template contractVersion 2 with a current-account identity preflight");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses a reviewed R3 template during installed-manifest validation", () => {
    const testState = state();
    try {
      expect(() => installManifest(
        reviewedTemplateManifest("R3"),
        { force: false, environment: testState.environment },
      )).toThrow("reviewed-template contractVersion 2 with a current-account identity preflight");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("refuses capture-required templates before planning", () => {
    const testState = state();
    try {
      const reviewed = reviewedTemplateManifest("R1");
      const captureOperation = reviewed.operations["content.read"];
      if (captureOperation === undefined || !("reviewedTemplate" in captureOperation)) throw new Error("missing fixture operation");
      const capture: WrenchManifest = {
        ...reviewed,
        operations: {
          "content.read": {
            description: captureOperation.description,
            risk: captureOperation.risk,
            sideEffect: captureOperation.sideEffect,
            idempotency: captureOperation.idempotency,
            dedupeWindowMs: captureOperation.dedupeWindowMs,
            input: captureOperation.input,
            reviewedTemplate: {
              state: "capture-required",
              contractVersion: 1,
              instructions: "Review exact request and response semantics first.",
            },
          },
        },
      };
      installManifest(capture, { force: false, environment: testState.environment });
      saveAuth(auth(), testState.environment);
      expect(() => prepareInvocation(
        "example-api",
        "content.read",
        { target_id: "target-1" },
        "example",
        testState.environment,
      )).toThrow("capture-required");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("official-provider plans and receipts", () => {
  test("rejects an R1 plugin dispatch schedule before calling its executor", () => {
    const testState = state();
    try {
      installXProviderFixture(testState);
      const invocation = preparedRead(testState);
      const withReadDispatch = (
        resolution: ReturnType<ProviderPluginRegistry["resolveOperationDefinition"]>,
      ) => resolution === undefined
        ? undefined
        : {
            ...resolution,
            operation: {
              ...resolution.operation,
              planDispatches: () => [{
                id: "forged-read-dispatch",
                description: "A read must never schedule this dispatch",
              }],
            },
          };
      const resolveOperationDefinition: ProviderPluginRegistry["resolveOperationDefinition"] = (
        transport,
        surfaceId,
        operation,
        contractVersion,
      ) => {
        const resolution = providerPluginRegistry.resolveOperationDefinition(
          transport,
          surfaceId,
          operation,
          contractVersion,
        );
        return transport === "provider-api" && surfaceId === "x" && operation === "posts.read"
          ? withReadDispatch(resolution)
          : resolution;
      };
      const registry: ProviderPluginRegistry = {
        ...providerPluginRegistry,
        resolveOperationDefinition,
        requireOperationDefinition: (transport, surfaceId, operation, contractVersion) => {
          const resolution = resolveOperationDefinition(transport, surfaceId, operation, contractVersion);
          if (resolution === undefined) {
            return providerPluginRegistry.requireOperationDefinition(
              transport,
              surfaceId,
              operation,
              contractVersion,
            );
          }
          return resolution;
        },
      };
      let executorCalls = 0;
      expect(executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        registry,
        executeProvider: () => {
          executorCalls += 1;
          return Promise.resolve(providerReadExecution({ secret: "must-not-run" }));
        },
      })).rejects.toThrow("R1 operations must not schedule remote dispatches");
      expect(executorCalls).toBe(0);
      expect(existsSync(join(testState.directory, "runs"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed on null, invalid-status, and malformed executor records without retaining them", async () => {
    const testState = state();
    try {
      installXProviderFixture(testState);
      const invocation = preparedRead(testState);
      const valid = providerReadExecution({ private: "executor-private-output" });
      const malformed: readonly unknown[] = [
        null,
        { ...valid, status: "pending", error: "executor-private-status" },
        { ...valid, finalUrl: "not-an-absolute-url" },
        { ...valid, dispatchStarted: "yes" },
        { ...valid, dispatch: { planned: 0, started: 1, verified: 0 } },
        { ...valid, noOp: true },
        { ...valid, privateArtifactsPreserved: true },
        { ...valid, recoveryHandle: "session=executor-private-recovery" },
        { ...valid, error: 42 },
      ];
      for (const candidate of malformed) {
        const result = await executeReadInvocation(invocation, {
          headed: false,
          environment: testState.environment,
          executeProvider: () => Promise.resolve(foreignProviderExecution(candidate)),
        });
        expect(result.receipt).toMatchObject({
          status: "failed",
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
        });
        expect(result.receipt.error).toContain("terminated without returning a bounded result");
        expect(result.output).toBeNull();
      }
      expect(allFileText(testState.directory)).not.toContain("executor-private");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects non-JSON, circular, and oversized executor output", async () => {
    const testState = state();
    try {
      installXProviderFixture(testState);
      const invocation = preparedRead(testState);
      const operation = invocation.manifest.operations[invocation.operationId];
      if (operation === undefined || !("provider" in operation) || operation.provider === undefined) {
        throw new Error("expected provider read operation");
      }
      const circular: Record<string, unknown> = { private: "executor-private-circular" };
      circular.self = circular;
      for (const output of [
        { private: "executor-private-undefined", invalid: undefined },
        circular,
        "x".repeat(operation.provider.maxOutputBytes),
      ]) {
        const result = await executeReadInvocation(invocation, {
          headed: false,
          environment: testState.environment,
          executeProvider: () => Promise.resolve(providerReadExecution(output)),
        });
        expect(result.receipt).toMatchObject({
          status: "failed",
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
        });
        expect(result.output).toBeNull();
      }
      expect(allFileText(testState.directory)).not.toContain("executor-private");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("sanitizes and returns valid bounded JSON executor output", async () => {
    const testState = state();
    try {
      installXProviderFixture(testState);
      const output = {
        posts: [{ id: "123", text: "bounded result", metrics: { likes: 3 } }],
        cursor: null,
      };
      const result = await executeReadInvocation(preparedRead(testState), {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve({
          ...providerReadExecution(output),
          finalUrl: "https://x.com/example/status/123",
        }),
      });
      expect(result.receipt).toMatchObject({
        status: "succeeded",
        finalOrigin: "https://x.com",
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      expect(result.output).toEqual(output);
      expect(result.output).not.toBe(output);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("turns a thrown R1 executor into a pre-dispatch failure without retaining the exception", async () => {
    const testState = state();
    try {
      installXProviderFixture(testState);
      const result = await executeReadInvocation(preparedRead(testState), {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.reject(new Error("executor-private-thrown-value")),
      });
      expect(result.receipt).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      expect(result.output).toBeNull();
      expect(allFileText(testState.directory)).not.toContain("executor-private-thrown-value");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("executes an R1 provider read with a schema-v3 contract-bound receipt", async () => {
    const testState = state();
    try {
      installXProviderFixture(testState);
      const invocation = prepareInvocation(
        "x",
        "posts.read",
        { post_ids: ["123"] },
        "x-official",
        testState.environment,
      );
      const result = await executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve({
          status: "succeeded",
          output: { posts: [{ id: "123", text: "bounded result" }] },
          finalUrl: null,
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
        } satisfies ProviderExecution),
      });

      expect(result.receipt).toMatchObject({
        schemaVersion: 3,
        transport: "provider-api",
        operation: "posts.read",
        status: "succeeded",
        auth: { id: "x-official", kind: "oauth-token-file" },
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      if (result.receipt.schemaVersion !== 3) throw new Error("expected provider receipt");
      expect(result.receipt.providerContractHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.output).toEqual({ posts: [{ id: "123", text: "bounded result" }] });
      expect(readRunReceipt(result.receipt.runId, testState.environment)).toEqual(result.receipt);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("binds every confirmed thread dispatch and stores durable provider progress", async () => {
    const testState = state();
    const privateItems = ["first private thread item", "second private thread item"] as const;
    try {
      installXProviderFixture(testState);
      const invocation = prepareInvocation(
        "x",
        "threads.publish",
        { items: privateItems },
        "x-official",
        testState.environment,
      );
      const stored = createAndSaveInvocationPlan(invocation, testState.environment);
      expect(stored.plan).toMatchObject({
        schemaVersion: 3,
        transport: "provider-api",
        providerContract: { provider: "x", action: "threads.publish", version: 1 },
        dispatches: [{ id: "publish-item[1]" }, { id: "publish-item[2]" }],
      });
      expect(loadInvocationPlan(stored.digest, testState.environment)).toEqual(stored);

      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: async (_manifest, _recipe, _input, _auth, options) => {
          await options?.beforeDispatch?.({
            id: "publish-item[1]",
            index: 1,
            progress: { planned: 2, started: 0, verified: 0 },
          });
          await options?.afterDispatchVerified?.({
            id: "publish-item[1]",
            index: 1,
            progress: { planned: 2, started: 1, verified: 1 },
          });
          await options?.beforeDispatch?.({
            id: "publish-item[2]",
            index: 2,
            progress: { planned: 2, started: 1, verified: 1 },
          });
          await options?.afterDispatchVerified?.({
            id: "publish-item[2]",
            index: 2,
            progress: { planned: 2, started: 2, verified: 2 },
          });
          return {
            status: "succeeded",
            output: { posts: [{ id: "111" }, { id: "222" }] },
            finalUrl: "https://x.com/example/status/222",
            dispatchStarted: true,
            dispatch: { planned: 2, started: 2, verified: 2 },
          } satisfies ProviderExecution;
        },
      });

      expect(result.receipt).toMatchObject({
        schemaVersion: 3,
        transport: "provider-api",
        status: "submitted",
        dispatchStarted: true,
        dispatch: { planned: 2, started: 2, verified: 2 },
        finalOrigin: "https://x.com",
      });
      expect(allFileText(testState.directory)).not.toContain(privateItems[0]);
      expect(allFileText(testState.directory)).not.toContain(privateItems[1]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("receipts", () => {
  test("normalizes a legacy receipt without weakening its outcome", async () => {
    const testState = state();
    try {
      installFixture(testState);
      const stored = createInvocationPlan(prepared(testState));
      saveInvocationPlan(stored, testState.environment);
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: testState.environment,
        executeProvider: providerExecutor(),
      });
      const path = join(testState.directory, "runs", `${result.receipt.runId}.json`);
      const legacy = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      legacy.schemaVersion = 1;
      delete legacy.dispatch;
      legacy.transport = "browser";
      delete legacy.providerContractHash;
      writeFileSync(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

      expect(readRunReceipt(result.receipt.runId, testState.environment)).toMatchObject({
        schemaVersion: 2,
        status: "submitted",
        dispatch: { planned: 1, started: 1, verified: 1 },
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("lists durable runs newest-first and marks malformed records without echoing them", async () => {
    const testState = state();
    try {
      installFixture(testState, "R1");
      const result = await executeReadInvocation(preparedRead(testState), {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve(execution("succeeded", false, undefined, 0)),
      });
      const invalidId = crypto.randomUUID();
      writeFileSync(join(testState.directory, "runs", `${invalidId}.json`), "private malformed value\n", { mode: 0o600 });
      const listed = listRunReceipts(testState.environment);
      expect(listed.some((receipt) => receipt.runId === result.receipt.runId && "status" in receipt && receipt.status === "succeeded")).toBeTrue();
      expect(listed.some((receipt) => receipt.runId === invalidId && "invalid" in receipt && receipt.invalid)).toBeTrue();
      expect(JSON.stringify(listed)).not.toContain("private malformed value");
      expect(existsSync(join(testState.directory, "recovery"))).toBeFalse();
      expect(existsSync(join(testState.directory, ".recovery-encryption-key"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("lists 127 durable receipts in under one second", () => {
    const testState = state();
    try {
      const directory = join(wrenchStateHome(testState.environment), "runs");
      ensurePrivateStateDirectory(directory, testState.environment);
      for (let index = 0; index < 127; index += 1) {
        const runId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const startedAt = new Date(
          Date.UTC(2026, 6, 25, 12, 0, 0, index),
        ).toISOString();
        writeFileSync(join(directory, `${runId}.json`), `${JSON.stringify({
          schemaVersion: 2,
          runId,
          planDigest: null,
          adapter: {
            id: "example",
            version: "1.0.0",
            hash: "a".repeat(64),
          },
          operation: "messaging.send",
          risk: "R1",
          inputHash: "b".repeat(64),
          auth: {
            id: "example",
            hash: "c".repeat(64),
            kind: "cookie-source",
          },
          transport: "browser",
          status: "succeeded",
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
          startedAt,
          finishedAt: startedAt,
          finalOrigin: null,
          error: null,
        })}\n`, { mode: 0o600 });
      }

      const started = performance.now();
      const listed = listRunReceipts(testState.environment);
      const elapsedMilliseconds = performance.now() - started;

      expect(listed).toHaveLength(127);
      expect(listed.every((receipt) => "status" in receipt)).toBeTrue();
      expect(elapsedMilliseconds).toBeLessThan(1_000);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("records read outcomes without retaining browser errors or off-origin URLs", async () => {
    const testState = state();
    try {
      installFixture(testState, "R1");
      const result = await executeReadInvocation(preparedRead(testState), {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve({
          status: "failed",
          output: null,
          finalUrl: "https://evil.example/private-message-value",
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
          error: "request failed with Authorization: Bearer private-message-value",
        }),
      });
      expect(result.receipt).toMatchObject({ status: "failed", finalOrigin: null, dispatchStarted: false });
      expect(JSON.stringify(readRunReceipt(result.receipt.runId, testState.environment))).not.toContain("private-message-value");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects browser-only recovery fields from an official-provider executor", async () => {
    const testState = state();
    try {
      installFixture(testState, "R1");
      const result = await executeReadInvocation(preparedRead(testState), {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve({
          status: "failed",
          output: null,
          finalUrl: null,
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
          error: "arbitrary private browser diagnostics",
          privateArtifactsPreserved: true,
          recoveryHandle: "session=wrench-safe;config=/tmp/config;socket=/tmp/socket;artifacts=/tmp/artifacts",
        }),
      });
      expect(result.receipt.error).toContain("terminated without returning a bounded result");
      expect(result.receipt.error).not.toContain("arbitrary private browser diagnostics");
      expect(result.receipt.error).not.toContain("wrench-safe");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("records an authenticated-web cleanup barrier failure with its bounded recovery handle", async () => {
    const testState = state();
    try {
      const selectedManifest = xWebManifest();
      const selectedAuth = createAuth("x-web-test", {
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      });
      installManifest(selectedManifest, {
        force: false,
        environment: testState.environment,
      });
      saveAuth(selectedAuth, testState.environment);
      const encodedLongPath = "c".repeat(1_400);
      const recoveryHandle =
        `v1;session=aW8teC0xMjM;config=${encodedLongPath};socket=${encodedLongPath};artifacts=${encodedLongPath}`;
      const invocation = {
        manifest: selectedManifest,
        operationId: "posts.read",
        input: { post_id: "2078889282404569267" },
        auth: selectedAuth,
      } as const;
      const unsafeWebExecution: NonNullable<
        Parameters<typeof executeReadInvocation>[1]["executeWebSession"]
      > = (_manifest, _recipe, _input, _auth, options) => {
        executorCalls += 1;
        options.registerCleanupBarrier?.(Promise.reject(
          new PreservedBrowserArtifactsError(
            "browser teardown could not be verified",
            recoveryHandle,
            new Error("synthetic cleanup failure"),
          ),
        ));
        return Promise.resolve({
          status: "failed" as const,
          output: null,
          finalUrl: null,
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
          error: "the bounded operation timed out",
        });
      };
      let executorCalls = 0;
      const result = await executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        executeWebSession: unsafeWebExecution,
      });

      expect(result).toMatchObject({
        privateArtifactsPreserved: true,
        recoveryHandle,
        receipt: {
          status: "failed",
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
        },
      });
      expect(result.receipt.error).toContain(
        "private browser artifacts were preserved; manual recovery is required",
      );
      expect(result.receipt.error).toContain(`recovery handle: ${recoveryHandle}`);
      expect(readRunReceipt(result.receipt.runId, testState.environment))
        .toEqual(result.receipt);

      expect(await rejectionMessage(executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        executeWebSession: unsafeWebExecution,
      }))).toContain("active or cleanup-unsafe state");
      expect(executorCalls).toBe(1);
      const [unsafeAdmission] =
        listWebSessionCleanupAdmissions(testState.environment);
      if (unsafeAdmission === undefined || "invalid" in unsafeAdmission) {
        throw new Error("cleanup-unsafe admission fixture is unavailable");
      }
      expect(unsafeAdmission.claim.containment.status).toBe("cleanup-unsafe");
      const persistenceAuth = createAuth("x-web-persistence-test", {
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      });
      const persistenceInvocation = {
        ...invocation,
        auth: persistenceAuth,
      };

      const persistenceFailure = await executeReadInvocation(
        persistenceInvocation,
        {
          headed: false,
          environment: testState.environment,
          executeWebSession: unsafeWebExecution,
          persistReceipt: (receipt, environment) => {
            if (receipt.status === "pending") {
              writePrivateJson(
                join(
                  environment.WRENCH_STATE_HOME as string,
                  "runs",
                  `${receipt.runId}.json`,
                ),
                receipt,
                { privateParent: true },
              );
              return;
            }
            throw new Error("synthetic receipt persistence failure");
          },
        },
      );
      expect(persistenceFailure).toMatchObject({
        privateArtifactsPreserved: true,
        recoveryHandle,
        receipt: { status: "failed" },
      });
      expect(persistenceFailure.receipt.error).toContain(
        "final receipt could not be stored",
      );
      expect(persistenceFailure.receipt.error).toContain(
        `recovery handle: ${recoveryHandle}`,
      );
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("normalizes raw cleanup rejection without fabricating dispatch", async () => {
    const testState = state();
    try {
      const selectedManifest = xWebManifest();
      const selectedAuth = createAuth("x-web-test", {
        source: "arc",
        profile: "Profile 1",
        subject: "123",
      });
      installManifest(selectedManifest, {
        force: false,
        environment: testState.environment,
      });
      saveAuth(selectedAuth, testState.environment);
      const invocation = {
        manifest: selectedManifest,
        operationId: "posts.read",
        input: { post_id: "2078889282404569267" },
        auth: selectedAuth,
      } as const;

      const result = await executeReadInvocation(invocation, {
        headed: false,
        environment: testState.environment,
        executeWebSession: (_manifest, _recipe, _input, _auth, options) => {
          options.registerCleanupBarrier?.(Promise.reject(
            new Error("private raw cleanup rejection"),
          ));
          return Promise.resolve({
            status: "failed",
            output: null,
            finalUrl: null,
            dispatchStarted: false,
            dispatch: { planned: 0, started: 0, verified: 0 },
            error: "private provider cleanup detail",
          });
        },
      });

      expect(result).toMatchObject({
        privateArtifactsPreserved: false,
        receipt: {
          status: "failed",
          dispatchStarted: false,
          dispatch: { planned: 0, started: 0, verified: 0 },
        },
      });
      expect(result.receipt.error).toContain(
        "durable cleanup admission blocks retry",
      );
      expect(result.receipt.error).not.toContain(
        "private provider cleanup detail",
      );
      expect(result.receipt.error).not.toContain(
        "private raw cleanup rejection",
      );
      expect(listWebSessionCleanupAdmissions(testState.environment))
        .toMatchObject([{
          claim: { containment: { status: "cleanup-unsafe" } },
        }]);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects nested extensions and malformed nested identities or hashes", async () => {
    const testState = state();
    try {
      installFixture(testState, "R1");
      const result = await executeReadInvocation(preparedRead(testState), {
        headed: false,
        environment: testState.environment,
        executeProvider: () => Promise.resolve(execution("succeeded", false, undefined, 0)),
      });
      const path = join(testState.directory, "runs", `${result.receipt.runId}.json`);
      const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const adapter = original.adapter as Record<string, unknown>;
      const authRecord = original.auth as Record<string, unknown>;

      const corruptions: readonly Record<string, unknown>[] = [
        { ...original, adapter: { ...adapter, secret: "unexpected" } },
        { ...original, auth: { ...authRecord, token: "unexpected" } },
        { ...original, adapter: { ...adapter, id: "../escape" } },
        { ...original, adapter: { ...adapter, hash: "not-a-hash" } },
        { ...original, auth: { ...authRecord, id: "../escape" } },
        { ...original, auth: { ...authRecord, hash: "not-a-hash" } },
      ];
      for (const corruption of corruptions) {
        writeFileSync(path, `${JSON.stringify(corruption)}\n`, { mode: 0o600 });
        expect(() => readRunReceipt(result.receipt.runId, testState.environment)).toThrow("run receipt is malformed");
      }
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
