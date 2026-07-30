import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import type { StrictCookie } from "@hraness/kb/clip/cookies";
import { assertAsyncProperty, fc } from "./test-support";
import { loadAuth, saveAuth, type WrenchAuth } from "./auth";
import { main } from "./wrench";
import {
  canonicalJson,
  type WrenchManifest,
  type OperationInput,
  type WebSessionRecipe,
} from "./model";
import type { OperationDeadlineClock } from "./operation-deadline";
import { getProviderContract } from "./provider-contracts";
import { ProviderHttpClient } from "./provider-http";
import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import type {
  PortableProviderPluginHostInvocation,
  PortableProviderPluginHostResult,
} from "./provider-plugin-host";
import { runPortableProviderPluginHost } from "./provider-plugin-host";
import {
  renderPortableProviderPluginManifest,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginBindingV1,
  type PortableProviderPluginManifestV1,
} from "./provider-plugin-package";
import {
  createPortableProviderPluginCatalog,
} from "./provider-plugin-portable-catalog";
import type {
  PortableProviderRuntimeDependencies,
} from "./provider-plugin-portable-runtime";
import {
  registerPortableProviderPluginCleanupBarrier,
  settlePortableProviderPluginCleanup,
} from "./provider-plugin-cleanup-barrier";
import {
  disablePortableProviderPlugin,
  installPortableProviderPlugin,
} from "./provider-plugin-lifecycle";
import {
  readPortableRunResolution,
  reconcilePortableProviderPluginRun,
} from "./portable-run-recovery";
import {
  assertPortableProviderPluginActivatable,
  assertPortableProviderPluginQuiescent,
  inspectPortableProviderPluginQuiescence,
} from "./provider-plugin-lifecycle-kernel";
import {
  acquirePortableProviderPluginInvocationLease,
  createPortableProviderPluginInvocationLeaseContainmentController,
  listPortableProviderPluginInvocationLeases,
} from "./provider-plugin-invocation-lease";
import { createProviderPluginRegistry } from "./provider-plugin-registry";
import { installPortableProviderPluginPackage } from "./provider-plugin-store";
import { readRecoveryCapsule } from "./recovery";
import type { ProviderActionContext } from "./provider";
import {
  createInvocationPlan,
  cancelInvocationPlan,
  confirmInvocation,
  createAndSaveInvocationPlan,
  executeReadInvocation,
  loadInvocationPlan,
  saveInvocationPlan,
} from "./runtime";
import { runWebSessionOperationWithDeadline } from "./web-session";

setDefaultTimeout(60_000);

// Successful portable-host fixtures include staging, process admission, and
// verified teardown. Keep their operation budget aligned with the focused host
// suite so unrelated process-heavy checks cannot turn a success fixture into a
// deliberate cleanup-unsafe recovery case.
const REAL_HOST_FIXTURE_TIMEOUT_MS = 15_000;

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

  pendingTimers(): number {
    return this.#scheduled.size;
  }
}

const childRuntime = `
import { createInterface } from "node:readline";

let invocation = null;
let dispatchHandle = null;
let duplicateCode = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const capability = (requestId, request) => send({
  protocolVersion: 1,
  kind: "plugin.capability.request",
  invocationId: invocation.invocationId,
  requestId,
  request,
});
const result = (output, finalUrl = null) => send({
  protocolVersion: 1,
  kind: "plugin.result",
  invocationId: invocation.invocationId,
  output,
  finalUrl,
});
const readRequest = (requestId) => capability(requestId, {
  kind: "http.request",
  method: "GET",
  url: "https://web.portable.example/private/feed",
  headers: [],
  credentials: [{
    handle: requestId,
    sink: { kind: "cookie-jar" },
  }],
  body: { kind: "none" },
  redirect: "error",
  timeoutMs: 1000,
  maxOutputBytes: 4096,
});
const mutation = (requestId) => capability(requestId, {
  kind: "http.request",
  method: "POST",
  url: "https://web.portable.example/api/messages",
  headers: [],
  credentials: [],
  body: {
    kind: "utf8",
    mediaType: "application/json",
    text: "{\\"text\\":\\"hello\\"}",
  },
  redirect: "error",
  timeoutMs: 1000,
  maxOutputBytes: 4096,
  dispatchHandle,
});

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({
      protocolVersion: 1,
      kind: "plugin.ready",
      plugin: message.plugin,
    });
    continue;
  }
  if (message.kind === "host.invoke") {
    invocation = message;
    if (message.route.operation === "profiles.read") {
      result("portable-account");
    } else if (message.route.operation === "feeds.read") {
      capability("cookie-material", {
        kind: "session.acquire",
        name: "cookie-jar",
      });
    } else if (message.route.operation === "media.send") {
      capability("file-read", {
        kind: "file.read",
        handle: message.input.media,
        offset: 0,
        length: 4096,
      });
    } else if (message.route.operation === "messages.send") {
      capability("dispatch-begin", {
        kind: "dispatch.begin",
        dispatchId: "messages.send",
      });
    } else {
      result({ route: message.route.operation });
    }
    continue;
  }
  if (message.kind === "host.capability.error") {
    if (message.requestId === "cookie-http") {
      result({ cookieError: message.error.code });
    } else if (message.requestId === "direct-verify") {
      result({ directVerifyError: message.error.code });
    } else if (message.requestId === "duplicate-mutation") {
      duplicateCode = message.error.code;
      capability("duplicate-verify", {
        kind: "dispatch.verify",
        dispatchHandle,
        proof: { duplicateDenied: true },
      });
    } else {
      result({ unexpectedError: message.error.code });
    }
    continue;
  }
  if (message.kind !== "host.capability.result") continue;
  if (message.requestId === "cookie-material") {
    capability("cookie-http", {
      kind: "http.request",
      method: "GET",
      url: "https://web.portable.example/private/feed",
      headers: [],
      credentials: [{
        handle: message.result.materialHandle,
        sink: { kind: "cookie-jar" },
      }],
      body: { kind: "none" },
      redirect: "error",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    });
  } else if (message.requestId === "cookie-http") {
    result(
      { status: message.result.status },
      message.result.finalUrl,
    );
  } else if (message.requestId === "file-read") {
    result({
      bytes: Buffer.from(message.result.data, "base64").toString("utf8"),
      eof: message.result.eof,
    });
  } else if (message.requestId === "dispatch-begin") {
    dispatchHandle = message.result.dispatchHandle;
    if (invocation.input.mode === "direct-verify") {
      capability("direct-verify", {
        kind: "dispatch.verify",
        dispatchHandle,
        proof: { skippedMutation: true },
      });
    } else {
      mutation("first-mutation");
    }
  } else if (message.requestId === "first-mutation") {
    if (invocation.input.mode === "duplicate-mutation") {
      mutation("duplicate-mutation");
    } else {
      capability("normal-verify", {
        kind: "dispatch.verify",
        dispatchHandle,
        proof: { status: message.result.status },
      });
    }
  } else if (
    message.requestId === "normal-verify"
    || message.requestId === "duplicate-verify"
  ) {
    result({
      submitted: true,
      ...(duplicateCode === null ? {} : { duplicateCode }),
    }, "https://web.portable.example/messages/1");
  }
}
`.trimStart();

type PackageIdentity = {
  readonly id: string;
  readonly adapterId: string;
  readonly surfaceId: string;
  readonly origin: `https://${string}`;
};

const mainIdentity: PackageIdentity = {
  id: "portable-suite",
  adapterId: "portable-web",
  surfaceId: "portable-web",
  origin: "https://web.portable.example",
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readOperation(
  name: string,
  input: PortableProviderPluginBindingV1["operations"][number]["input"] = {
    properties: {},
    required: [],
  },
) {
  return {
    name,
    contractVersion: 1,
    timeoutMs: REAL_HOST_FIXTURE_TIMEOUT_MS,
    maxOutputBytes: 4_096,
    state: "observed" as const,
    risk: "R1" as const,
    dispatch: "none" as const,
    sideEffect: "none",
    idempotency: "none" as const,
    dedupeWindowMs: 0,
    input,
    implementation: `Reads ${name}.`,
  };
}

function webBinding(
  identity: PackageIdentity,
  full: boolean,
): PortableProviderPluginBindingV1 {
  const operations = full
    ? [
        readOperation("feeds.read"),
        {
          name: "media.send",
          contractVersion: 1,
          timeoutMs: REAL_HOST_FIXTURE_TIMEOUT_MS,
          maxOutputBytes: 4_096,
          state: "observed" as const,
          risk: "R3" as const,
          dispatch: "single" as const,
          sideEffect: "uploads one fixture",
          idempotency: "local-at-most-once" as const,
          dedupeWindowMs: 60_000,
          input: {
            properties: {
              media: {
                type: "file" as const,
                description: "One plan-bound fixture.",
                maxBytes: 4_096,
                mediaTypes: ["text/plain"],
              },
            },
            required: ["media"],
          },
          implementation: "Uploads one fixture.",
        },
        {
          name: "messages.send",
          contractVersion: 1,
          timeoutMs: REAL_HOST_FIXTURE_TIMEOUT_MS,
          maxOutputBytes: 4_096,
          state: "observed" as const,
          risk: "R3" as const,
          dispatch: "single" as const,
          sideEffect: "sends one message",
          idempotency: "local-at-most-once" as const,
          dedupeWindowMs: 60_000,
          input: {
            properties: {
              mode: {
                type: "string" as const,
                description: "Fixture dispatch behavior.",
                enum: [
                  "direct-verify",
                  "duplicate-mutation",
                  "normal",
                ],
              },
            },
            required: ["mode"],
          },
          implementation: "Sends one fixture message.",
        },
        readOperation("profiles.read"),
      ]
    : [readOperation("profiles.read")];
  return {
    transport: "web-session-api",
    adapterId: identity.adapterId,
    surfaceId: identity.surfaceId,
    origin: identity.origin,
    authKinds: ["cookies-file"],
    subject: {
      format: "portable bounded account token",
      kind: "opaque-token",
      probe: {
        operation: "profiles.read",
        contractVersion: 1,
      },
    },
    operations,
  };
}

function packageManifest(
  identity: PackageIdentity,
  full: boolean,
): PortableProviderPluginManifestV1 {
  const runtimeBytes = Buffer.from(childRuntime, "utf8");
  const bindings: PortableProviderPluginBindingV1[] = [];
  if (full) {
    bindings.push({
      transport: "provider-api",
      adapterId: "portable-provider",
      surfaceId: "portable-provider",
      origin: "https://api.portable.example",
      authKinds: ["oauth-token-file"],
      subject: {
        format: "portable provider account token",
        kind: "opaque-token",
        probe: null,
      },
      operations: [{
        ...readOperation("records.read"),
        requiredScopeSets: [["records.read"]],
        coverage: ["records"],
      }],
    });
  }
  bindings.push(webBinding(identity, full));
  return {
    schemaVersion: 1,
    hostApiVersion: 1,
    id: identity.id,
    version: "1.0.0",
    displayName: `Portable ${identity.id}`,
    runtime: {
      kind: "bun-js",
      entrypoint: "dist/plugin.mjs",
    },
    provenance: { kind: "local" },
    capabilities: {
      networkOrigins: full
        ? ["https://api.portable.example", identity.origin]
        : [identity.origin],
      planFiles: full ? "read" : "none",
      state: "namespaced",
      sessionMaterial: full
        ? ["cookie-jar", "oauth-access-token"]
        : [],
    },
    bindings,
    files: [{
      path: "dist/plugin.mjs",
      kind: "runtime",
      bytes: runtimeBytes.byteLength,
      sha256: sha256(runtimeBytes),
    }],
  };
}

function createPackage(
  parent: string,
  identity: PackageIdentity,
  full = false,
): string {
  const root = join(parent, identity.id);
  mkdirSync(join(root, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "dist", "plugin.mjs"), childRuntime, {
    mode: 0o600,
  });
  writeFileSync(
    join(root, "wrench-plugin.json"),
    renderPortableProviderPluginManifest(packageManifest(identity, full)),
    { mode: 0o600 },
  );
  return root;
}

function installPackage(
  packageRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const verified = verifyPortableProviderPluginPackageDirectory(packageRoot);
  installPortableProviderPluginPackage(packageRoot, {
    storeRoot: join(environment.WRENCH_STATE_HOME ?? "", "provider-plugins"),
    approval: {
      decision: "trust-executable-code",
      pluginId: verified.manifest.id,
      pluginVersion: verified.manifest.version,
      bundleSha256: verified.bundleSha256,
    },
    expectedCurrentBundleSha256: null,
    now: new Date("2026-07-25T12:00:00.000Z"),
    assertActivatable: () => undefined,
    assertCurrentQuiescent: () => undefined,
  });
}

function emptyRegistry() {
  return createProviderPluginRegistry([]);
}

function cookiesAuth(path: string): Extract<WrenchAuth, { readonly kind: "cookies-file" }> {
  return {
    schemaVersion: 1,
    id: "portable-cookies",
    kind: "cookies-file",
    path,
    subject: "portable-account",
  };
}

function webRecipe(
  manifest: WrenchManifest,
  operation: string,
): WebSessionRecipe {
  const recipe = manifest.operations[operation]?.webSession;
  if (recipe === undefined) throw new Error(`missing ${operation} web recipe`);
  return recipe;
}

function fileReference(bytes: Uint8Array): string {
  return [
    "sf1",
    "1",
    sha256(bytes),
    String(bytes.byteLength),
    Buffer.from("text/plain", "utf8").toString("base64url"),
    "asset-01.txt",
  ].join(":");
}

async function rejectionMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

function portableHostResult(
  invocation: PortableProviderPluginHostInvocation,
): PortableProviderPluginHostResult {
  return {
    output: { operation: invocation.route.operation },
    finalUrl: null,
    dispatch: {
      planned: invocation.plannedDispatchIds?.length ?? 0,
      started: 0,
      verified: 0,
    },
  };
}

let fixtureRoot = "";
let environment: Readonly<Record<string, string | undefined>>;
let cookiePath = "";
let mainPackageRoot = "";

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "wrench-portable-runtime-"));
  chmodSync(fixtureRoot, 0o700);
  environment = {
    WRENCH_STATE_HOME: join(fixtureRoot, "wrench-home"),
    HOME: fixtureRoot,
  };
  cookiePath = join(fixtureRoot, "cookies.json");
  writeFileSync(cookiePath, "[]", { mode: 0o600 });
  mainPackageRoot = createPackage(fixtureRoot, mainIdentity, true);
  installPackage(mainPackageRoot, environment);
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("portable provider runtime catalog", () => {
  test("binds and releases the real admission-gated host identity", async () => {
    const isolatedRoot = mkdtempSync(join(
      tmpdir(),
      "wrench-portable-real-host-",
    ));
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    const isolatedCookiePath = join(isolatedRoot, "cookies.json");
    try {
      writeFileSync(isolatedCookiePath, "[]", { mode: 0o600 });
      installPackage(
        createPackage(isolatedRoot, mainIdentity, true),
        isolatedEnvironment,
      );
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      if (manifest === undefined) {
        throw new Error("portable web manifest is unavailable");
      }
      const result = await executeReadInvocation({
        manifest,
        operationId: "profiles.read",
        input: {},
        auth: cookiesAuth(isolatedCookiePath),
      }, {
        headed: false,
        environment: isolatedEnvironment,
        registry: catalog.registry,
      });
      expect(result.receipt.status).toBe("succeeded");
      expect(result.output).toBe("portable-account");
      expect(listPortableProviderPluginInvocationLeases(isolatedEnvironment))
        .toEqual([]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("binds plans and receipts to one explicit immutable artifact identity", async () => {
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        runHost: (invocation) =>
          Promise.resolve(portableHostResult(invocation)),
      },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    if (manifest === undefined) {
      throw new Error("portable web manifest is unavailable");
    }
    const auth = cookiesAuth(cookiePath);
    const invocation = {
      manifest,
      operationId: "messages.send",
      input: { mode: "normal" },
      auth,
    } as const;
    const stored = createInvocationPlan(
      invocation,
      new Date("2026-07-25T12:00:00.000Z"),
      catalog.registry,
    );
    expect(stored.plan).toMatchObject({
      schemaVersion: 6,
      transport: "portable-provider-plugin",
      portablePluginContract: {
        pluginId: "portable-suite",
        pluginVersion: "1.0.0",
        adapterId: "portable-web",
        transport: "web-session-api",
        surfaceId: "portable-web",
        operation: "messages.send",
        contractVersion: 1,
      },
    });
    if (stored.plan.schemaVersion !== 6) {
      throw new Error("portable plan lost its artifact contract");
    }
    expect(stored.plan.portablePluginContract.bundleSha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.plan.portablePluginContract.manifestSha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.plan.portablePluginContract.descriptorSha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(stored.plan.portablePluginContract)).toBeTrue();

    saveInvocationPlan(stored, environment);
    expect(loadInvocationPlan(stored.digest, environment)).toEqual(stored);
    expect(cancelInvocationPlan(stored.digest, environment)).toBeTrue();

    const readResult = await executeReadInvocation({
      manifest,
      operationId: "feeds.read",
      input: {},
      auth,
    }, {
      headed: false,
      environment,
      registry: catalog.registry,
    });
    expect(readResult.receipt).toMatchObject({
      schemaVersion: 6,
      transport: "portable-provider-plugin",
      portablePluginContract: {
        pluginId: "portable-suite",
        adapterId: "portable-web",
        operation: "feeds.read",
      },
    });
    expect(listPortableProviderPluginInvocationLeases(environment)).toEqual([]);
  });

  test("publishes a live invocation lease before portable R1 execution", async () => {
    let startHost: (() => void) | undefined;
    const hostStarted = new Promise<void>((resolve) => {
      startHost = resolve;
    });
    let finishHost: (() => void) | undefined;
    const hostFinished = new Promise<void>((resolve) => {
      finishHost = resolve;
    });
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        runHost: async (invocation) => {
          startHost?.();
          await hostFinished;
          return portableHostResult(invocation);
        },
      },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    if (manifest === undefined) {
      throw new Error("portable web manifest is unavailable");
    }
    const resolution = catalog.registry.requireOperationDefinition(
      "web-session-api",
      "portable-web",
      "feeds.read",
      1,
    );
    if (resolution.portableIdentity === null) {
      throw new Error("portable operation identity is unavailable");
    }
    const execution = executeReadInvocation({
      manifest,
      operationId: "feeds.read",
      input: {},
      auth: cookiesAuth(cookiePath),
    }, {
      headed: false,
      environment,
      registry: catalog.registry,
    });
    await hostStarted;

    expect(listPortableProviderPluginInvocationLeases(environment))
      .toHaveLength(1);
    expect(inspectPortableProviderPluginQuiescence(
      resolution.portableIdentity.bundleSha256,
      environment,
    )).toMatchObject({
      quiescent: false,
      blockers: [{
        kind: "invocation-lease",
      }],
    });

    finishHost?.();
    await execution;
    expect(listPortableProviderPluginInvocationLeases(environment)).toEqual([]);
    expect(inspectPortableProviderPluginQuiescence(
      resolution.portableIdentity.bundleSha256,
      environment,
    ).quiescent).toBeTrue();
  });

  test("keeps web and provider leases non-quiescent through deadline-abandoned host cleanup", async () => {
    for (const transport of ["web-session-api", "provider-api"] as const) {
      const isolatedRoot = mkdtempSync(
        join(tmpdir(), `wrench-portable-${transport}-cleanup-`),
      );
      chmodSync(isolatedRoot, 0o700);
      const isolatedEnvironment = {
        WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
        HOME: isolatedRoot,
      };
      const packageRoot = createPackage(isolatedRoot, mainIdentity, true);
      installPackage(packageRoot, isolatedEnvironment);
      let hostStartedResolve: (() => void) | undefined;
      const hostStarted = new Promise<void>((resolve) => {
        hostStartedResolve = resolve;
      });
      let finishHostResolve: (() => void) | undefined;
      const finishHost = new Promise<void>((resolve) => {
        finishHostResolve = resolve;
      });
      let terminalizedResolve: (() => void) | undefined;
      const terminalized = new Promise<void>((resolve) => {
        terminalizedResolve = resolve;
      });
      let closes = 0;
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          createFetchScope: () => Object.freeze({
            fetch: () => Promise.resolve(new Response("{}")),
            close: () => {
              closes += 1;
            },
          }),
          runHost: async (invocation) => {
            hostStartedResolve?.();
            await finishHost;
            return portableHostResult(invocation);
          },
        },
      );
      const adapterId = transport === "web-session-api"
        ? "portable-web"
        : "portable-provider";
      const operation = transport === "web-session-api"
        ? "feeds.read"
        : "records.read";
      const manifest = catalog.registry.resolveOwnedManifest(adapterId);
      const installed = catalog.installed[0];
      if (manifest === undefined || installed === undefined) {
        throw new Error("portable cleanup fixture is unavailable");
      }
      const controller = new AbortController();
      const auth: WrenchAuth = transport === "web-session-api"
        ? cookiesAuth(join(isolatedRoot, "cookies.json"))
        : {
            schemaVersion: 1,
            id: "portable-oauth",
            kind: "oauth-token-file",
            provider: "portable-provider",
            path: join(isolatedRoot, "token.json"),
            scopes: ["records.read"],
            subject: "portable-account",
          };
      if (auth.kind === "oauth-token-file") {
        writeFileSync(auth.path, `${canonicalJson({
          schemaVersion: 1,
          provider: auth.provider,
          subject: auth.subject,
          scopes: auth.scopes,
          accessToken: "opaque-test-token",
          expiresAt: null,
        })}\n`, { mode: 0o600 });
      } else {
        writeFileSync(auth.path, "[]", { mode: 0o600 });
      }
      const execution = executeReadInvocation({
        manifest,
        operationId: operation,
        input: {},
        auth,
      }, {
        headed: false,
        environment: isolatedEnvironment,
        registry: catalog.registry,
        signal: controller.signal,
        persistReceipt: (receipt) => {
          if (receipt.status !== "pending") terminalizedResolve?.();
        },
      });
      try {
        await hostStarted;
        controller.abort();
        await terminalized;

        expect(closes).toBe(0);
        expect(listPortableProviderPluginInvocationLeases(
          isolatedEnvironment,
        )).toHaveLength(1);
        const assertQuiescent = (
          bundleSha256: string,
          artifactPath: string,
        ): void => {
          assertPortableProviderPluginQuiescent(
            bundleSha256,
            artifactPath,
            isolatedEnvironment,
          );
        };
        expect(() => disablePortableProviderPlugin("portable-suite", {
          expectedBundleSha256: installed.package.bundleSha256,
          assertQuiescent,
          environment: isolatedEnvironment,
        })).toThrow("invocation-lease");
        expect(() => installPortableProviderPlugin(packageRoot, {
          trustExecutableCode: true,
          expectedCurrentBundleSha256: installed.package.bundleSha256,
          assertActivatable: (candidate) =>
            assertPortableProviderPluginActivatable(
              candidate,
              emptyRegistry(),
              isolatedEnvironment,
            ),
          assertCurrentQuiescent: assertQuiescent,
          environment: isolatedEnvironment,
        })).toThrow("invocation-lease");

        finishHostResolve?.();
        const result = await execution;
        expect(result.receipt.status).toBe("failed");
        expect(closes).toBe(1);
        expect(listPortableProviderPluginInvocationLeases(
          isolatedEnvironment,
        )).toEqual([]);
      } finally {
        finishHostResolve?.();
        await execution.catch(() => undefined);
        rmSync(isolatedRoot, { recursive: true, force: true });
      }
    }
  });

  test("preserves the exact lease when host cleanup is explicitly unsafe", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-unsafe-cleanup-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    const packageRoot = createPackage(isolatedRoot, mainIdentity, true);
    installPackage(packageRoot, isolatedEnvironment);
    writeFileSync(join(isolatedRoot, "cookies.json"), "[]", { mode: 0o600 });
    try {
      let hosts = 0;
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          runHost: (invocation) => {
            hosts += 1;
            registerPortableProviderPluginCleanupBarrier().unsafe(
              new Error("simulated unverified process cleanup"),
            );
            return Promise.resolve(portableHostResult(invocation));
          },
        },
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      const installed = catalog.installed[0];
      if (manifest === undefined || installed === undefined) {
        throw new Error("portable unsafe-cleanup fixture is unavailable");
      }
      const message = await rejectionMessage(executeReadInvocation({
        manifest,
        operationId: "feeds.read",
        input: {},
        auth: cookiesAuth(join(isolatedRoot, "cookies.json")),
      }, {
        headed: false,
        environment: isolatedEnvironment,
        registry: catalog.registry,
      }));
      expect(message).toContain("invocation lease was preserved");
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toHaveLength(1);
      const retryMessage = await rejectionMessage(executeReadInvocation({
        manifest,
        operationId: "feeds.read",
        input: {},
        auth: cookiesAuth(join(isolatedRoot, "cookies.json")),
      }, {
        headed: false,
        environment: isolatedEnvironment,
        registry: catalog.registry,
      }));
      expect(retryMessage).toContain("blocked by cleanup-unsafe lease");
      expect(hosts).toBe(1);
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toHaveLength(1);
      expect(() => disablePortableProviderPlugin("portable-suite", {
        expectedBundleSha256: installed.package.bundleSha256,
        assertQuiescent: (bundleSha256, artifactPath) =>
          assertPortableProviderPluginQuiescent(
            bundleSha256,
            artifactPath,
            isolatedEnvironment,
          ),
        environment: isolatedEnvironment,
      })).toThrow("invocation-lease");
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("preserves the exact lease when partial web file binding cleanup is unverified", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-partial-file-cleanup-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    const packageRoot = createPackage(isolatedRoot, mainIdentity, true);
    installPackage(packageRoot, isolatedEnvironment);
    const sourcePath = join(isolatedRoot, "source.txt");
    const missingPath = join(isolatedRoot, "missing.txt");
    const bytes = Buffer.from("safe", "utf8");
    writeFileSync(sourcePath, bytes, { mode: 0o600 });
    try {
      let closes = 0;
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          closeBoundFile: (descriptor) => {
            closes += 1;
            closeSync(descriptor);
            throw new Error("simulated bound file close failure");
          },
          runHost: () => {
            throw new Error("portable host must not start after bind failure");
          },
        },
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      const binding = catalog.registry.requireSessionRoute("portable-web");
      const resolution = catalog.registry.requireOperationDefinition(
        "web-session-api",
        "portable-web",
        "media.send",
        1,
      );
      if (
        manifest === undefined
        || binding.transport === "provider-api"
        || resolution.portableIdentity === null
      ) {
        throw new Error("portable partial-file fixture is unavailable");
      }
      const reference = fileReference(bytes);
      const lease = acquirePortableProviderPluginInvocationLease(
        resolution.portableIdentity,
        randomUUID(),
        isolatedEnvironment,
      );
      const containment =
        createPortableProviderPluginInvocationLeaseContainmentController(
          lease,
          isolatedEnvironment,
        );
      const message = await rejectionMessage(
        settlePortableProviderPluginCleanup(
          () => binding.execute(
            manifest,
            webRecipe(manifest, "media.send"),
            {
              media: [
                { kind: "file", reference },
                { kind: "file", reference },
              ],
            },
            cookiesAuth(join(isolatedRoot, "cookies.json")),
            {
              environment: isolatedEnvironment,
              fileResolver: () =>
                Promise.resolve([sourcePath, missingPath]),
            },
          ),
          { containment },
        ),
      );
      expect(message).toContain("invocation lease was preserved");
      expect(closes).toBe(1);
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toMatchObject([{
        lease: {
          containment: {
            status: "cleanup-unsafe",
          },
        },
      }]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("preserves the exact lease when current-file descriptor transfer is uncertain", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-current-file-cleanup-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    const packageRoot = createPackage(isolatedRoot, mainIdentity, true);
    installPackage(packageRoot, isolatedEnvironment);
    const sourcePath = join(isolatedRoot, "source.txt");
    const bytes = Buffer.from("safe", "utf8");
    writeFileSync(sourcePath, bytes, { mode: 0o600 });
    try {
      let bindingCloses = 0;
      let boundCloses = 0;
      let hosts = 0;
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          closePlanFileBindingDescriptor: (descriptor) => {
            bindingCloses += 1;
            closeSync(descriptor);
            if (bindingCloses === 2) {
              throw new Error("simulated source descriptor close uncertainty");
            }
          },
          closeBoundFile: (descriptor) => {
            boundCloses += 1;
            closeSync(descriptor);
          },
          runHost: () => {
            hosts += 1;
            throw new Error("portable host must not start after bind failure");
          },
        },
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      const binding = catalog.registry.requireSessionRoute("portable-web");
      const resolution = catalog.registry.requireOperationDefinition(
        "web-session-api",
        "portable-web",
        "media.send",
        1,
      );
      if (
        manifest === undefined
        || binding.transport === "provider-api"
        || resolution.portableIdentity === null
      ) {
        throw new Error("portable current-file fixture is unavailable");
      }
      const lease = acquirePortableProviderPluginInvocationLease(
        resolution.portableIdentity,
        randomUUID(),
        isolatedEnvironment,
      );
      const containment =
        createPortableProviderPluginInvocationLeaseContainmentController(
          lease,
          isolatedEnvironment,
        );
      const message = await rejectionMessage(
        settlePortableProviderPluginCleanup(
          () => binding.execute(
            manifest,
            webRecipe(manifest, "media.send"),
            {
              media: {
                kind: "file",
                reference: fileReference(bytes),
              },
            },
            cookiesAuth(join(isolatedRoot, "cookies.json")),
            {
              environment: isolatedEnvironment,
              fileResolver: () => Promise.resolve([sourcePath]),
            },
          ),
          {
            containment,
            cleanupComplete: containment.cleanupComplete,
          },
        ),
      );
      expect(message).toContain("invocation lease was preserved");
      expect(bindingCloses).toBe(3);
      expect(boundCloses).toBe(0);
      expect(hosts).toBe(0);
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toMatchObject([{
        lease: {
          containment: {
            status: "cleanup-unsafe",
          },
        },
      }]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("leases an exact subject probe against concurrent update, disable, and cancellation", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-probe-lease-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    const packageRoot = createPackage(isolatedRoot, mainIdentity, true);
    installPackage(packageRoot, isolatedEnvironment);
    let hostStartedResolve: (() => void) | undefined;
    const hostStarted = new Promise<void>((resolve) => {
      hostStartedResolve = resolve;
    });
    let finishHostResolve: (() => void) | undefined;
    const finishHost = new Promise<void>((resolve) => {
      finishHostResolve = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    try {
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          runHost: async (invocation) => {
            observedSignal = invocation.signal;
            hostStartedResolve?.();
            await new Promise<void>((resolve, reject) => {
              const signal = invocation.signal;
              const abort = () => {
                const reason: unknown = signal?.reason;
                reject(
                  reason instanceof Error
                    ? reason
                    : new Error("portable probe cancelled"),
                );
              };
              if (signal?.aborted === true) {
                abort();
                return;
              }
              signal?.addEventListener("abort", abort, { once: true });
              void finishHost.then(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
              });
            });
            return {
              ...portableHostResult(invocation),
              output: "portable-account",
            };
          },
        },
      );
      const installed = catalog.installed[0];
      const binding = catalog.registry.requireSessionRoute("portable-web");
      if (installed === undefined || binding.subject.probe === undefined) {
        throw new Error("portable subject probe fixture is unavailable");
      }
      const controller = new AbortController();
      const probe = binding.subject.probe(
        cookiesAuth(join(isolatedRoot, "cookies.json")),
        { signal: controller.signal },
      );
      await hostStarted;
      expect(observedSignal).toBe(controller.signal);

      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toHaveLength(1);
      const assertQuiescent = (
        bundleSha256: string,
        artifactPath: string,
      ): void => {
        assertPortableProviderPluginQuiescent(
          bundleSha256,
          artifactPath,
          isolatedEnvironment,
        );
      };
      expect(() => disablePortableProviderPlugin("portable-suite", {
        expectedBundleSha256: installed.package.bundleSha256,
        assertQuiescent,
        environment: isolatedEnvironment,
      })).toThrow("invocation-lease");
      expect(() => installPortableProviderPlugin(packageRoot, {
        trustExecutableCode: true,
        expectedCurrentBundleSha256: installed.package.bundleSha256,
        assertActivatable: (candidate) =>
          assertPortableProviderPluginActivatable(
            candidate,
            emptyRegistry(),
            isolatedEnvironment,
          ),
        assertCurrentQuiescent: assertQuiescent,
        environment: isolatedEnvironment,
      })).toThrow("invocation-lease");

      controller.abort(new Error("portable probe cancelled"));
      expect(await rejectionMessage(probe))
        .toContain("portable probe cancelled");
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toEqual([]);
    } finally {
      finishHostResolve?.();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("preserves a subject-probe lease when cleanup cannot be verified", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-probe-unsafe-cleanup-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    const packageRoot = createPackage(isolatedRoot, mainIdentity, true);
    const authPath = join(isolatedRoot, "cookies.json");
    writeFileSync(authPath, "[]", { mode: 0o600 });
    installPackage(packageRoot, isolatedEnvironment);
    try {
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          runHost: (invocation) => {
            registerPortableProviderPluginCleanupBarrier().unsafe(
              new Error("simulated unverified probe cleanup"),
            );
            return Promise.resolve({
              ...portableHostResult(invocation),
              output: "portable-account",
            });
          },
        },
      );
      const binding = catalog.registry.requireSessionRoute("portable-web");
      if (binding.subject.probe === undefined) {
        throw new Error("portable subject probe fixture is unavailable");
      }
      const message = await rejectionMessage(
        binding.subject.probe(cookiesAuth(authPath)),
      );
      expect(message).toContain("invocation lease was preserved");
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toHaveLength(1);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("holds the exact probe lease through the auth subject CAS", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-auth-bind-lease-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    const packageRoot = createPackage(isolatedRoot, mainIdentity, true);
    const authPath = join(isolatedRoot, "cookies.json");
    writeFileSync(authPath, "[]", { mode: 0o600 });
    installPackage(packageRoot, isolatedEnvironment);
    const unboundAuth: WrenchAuth = {
      schemaVersion: 1,
      id: "portable-cookies",
      kind: "cookies-file",
      path: authPath,
    };
    saveAuth(unboundAuth, isolatedEnvironment);
    let commitReachedResolve: (() => void) | undefined;
    const commitReached = new Promise<void>((resolve) => {
      commitReachedResolve = resolve;
    });
    let allowCommitResolve: (() => void) | undefined;
    const allowCommit = new Promise<void>((resolve) => {
      allowCommitResolve = resolve;
    });
    try {
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          runHost: (invocation) => Promise.resolve({
            ...portableHostResult(invocation),
            output: "portable-account",
          }),
        },
      );
      const installed = catalog.installed[0];
      if (installed === undefined) {
        throw new Error("portable auth-bind fixture is unavailable");
      }
      let stdout = "";
      let stderr = "";
      const binding = main(
        ["auth", "bind", "portable-cookies", "--site", "portable-web"],
        isolatedEnvironment,
        {
          stdout: (value) => {
            stdout += value;
          },
          stderr: (value) => {
            stderr += value;
          },
        },
        {
          providerPluginRegistry: catalog.registry,
          beforeAuthBindCommit: async () => {
            commitReachedResolve?.();
            await allowCommit;
          },
        },
      );
      await commitReached;

      expect(loadAuth("portable-cookies", isolatedEnvironment).subject)
        .toBeUndefined();
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toHaveLength(1);
      const assertQuiescent = (
        bundleSha256: string,
        artifactPath: string,
      ): void => {
        assertPortableProviderPluginQuiescent(
          bundleSha256,
          artifactPath,
          isolatedEnvironment,
        );
      };
      expect(() => disablePortableProviderPlugin("portable-suite", {
        expectedBundleSha256: installed.package.bundleSha256,
        assertQuiescent,
        environment: isolatedEnvironment,
      })).toThrow("invocation-lease");
      expect(() => installPortableProviderPlugin(packageRoot, {
        trustExecutableCode: true,
        expectedCurrentBundleSha256: installed.package.bundleSha256,
        assertActivatable: (candidate) =>
          assertPortableProviderPluginActivatable(
            candidate,
            emptyRegistry(),
            isolatedEnvironment,
          ),
        assertCurrentQuiescent: assertQuiescent,
        environment: isolatedEnvironment,
      })).toThrow("invocation-lease");

      allowCommitResolve?.();
      expect(await binding).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("portable-account");
      expect(loadAuth("portable-cookies", isolatedEnvironment).subject)
        .toBe("portable-account");
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toEqual([]);
    } finally {
      allowCommitResolve?.();
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("refuses lifecycle mutation while an exact portable preview exists", () => {
    const sourceRegistry = emptyRegistry();
    const catalog = createPortableProviderPluginCatalog(
      sourceRegistry,
      environment,
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    if (manifest === undefined) {
      throw new Error("portable web manifest is unavailable");
    }
    const installed = catalog.installed[0];
    if (installed === undefined) {
      throw new Error("portable installation is unavailable");
    }
    const stored = createAndSaveInvocationPlan({
      manifest,
      operationId: "messages.send",
      input: { mode: "normal" },
      auth: cookiesAuth(cookiePath),
    }, environment, new Date(), catalog.registry);
    const assertQuiescent = (
      bundleSha256: string,
      artifactPath: string,
    ): void => {
      assertPortableProviderPluginQuiescent(
        bundleSha256,
        artifactPath,
        environment,
      );
    };
    expect(() => disablePortableProviderPlugin("portable-suite", {
      expectedBundleSha256: installed.package.bundleSha256,
      assertQuiescent,
      environment,
    })).toThrow("confirmation-plan");

    expect(cancelInvocationPlan(stored.digest, environment)).toBeTrue();
    expect(disablePortableProviderPlugin("portable-suite", {
      expectedBundleSha256: installed.package.bundleSha256,
      assertQuiescent,
      environment,
    }).activation).toBe("disabled");
    expect(installPortableProviderPlugin(mainPackageRoot, {
      trustExecutableCode: true,
      expectedCurrentBundleSha256: installed.package.bundleSha256,
      assertActivatable: (candidate) =>
        assertPortableProviderPluginActivatable(
          candidate,
          sourceRegistry,
          environment,
        ),
      assertCurrentQuiescent: assertQuiescent,
      environment,
    }).activation).toBe("enabled");
  });

  test("reconciles an indeterminate portable write from exact explicit evidence", async () => {
    const auth = cookiesAuth(cookiePath);
    saveAuth(auth, environment, { force: true });
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        runHost: async (invocation) => {
          if (invocation.capabilityHost === undefined) {
            throw new Error("portable capability host is unavailable");
          }
          const begun = await invocation.capabilityHost.handle(
            {
              kind: "dispatch.begin",
              dispatchId: "messages.send",
            },
            {
              invocationId: "portable-recovery-fixture",
              requestId: "dispatch-begin",
              route: invocation.route,
              signal: invocation.signal
                ?? new AbortController().signal,
            },
          );
          if (begun.kind !== "dispatch.begin") {
            throw new Error("portable dispatch did not begin");
          }
          return {
            output: null,
            finalUrl: null,
            dispatch: { planned: 1, started: 1, verified: 0 },
          };
        },
      },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    const installed = catalog.installed[0];
    if (manifest === undefined || installed === undefined) {
      throw new Error("portable write fixture is unavailable");
    }
    const confirmOnce = async () => {
      const stored = createAndSaveInvocationPlan({
        manifest,
        operationId: "messages.send",
        input: { mode: "normal" },
        auth,
      }, environment, new Date(), catalog.registry);
      return confirmInvocation(stored.digest, {
        headed: false,
        environment,
        registry: catalog.registry,
        loadManifest: () => ({ ok: true, value: manifest }),
      });
    };

    const first = await confirmOnce();
    expect(first.receipt.status).toBe("indeterminate");
    const notApplied = reconcilePortableProviderPluginRun(
      first.receipt.runId,
      { outcome: "not-applied", evidenceHash: "a".repeat(64) },
      { environment, registry: catalog.registry },
    );
    expect(notApplied).toMatchObject({
      ok: true,
      outcome: "not-applied",
      status: "safe-retry",
      recoveryArtifactsReleased: true,
    });
    expect(reconcilePortableProviderPluginRun(
      first.receipt.runId,
      { outcome: "not-applied", evidenceHash: "a".repeat(64) },
      { environment, registry: catalog.registry },
    )).toEqual(notApplied);
    expect(() => reconcilePortableProviderPluginRun(
      first.receipt.runId,
      { outcome: "applied", evidenceHash: "a".repeat(64) },
      { environment, registry: catalog.registry },
    )).toThrow("different evidence or outcome");
    expect(inspectPortableProviderPluginQuiescence(
      installed.package.bundleSha256,
      environment,
    ).quiescent).toBeTrue();

    // Not-applied evidence released the exact idempotency fence, so a fresh
    // confirmed attempt can cross dispatch. Applied evidence then settles the
    // bundle without authorizing another same-input retry.
    const second = await confirmOnce();
    expect(second.receipt.status).toBe("indeterminate");
    expect(reconcilePortableProviderPluginRun(
      second.receipt.runId,
      { outcome: "applied", evidenceHash: "b".repeat(64) },
      { environment, registry: catalog.registry },
    )).toMatchObject({
      outcome: "applied",
      status: "succeeded",
    });
    let retryError = "";
    try {
      await confirmOnce();
    } catch (error) {
      retryError = error instanceof Error ? error.message : String(error);
    }
    expect(retryError).toContain("prior attempt");
    expect(inspectPortableProviderPluginQuiescence(
      installed.package.bundleSha256,
      environment,
    ).quiescent).toBeTrue();
  });

  test("never reports recovery release when a schema-6 journal is missing", async () => {
    const isolatedRoot = mkdtempSync(join(fixtureRoot, "missing-journal-"));
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: isolatedRoot,
      HOME: fixtureRoot,
    };
    try {
      installPackage(mainPackageRoot, isolatedEnvironment);
      const auth = cookiesAuth(cookiePath);
      saveAuth(auth, isolatedEnvironment, { force: true });
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          runHost: async (invocation) => {
            if (invocation.capabilityHost === undefined) {
              throw new Error("portable capability host is unavailable");
            }
            const begun = await invocation.capabilityHost.handle(
              {
                kind: "dispatch.begin",
                dispatchId: "messages.send",
              },
              {
                invocationId: "portable-missing-journal-fixture",
                requestId: "dispatch-begin",
                route: invocation.route,
                signal: invocation.signal
                  ?? new AbortController().signal,
              },
            );
            if (begun.kind !== "dispatch.begin") {
              throw new Error("portable dispatch did not begin");
            }
            return {
              output: null,
              finalUrl: null,
              dispatch: { planned: 1, started: 1, verified: 0 },
            };
          },
        },
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      const installed = catalog.installed[0];
      if (manifest === undefined || installed === undefined) {
        throw new Error("portable missing-journal fixture is unavailable");
      }
      const stored = createAndSaveInvocationPlan({
        manifest,
        operationId: "messages.send",
        input: { mode: "normal" },
        auth,
      }, isolatedEnvironment, new Date(), catalog.registry);
      const result = await confirmInvocation(stored.digest, {
        headed: false,
        environment: isolatedEnvironment,
        registry: catalog.registry,
        loadManifest: () => ({ ok: true, value: manifest }),
      });
      expect(result.receipt.status).toBe("indeterminate");
      expect(readRecoveryCapsule(
        result.receipt.runId,
        result.receipt.auth.id,
        result.receipt.auth.hash,
        isolatedEnvironment,
      )).not.toBeNull();

      rmSync(
        join(
          isolatedRoot,
          "run-journals",
          `${result.receipt.runId}.json`,
        ),
      );
      expect(() => reconcilePortableProviderPluginRun(
        result.receipt.runId,
        { outcome: "not-applied", evidenceHash: "c".repeat(64) },
        { environment: isolatedEnvironment, registry: catalog.registry },
      )).toThrow("could not be fully released");
      expect(readPortableRunResolution(
        result.receipt.runId,
        isolatedEnvironment,
      )).not.toBeNull();
      expect(readRecoveryCapsule(
        result.receipt.runId,
        result.receipt.auth.id,
        result.receipt.auth.hash,
        isolatedEnvironment,
      )).not.toBeNull();
      expect(inspectPortableProviderPluginQuiescence(
        installed.package.bundleSha256,
        isolatedEnvironment,
      ).quiescent).toBeFalse();
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("projects enabled bindings and keeps preview static until explicit execution", async () => {
    const invocations: PortableProviderPluginHostInvocation[] = [];
    const runHost: PortableProviderRuntimeDependencies["runHost"] =
      (invocation) => {
        invocations.push(invocation);
        return Promise.resolve(portableHostResult(invocation));
      };
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      { runHost },
    );

    expect(catalog.installed.map((entry) => entry.active.pluginId)).toEqual([
      "portable-suite",
    ]);
    expect(catalog.registry.get("portable-suite")).toMatchObject({
      sourceKind: "portable",
      implementationSources: [],
    });
    expect(catalog.registry.listOwnedManifests().map((value) => value.id))
      .toEqual(["portable-provider", "portable-web"]);
    const webResolution = catalog.registry.requireOperationDefinition(
      "web-session-api",
      "portable-web",
      "messages.send",
      1,
    );
    const providerResolution = catalog.registry.requireOperationDefinition(
      "provider-api",
      "portable-provider",
      "records.read",
      1,
    );

    expect(webResolution.operation.planDispatches({ mode: "normal" }))
      .toEqual([{
        id: "messages.send",
        description: "sends one message",
      }]);
    expect(providerResolution.operation.planDispatches({})).toEqual([]);
    expect(invocations).toHaveLength(0);

    const webManifest = catalog.registry.resolveOwnedManifest("portable-web");
    if (
      webManifest === undefined
      || webResolution.binding.transport === "provider-api"
    ) throw new Error("portable web projection is unavailable");
    const webExecution = await webResolution.binding.execute(
      webManifest,
      webRecipe(webManifest, "feeds.read"),
      {},
      cookiesAuth(cookiePath),
      { environment },
    );
    expect(webExecution).toMatchObject({
      status: "succeeded",
      output: { operation: "feeds.read" },
    });

    const providerManifest =
      catalog.registry.resolveOwnedManifest("portable-provider");
    if (
      providerManifest === undefined
      || providerResolution.binding.transport !== "provider-api"
    ) throw new Error("portable provider projection is unavailable");
    const recipe = providerManifest.operations["records.read"]?.provider;
    if (recipe === undefined) throw new Error("provider recipe is unavailable");
    let output: unknown;
    const controller = new AbortController();
    const auth: Extract<WrenchAuth, { readonly kind: "oauth-token-file" }> = {
      schemaVersion: 1,
      id: "portable-oauth",
      kind: "oauth-token-file",
      provider: "portable-provider",
      path: join(fixtureRoot, "token.json"),
      scopes: ["records.read"],
      subject: "portable-account",
    };
    const context: ProviderActionContext = {
      manifest: providerManifest,
      recipe,
      contract: getProviderContract(recipe, catalog.registry),
      input: {},
      auth,
      token: { accessToken: "opaque-test-token", expiresAt: null },
      http: new ProviderHttpClient(
        () => Promise.resolve(new Response("{}")),
        3_000,
        4_096,
      ),
      environment,
      signal: controller.signal,
      remainingTimeMs: () => 777,
      resolveFiles: () => Promise.resolve([]),
      beginDispatch: () => Promise.reject(new Error("unexpected dispatch")),
      dispatch: <T>(action: () => Promise<T>) => {
        void action;
        return Promise.reject(new Error("unexpected dispatch"));
      },
      addRequiredScopes: () => undefined,
      setOutput: (value) => {
        output = value;
      },
      setFinalUrl: () => undefined,
    };
    await providerResolution.binding.execute(context);
    expect(output).toEqual({ operation: "records.read" });
    expect(invocations.map((value) => ({
      operation: value.route.operation,
      timeoutMs: value.timeoutMs,
      signal: value.signal,
    }))).toEqual([
      {
        operation: "feeds.read",
        timeoutMs: REAL_HOST_FIXTURE_TIMEOUT_MS,
        signal: undefined,
      },
      {
        operation: "records.read",
        timeoutMs: 777,
        signal: controller.signal,
      },
    ]);
  });

  test("rejects source-route and portable-adapter collisions deterministically", () => {
    const operation: WebSessionPluginOperationDefinitionV1 = {
      name: "profiles.read",
      contractVersion: 1,
      risk: "R1",
      input: { properties: {}, required: [] },
      sideEffect: "none",
      idempotency: "none",
      dedupeWindowMs: 0,
      state: "observed",
      dispatch: "none",
      implementation: "Inert source collision fixture.",
      planDispatches: () => [],
      validateInput: () => [],
    };
    const source = defineProviderPlugin({
      apiVersion: 1,
      id: "source-collision",
      version: "1.0.0",
      displayName: "Source collision",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
      }],
      bindings: [{
        transport: "web-session-api",
        surfaceId: "portable-web",
        origin: "https://source-collision.example",
        authKinds: ["cookies-file"],
        subject: {
          format: "source collision account",
          matches: (value) => value === "source-account",
        },
        operations: [operation],
        runtime: lazyWebSessionRuntime(() => Promise.resolve({
          probe: () => Promise.resolve("source-account"),
          execute: () => Promise.resolve({
            status: "failed",
            output: null,
            finalUrl: null,
            dispatchStarted: false,
            dispatch: { planned: 0, started: 0, verified: 0 },
            error: "inert",
          }),
        })),
      }],
    });
    expect(() =>
      createPortableProviderPluginCatalog(
        createProviderPluginRegistry([source]),
        environment,
      )).toThrow(
      "duplicate provider plugin route web-session-api:portable-web",
    );

    const collisionRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-runtime-collision-"),
    );
    chmodSync(collisionRoot, 0o700);
    try {
      const collisionEnvironment = {
        WRENCH_STATE_HOME: join(collisionRoot, "wrench-home"),
        HOME: collisionRoot,
      };
      installPackage(
        createPackage(collisionRoot, mainIdentity, true),
        collisionEnvironment,
      );
      installPackage(
        createPackage(collisionRoot, {
          id: "portable-second",
          adapterId: "portable-web",
          surfaceId: "portable-second",
          origin: "https://second.portable.example",
        }),
        collisionEnvironment,
      );
      expect(() =>
        createPortableProviderPluginCatalog(
          emptyRegistry(),
          collisionEnvironment,
        )).toThrow(
        "duplicate portable provider plugin adapter ID: portable-web",
      );
    } finally {
      rmSync(collisionRoot, { recursive: true, force: true });
    }
  });
});

describe("portable provider runtime capability containment", () => {
  test("times out a stalled plan-file resolver without creating a fetch scope or host", async () => {
    const clock = new FakeMonotonicClock();
    let resolverStartedResolve: (() => void) | undefined;
    const resolverStarted = new Promise<void>((resolve) => {
      resolverStartedResolve = resolve;
    });
    let fetchScopes = 0;
    let hosts = 0;
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        createFetchScope: () => {
          fetchScopes += 1;
          throw new Error("fetch scope must not be created");
        },
        runHost: () => {
          hosts += 1;
          throw new Error("portable host must not be started");
        },
      },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    const binding = catalog.registry.requireSessionRoute("portable-web");
    if (manifest === undefined || binding.transport === "provider-api") {
      throw new Error("portable web projection is unavailable");
    }
    const selectedRecipe = webRecipe(manifest, "media.send");
    const input: OperationInput = {
      media: {
        kind: "file",
        reference: fileReference(Buffer.from("safe", "utf8")),
      },
    };
    const execution = runWebSessionOperationWithDeadline(
      selectedRecipe,
      { deadlineClock: clock },
      (options) => binding.execute(
        manifest,
        selectedRecipe,
        input,
        cookiesAuth(cookiePath),
        {
          ...options,
          environment,
          fileResolver: () => {
            resolverStartedResolve?.();
            return new Promise<readonly string[]>(() => undefined);
          },
        },
      ),
    );

    await resolverStarted;
    clock.advance(selectedRecipe.timeoutMs);
    expect(await rejectionMessage(execution)).toContain("timed out");
    expect(fetchScopes).toBe(0);
    expect(hosts).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  test("retains and closes files bound across the deadline post-work check", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-file-deadline-transfer-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    installPackage(
      createPackage(isolatedRoot, mainIdentity, true),
      isolatedEnvironment,
    );
    const sourcePath = join(isolatedRoot, "source.txt");
    const bytes = Buffer.from("safe", "utf8");
    writeFileSync(sourcePath, bytes, { mode: 0o600 });
    const clock = new FakeMonotonicClock();
    let advanceMs = 0;
    let bindingCloses = 0;
    let boundCloses = 0;
    let fetchScopes = 0;
    let hosts = 0;
    try {
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          closePlanFileBindingDescriptor: (descriptor) => {
            bindingCloses += 1;
            closeSync(descriptor);
            if (bindingCloses === 1) clock.advance(advanceMs);
          },
          closeBoundFile: (descriptor) => {
            boundCloses += 1;
            closeSync(descriptor);
          },
          createFetchScope: () => {
            fetchScopes += 1;
            throw new Error("fetch scope must not be created after deadline");
          },
          runHost: () => {
            hosts += 1;
            throw new Error("portable host must not start after deadline");
          },
        },
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      const binding = catalog.registry.requireSessionRoute("portable-web");
      const resolution = catalog.registry.requireOperationDefinition(
        "web-session-api",
        "portable-web",
        "media.send",
        1,
      );
      if (
        manifest === undefined
        || binding.transport === "provider-api"
        || resolution.portableIdentity === null
      ) {
        throw new Error("portable file deadline fixture is unavailable");
      }
      const selectedRecipe = webRecipe(manifest, "media.send");
      advanceMs = selectedRecipe.timeoutMs;
      const lease = acquirePortableProviderPluginInvocationLease(
        resolution.portableIdentity,
        randomUUID(),
        isolatedEnvironment,
      );
      const containment =
        createPortableProviderPluginInvocationLeaseContainmentController(
          lease,
          isolatedEnvironment,
        );
      const outcome = await settlePortableProviderPluginCleanup(
        () => runWebSessionOperationWithDeadline(
          selectedRecipe,
          { deadlineClock: clock },
          (options) => binding.execute(
            manifest,
            selectedRecipe,
            {
              media: {
                kind: "file",
                reference: fileReference(bytes),
              },
            },
            cookiesAuth(join(isolatedRoot, "cookies.json")),
            {
              ...options,
              environment: isolatedEnvironment,
              fileResolver: () => Promise.resolve([sourcePath]),
            },
          ),
        ),
        {
          containment,
          cleanupComplete: containment.cleanupComplete,
        },
      );

      expect(outcome.status).toBe("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("portable deadline fixture unexpectedly succeeded");
      }
      if (!(outcome.reason instanceof Error)) {
        throw new Error("portable deadline failure was not an Error");
      }
      expect(outcome.reason.message).toContain("timed out");
      expect(bindingCloses).toBe(2);
      expect(boundCloses).toBe(1);
      expect(fetchScopes).toBe(0);
      expect(hosts).toBe(0);
      expect(containment.current.lease).toMatchObject({
        containment: {
          status: "cleanup-complete",
        },
      });
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("keeps a capability request timeout inside the larger operation deadline", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-fetch-timeout-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    installPackage(
      createPackage(isolatedRoot, mainIdentity, true),
      isolatedEnvironment,
    );
    writeFileSync(join(isolatedRoot, "cookies.json"), "[]", { mode: 0o600 });
    try {
      let fetchSignal: AbortSignal | undefined;
      let fetchTimeoutMs: number | undefined;
      let capabilityMessage: string | undefined;
      let capabilityElapsedMs: number | undefined;
      let closes = 0;
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          createFetchScope: () => Object.freeze({
            fetch: (_target, init, timeoutMs) => {
              fetchSignal = init?.signal ?? undefined;
              fetchTimeoutMs = timeoutMs;
              return new Promise<Response>(() => undefined);
            },
            close: () => {
              closes += 1;
            },
          }),
          runHost: async (invocation) => {
            const host = invocation.capabilityHost;
            if (host === undefined) {
              throw new Error("portable capability host is unavailable");
            }
            const capabilityStartedAt = performance.now();
            capabilityMessage = await rejectionMessage(host.handle(
              {
                kind: "http.request",
                method: "GET",
                url: "https://web.portable.example/private/feed",
                headers: [],
                credentials: [],
                body: { kind: "none" },
                redirect: "error",
                timeoutMs: 100,
                maxOutputBytes: 4_096,
              },
              {
                invocationId: "request-deadline-invocation",
                requestId: "request-deadline",
                route: invocation.route,
                signal: invocation.signal ?? new AbortController().signal,
              },
            ));
            capabilityElapsedMs = performance.now() - capabilityStartedAt;
            return portableHostResult(invocation);
          },
        },
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      if (manifest === undefined) {
        throw new Error("portable web projection is unavailable");
      }
      const message = await rejectionMessage(executeReadInvocation({
        manifest,
        operationId: "profiles.read",
        input: {},
        auth: cookiesAuth(join(isolatedRoot, "cookies.json")),
      }, {
        headed: false,
        environment: isolatedEnvironment,
        registry: catalog.registry,
      }));

      expect(message).toContain("invocation lease was preserved");
      expect(capabilityMessage).toContain("timed out");
      expect(capabilityElapsedMs).toBeLessThan(2_000);
      expect(fetchTimeoutMs).toBe(100);
      expect(fetchSignal?.aborted).toBeTrue();
      expect(closes).toBe(1);
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toMatchObject([{
        lease: {
          containment: {
            status: "cleanup-unsafe",
          },
        },
      }]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("includes cookie acquisition in the capability request timeout", async () => {
    const isolatedRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-cookie-timeout-"),
    );
    chmodSync(isolatedRoot, 0o700);
    const isolatedEnvironment = {
      WRENCH_STATE_HOME: join(isolatedRoot, "wrench-home"),
      HOME: isolatedRoot,
    };
    installPackage(
      createPackage(isolatedRoot, mainIdentity, true),
      isolatedEnvironment,
    );
    writeFileSync(join(isolatedRoot, "cookies.json"), "[]", { mode: 0o600 });
    try {
      let cookieTimeoutMs: number | undefined;
      let capabilityMessage: string | undefined;
      let capabilityElapsedMs: number | undefined;
      let fetches = 0;
      const catalog = createPortableProviderPluginCatalog(
        emptyRegistry(),
        isolatedEnvironment,
        {
          acquireCookies: (selection) => {
            cookieTimeoutMs = selection.timeoutMs;
            return new Promise(() => undefined);
          },
          createFetchScope: () => Object.freeze({
            fetch: () => {
              fetches += 1;
              return Promise.resolve(new Response("{}"));
            },
            close: () => undefined,
          }),
          runHost: async (invocation) => {
            const host = invocation.capabilityHost;
            if (host === undefined) {
              throw new Error("portable capability host is unavailable");
            }
            const context = {
              invocationId: "cookie-request-deadline-invocation",
              requestId: "cookie-material",
              route: invocation.route,
              signal: invocation.signal ?? new AbortController().signal,
            };
            const acquired = await host.handle(
              { kind: "session.acquire", name: "cookie-jar" },
              context,
            );
            if (acquired.kind !== "session.acquire") {
              throw new Error("portable cookie material was not acquired");
            }
            const capabilityStartedAt = performance.now();
            capabilityMessage = await rejectionMessage(host.handle(
              {
                kind: "http.request",
                method: "GET",
                url: "https://web.portable.example/private/feed",
                headers: [],
                credentials: [{
                  handle: acquired.materialHandle,
                  sink: { kind: "cookie-jar" },
                }],
                body: { kind: "none" },
                redirect: "error",
                timeoutMs: 100,
                maxOutputBytes: 4_096,
              },
              { ...context, requestId: "cookie-request-deadline" },
            ));
            capabilityElapsedMs = performance.now() - capabilityStartedAt;
            return portableHostResult(invocation);
          },
        },
      );
      const manifest = catalog.registry.resolveOwnedManifest("portable-web");
      if (manifest === undefined) {
        throw new Error("portable web projection is unavailable");
      }
      const message = await rejectionMessage(executeReadInvocation({
        manifest,
        operationId: "profiles.read",
        input: {},
        auth: cookiesAuth(join(isolatedRoot, "cookies.json")),
      }, {
        headed: false,
        environment: isolatedEnvironment,
        registry: catalog.registry,
      }));

      expect(message).toContain("invocation lease was preserved");
      expect(capabilityMessage).toContain("timed out");
      expect(capabilityElapsedMs).toBeLessThan(2_000);
      expect(cookieTimeoutMs).toBeGreaterThan(0);
      expect(cookieTimeoutMs).toBeLessThanOrEqual(100);
      expect(fetches).toBe(0);
      expect(listPortableProviderPluginInvocationLeases(
        isolatedEnvironment,
      )).toMatchObject([{
        lease: {
          containment: {
            status: "cleanup-unsafe",
          },
        },
      }]);
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  test("injects cookies only after exact request-scope filtering", async () => {
    const observed: {
      target?: string;
      cookie?: string | null;
      closed?: number;
    } = {};
    const exactCookie: StrictCookie = {
      name: "session",
      value: "private",
      domain: "web.portable.example",
      hostOnly: true,
      path: "/private",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      expires: 0,
    };
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        acquireCookies: (_selection, target) => {
          observed.target = target.href;
          return Promise.resolve({ cookies: [exactCookie], warnings: [] });
        },
        createFetchScope: (origin) => {
          expect(origin).toBe("https://web.portable.example");
          return Object.freeze({
            fetch: (target, init) => {
              observed.cookie = new Headers(init?.headers).get("cookie");
              expect(target.href).toBe(
                "https://web.portable.example/private/feed",
              );
              return Promise.resolve(new Response("{}", {
                status: 200,
                headers: { "content-type": "application/json" },
              }));
            },
            close: () => {
              observed.closed = (observed.closed ?? 0) + 1;
            },
          });
        },
      },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    const binding = catalog.registry.requireSessionRoute("portable-web");
    if (manifest === undefined || binding.transport === "provider-api") {
      throw new Error("portable web projection is unavailable");
    }
    const execution = await binding.execute(
      manifest,
      webRecipe(manifest, "feeds.read"),
      {},
      cookiesAuth(cookiePath),
      { environment },
    );
    expect(execution).toMatchObject({
      status: "succeeded",
      output: { status: 200 },
    });
    expect(observed).toEqual({
      target: "https://web.portable.example/private/feed",
      cookie: "session=private",
      closed: 1,
    });

    let escapedFetches = 0;
    let escapedCloses = 0;
    const escapedCatalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        acquireCookies: () => Promise.resolve({
          cookies: [{
            ...exactCookie,
            domain: "attacker.example",
          }],
          warnings: [],
        }),
        createFetchScope: () => Object.freeze({
          fetch: () => {
            escapedFetches += 1;
            return Promise.resolve(new Response("{}"));
          },
          close: () => {
            escapedCloses += 1;
          },
        }),
      },
    );
    const escapedManifest =
      escapedCatalog.registry.resolveOwnedManifest("portable-web");
    const escapedBinding =
      escapedCatalog.registry.requireSessionRoute("portable-web");
    if (
      escapedManifest === undefined
      || escapedBinding.transport === "provider-api"
    ) throw new Error("portable web projection is unavailable");
    const escapedExecution = await escapedBinding.execute(
      escapedManifest,
      webRecipe(escapedManifest, "feeds.read"),
      {},
      cookiesAuth(cookiePath),
      { environment },
    );
    expect(escapedExecution).toMatchObject({
      status: "succeeded",
      output: { cookieError: "CAPABILITY_FAILED" },
    });
    expect(escapedFetches).toBe(0);
    expect(escapedCloses).toBe(1);
  });

  test("binds plan files by both size and SHA-256 before starting the host", async () => {
    const expected = Buffer.from("safe", "utf8");
    const changed = Buffer.from("evil", "utf8");
    const correctPath = join(fixtureRoot, "correct.txt");
    const changedPath = join(fixtureRoot, "changed.txt");
    writeFileSync(correctPath, expected, { mode: 0o600 });
    writeFileSync(changedPath, changed, { mode: 0o600 });
    const input: OperationInput = {
      media: {
        kind: "file",
        reference: fileReference(expected),
      },
    };
    const invocations: PortableProviderPluginHostInvocation[] = [];
    const runHost: PortableProviderRuntimeDependencies["runHost"] =
      async (invocation) => {
        invocations.push(invocation);
        const file = invocation.files[0];
        if (
          file === undefined
          || invocation.capabilityHost === undefined
        ) throw new Error("portable file was not bound");
        const first = await invocation.capabilityHost.handle(
          {
            kind: "file.read",
            handle: file.handle,
            offset: 0,
            length: 2,
          },
          {
            invocationId: "test-invocation",
            requestId: "file-read-first",
            route: invocation.route,
            signal: invocation.signal ?? new AbortController().signal,
          },
        );
        // Mutate the original inode after host start and between chunk reads.
        // The capability must remain bound to the verified private snapshot.
        writeFileSync(correctPath, changed);
        const second = await invocation.capabilityHost.handle(
          {
            kind: "file.read",
            handle: file.handle,
            offset: 2,
            length: 4_094,
          },
          {
            invocationId: "test-invocation",
            requestId: "file-read-second",
            route: invocation.route,
            signal: invocation.signal ?? new AbortController().signal,
          },
        );
        if (
          first.kind !== "file.read"
          || second.kind !== "file.read"
        ) throw new Error("unexpected capability");
        return {
          output: {
            bytes: Buffer.concat([
              Buffer.from(first.data, "base64"),
              Buffer.from(second.data, "base64"),
            ]).toString("utf8"),
          },
          finalUrl: null,
          dispatch: { planned: 1, started: 1, verified: 1 },
        };
      };
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      { runHost },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    const binding = catalog.registry.requireSessionRoute("portable-web");
    if (manifest === undefined || binding.transport === "provider-api") {
      throw new Error("portable web projection is unavailable");
    }
    const correct = await binding.execute(
      manifest,
      webRecipe(manifest, "media.send"),
      input,
      cookiesAuth(cookiePath),
      {
        environment,
        fileResolver: () => Promise.resolve([correctPath]),
      },
    );
    expect(correct).toMatchObject({
      status: "succeeded",
      output: { bytes: "safe" },
    });
    expect(invocations).toHaveLength(1);

    const changedExecution = await binding.execute(
      manifest,
      webRecipe(manifest, "media.send"),
      input,
      cookiesAuth(cookiePath),
      {
        environment,
        fileResolver: () => Promise.resolve([changedPath]),
      },
    );
    expect(changedExecution).toMatchObject({
      status: "failed",
      dispatch: { planned: 1, started: 0, verified: 0 },
    });
    expect(invocations).toHaveLength(1);
  });

  test("accepts only namespaced state records that remain readable at the persisted byte bound", async () => {
    const key = "boundary";
    const maximumRecordBytes = 512 * 1024;
    const emptyRecordBytes = Buffer.byteLength(`${canonicalJson({
      schemaVersion: 2,
      key,
      revision: "00000000-0000-4000-8000-000000000000",
      value: "",
    })}\n`, "utf8");
    const largestValue = "a".repeat(maximumRecordBytes - emptyRecordBytes);
    const firstRejectedValue = `${largestValue}a`;
    const runHost: PortableProviderRuntimeDependencies["runHost"] =
      async (invocation) => {
        const host = invocation.capabilityHost;
        if (host === undefined) throw new Error("portable state host is absent");
        const context = {
          invocationId: "state-boundary-invocation",
          route: invocation.route,
          signal: invocation.signal ?? new AbortController().signal,
        } as const;
        const stored = await host.handle(
          { kind: "state.write", key, value: largestValue },
          { ...context, requestId: "state-largest-write" },
        );
        const read = await host.handle(
          { kind: "state.read", key },
          { ...context, requestId: "state-largest-read" },
        );
        let rejected = false;
        try {
          await host.handle(
            { kind: "state.write", key, value: firstRejectedValue },
            { ...context, requestId: "state-first-rejected-write" },
          );
        } catch (error) {
          rejected = error instanceof Error
            && error.message.includes("persisted byte bound");
        }
        await host.handle(
          { kind: "state.write", key, value: "legacy-update" },
          { ...context, requestId: "state-legacy-update" },
        );
        const updated = await host.handle(
          { kind: "state.read", key },
          { ...context, requestId: "state-legacy-update-read" },
        );
        const deleted = await host.handle(
          { kind: "state.delete", key },
          { ...context, requestId: "state-legacy-delete" },
        );
        const afterDelete = await host.handle(
          { kind: "state.read", key },
          { ...context, requestId: "state-legacy-delete-read" },
        );
        return {
          output: {
            stored: stored.kind === "state.write" && stored.stored,
            readable: read.kind === "state.read"
              && read.found
              && read.value === largestValue,
            rejected,
            legacyUpdated: updated.kind === "state.read"
              && updated.found
              && updated.value === "legacy-update",
            legacyDeleted: deleted.kind === "state.delete"
              && deleted.removed
              && afterDelete.kind === "state.read"
              && !afterDelete.found,
          },
          finalUrl: null,
          dispatch: { planned: 0, started: 0, verified: 0 },
        };
      };
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      { runHost },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    const binding = catalog.registry.requireSessionRoute("portable-web");
    if (manifest === undefined || binding.transport === "provider-api") {
      throw new Error("portable web projection is unavailable");
    }
    const execution = await binding.execute(
      manifest,
      webRecipe(manifest, "profiles.read"),
      {},
      cookiesAuth(cookiePath),
      { environment },
    );
    expect(execution).toMatchObject({
      status: "succeeded",
      output: {
        stored: true,
        readable: true,
        rejected: true,
        legacyUpdated: true,
        legacyDeleted: true,
      },
    });
  });

  test("compare-exchange prevents concurrent lost updates and stale deletes", async () => {
    let runScenario: PortableProviderRuntimeDependencies["runHost"] = () =>
      Promise.reject(new Error("portable state scenario is not configured"));
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        runHost: (invocation) => runScenario(invocation),
      },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    const binding = catalog.registry.requireSessionRoute("portable-web");
    if (manifest === undefined || binding.transport === "provider-api") {
      throw new Error("portable web projection is unavailable");
    }
    const execute = () => binding.execute(
      manifest,
      webRecipe(manifest, "profiles.read"),
      {},
      cookiesAuth(cookiePath),
      { environment },
    );
    let caseIndex = 0;

    await assertAsyncProperty(fc.asyncProperty(
      fc.tuple(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
      ).filter(([left, right]) => left !== right),
      async ([left, right]) => {
        const key = `cas/property-${caseIndex}`;
        caseIndex += 1;
        runScenario = async (invocation) => {
          const host = invocation.capabilityHost;
          if (host === undefined) throw new Error("portable state host is absent");
          const result = await host.handle({
            kind: "state.write",
            key,
            value: 0,
            expectedVersion: null,
          }, {
            invocationId: `state-seed-${caseIndex}`,
            requestId: "state-seed",
            route: invocation.route,
            signal: invocation.signal ?? new AbortController().signal,
          });
          return {
            output: {
              stored: result.kind === "state.write" && result.stored,
            },
            finalUrl: null,
            dispatch: { planned: 0, started: 0, verified: 0 },
          };
        };
        expect(await execute()).toMatchObject({
          status: "succeeded",
          output: { stored: true },
        });

        let readers = 0;
        let releaseReaders: (() => void) | undefined;
        const bothRead = new Promise<void>((resolve) => {
          releaseReaders = resolve;
        });
        let nextCandidate = 0;
        const candidates = [left, right] as const;
        runScenario = async (invocation) => {
          const host = invocation.capabilityHost;
          if (host === undefined) throw new Error("portable state host is absent");
          const candidate = candidates[nextCandidate];
          nextCandidate += 1;
          if (candidate === undefined) {
            throw new Error("portable state property admitted an extra writer");
          }
          const context = {
            invocationId: `state-writer-${nextCandidate}`,
            route: invocation.route,
            signal: invocation.signal ?? new AbortController().signal,
          } as const;
          const read = await host.handle(
            { kind: "state.read", key, includeVersion: true },
            { ...context, requestId: "state-read" },
          );
          if (
            read.kind !== "state.read"
            || !read.found
            || !("version" in read)
            || typeof read.version !== "string"
          ) throw new Error("portable state read omitted its version");
          readers += 1;
          if (readers === 2) releaseReaders?.();
          await bothRead;
          let stored = false;
          try {
            const write = await host.handle({
              kind: "state.write",
              key,
              value: candidate,
              expectedVersion: read.version,
            }, { ...context, requestId: "state-cas" });
            if (write.kind !== "state.write") {
              throw new Error("portable state CAS returned the wrong capability");
            }
            stored = true;
          } catch (error) {
            if (
              !(error instanceof Error)
              || !error.message.includes("state version conflict")
            ) throw error;
          }
          return {
            output: {
              candidate,
              readVersion: read.version,
              stored,
            },
            finalUrl: null,
            dispatch: { planned: 0, started: 0, verified: 0 },
          };
        };
        const updates = await Promise.all([execute(), execute()]);
        expect(updates.map((update) => update.status)).toEqual([
          "succeeded",
          "succeeded",
        ]);
        const updateOutputs = updates.map((update) => update.output as {
          readonly candidate: number;
          readonly readVersion: string;
          readonly stored: boolean;
        });
        expect(new Set(updateOutputs.map((output) => output.readVersion)).size)
          .toBe(1);
        expect(updateOutputs.map((output) => output.stored).sort()).toEqual([
          false,
          true,
        ]);
        const staleVersion = updateOutputs[0]!.readVersion;
        const winningValue = updateOutputs.find((output) => output.stored)!
          .candidate;

        runScenario = async (invocation) => {
          const host = invocation.capabilityHost;
          if (host === undefined) throw new Error("portable state host is absent");
          const context = {
            invocationId: `state-stale-delete-${caseIndex}`,
            route: invocation.route,
            signal: invocation.signal ?? new AbortController().signal,
          } as const;
          const deleted = await host.handle({
            kind: "state.delete",
            key,
            expectedVersion: staleVersion,
          }, { ...context, requestId: "state-delete" });
          const current = await host.handle(
            { kind: "state.read", key },
            { ...context, requestId: "state-read-current" },
          );
          return {
            output: {
              removed: deleted.kind === "state.delete" && deleted.removed,
              found: current.kind === "state.read" && current.found,
              value: current.kind === "state.read" && current.found
                ? current.value
                : null,
            },
            finalUrl: null,
            dispatch: { planned: 0, started: 0, verified: 0 },
          };
        };
        expect(await execute()).toMatchObject({
          status: "succeeded",
          output: {
            removed: false,
            found: true,
            value: winningValue,
          },
        });
      },
    ), {
      numRuns: 12,
      interruptAfterTimeLimit: 30_000,
    });
  });

  test("injects the admitted OAuth material only into the Authorization sink", async () => {
    const observed: { authorization?: string | null } = {};
    let loaded = 0;
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        loadToken: () => {
          loaded += 1;
          return {
            accessToken: "kernel-owned-access-token",
            expiresAt: null,
          };
        },
        createFetchScope: () => Object.freeze({
          fetch: (_target, init) => {
            observed.authorization = new Headers(init?.headers)
              .get("authorization");
            return Promise.resolve(new Response("{}", { status: 200 }));
          },
          close: () => undefined,
        }),
        runHost: async (invocation) => {
          const host = invocation.capabilityHost;
          if (host === undefined) {
            throw new Error("portable OAuth capability host is unavailable");
          }
          const context = {
            invocationId: "oauth-material-invocation",
            route: invocation.route,
            signal: invocation.signal ?? new AbortController().signal,
          } as const;
          const material = await host.handle(
            { kind: "session.acquire", name: "oauth-access-token" },
            { ...context, requestId: "oauth-material" },
          );
          if (material.kind !== "session.acquire") {
            throw new Error("portable OAuth material was not acquired");
          }
          const response = await host.handle({
            kind: "http.request",
            method: "GET",
            url: "https://api.portable.example/records",
            headers: [],
            credentials: [{
              handle: material.materialHandle,
              sink: { kind: "header", name: "authorization" },
            }],
            body: { kind: "none" },
            redirect: "error",
            timeoutMs: 1_000,
            maxOutputBytes: 4_096,
          }, { ...context, requestId: "oauth-http" });
          return {
            output: {
              status: response.kind === "http.request"
                ? response.status
                : null,
            },
            finalUrl: null,
            dispatch: { planned: 0, started: 0, verified: 0 },
          };
        },
      },
    );
    const manifest =
      catalog.registry.resolveOwnedManifest("portable-provider");
    const resolution = catalog.registry.requireOperationDefinition(
      "provider-api",
      "portable-provider",
      "records.read",
      1,
    );
    if (
      manifest === undefined
      || resolution.binding.transport !== "provider-api"
    ) throw new Error("portable provider projection is unavailable");
    const recipe = manifest.operations["records.read"]?.provider;
    if (recipe === undefined) throw new Error("provider recipe is unavailable");
    const auth: Extract<WrenchAuth, { readonly kind: "oauth-token-file" }> = {
      schemaVersion: 1,
      id: "portable-oauth",
      kind: "oauth-token-file",
      provider: "portable-provider",
      path: join(fixtureRoot, "unused-token.json"),
      scopes: ["records.read"],
      subject: "portable-account",
    };
    let output: unknown;
    const context: ProviderActionContext = {
      manifest,
      recipe,
      contract: getProviderContract(recipe, catalog.registry),
      input: {},
      auth,
      token: { accessToken: "context-token-is-not-the-material", expiresAt: null },
      http: new ProviderHttpClient(
        () => Promise.resolve(new Response("{}")),
        3_000,
        4_096,
      ),
      environment,
      signal: new AbortController().signal,
      remainingTimeMs: () => 3_000,
      resolveFiles: () => Promise.resolve([]),
      beginDispatch: () => Promise.reject(new Error("unexpected dispatch")),
      dispatch: <T>(action: () => Promise<T>) => {
        void action;
        return Promise.reject(new Error("unexpected dispatch"));
      },
      addRequiredScopes: () => undefined,
      setOutput: (value) => {
        output = value;
      },
      setFinalUrl: () => undefined,
    };
    await resolution.binding.execute(context);

    expect(loaded).toBe(1);
    expect(observed.authorization).toBe("Bearer kernel-owned-access-token");
    expect(output).toEqual({ status: 200 });
  });

  test("forwards cancellation and clamps provider host work to the remaining deadline", async () => {
    const controller = new AbortController();
    controller.abort();
    const observed: {
      timeoutMs: number | undefined;
      signal: AbortSignal | undefined;
    } = {
      timeoutMs: undefined,
      signal: undefined,
    };
    const runHost: PortableProviderRuntimeDependencies["runHost"] =
      (invocation) => {
        observed.timeoutMs = invocation.timeoutMs;
        observed.signal = invocation.signal;
        return Promise.reject(new Error(
          invocation.signal?.aborted === true ? "cancelled" : "not cancelled",
        ));
      };
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      { runHost },
    );
    const manifest =
      catalog.registry.resolveOwnedManifest("portable-provider");
    const resolution = catalog.registry.requireOperationDefinition(
      "provider-api",
      "portable-provider",
      "records.read",
      1,
    );
    if (
      manifest === undefined
      || resolution.binding.transport !== "provider-api"
    ) throw new Error("portable provider projection is unavailable");
    const recipe = manifest.operations["records.read"]?.provider;
    if (recipe === undefined) throw new Error("provider recipe is unavailable");
    const auth: Extract<WrenchAuth, { readonly kind: "oauth-token-file" }> = {
      schemaVersion: 1,
      id: "portable-oauth",
      kind: "oauth-token-file",
      provider: "portable-provider",
      path: join(fixtureRoot, "token.json"),
      scopes: ["records.read"],
      subject: "portable-account",
    };
    const context: ProviderActionContext = {
      manifest,
      recipe,
      contract: getProviderContract(recipe, catalog.registry),
      input: {},
      auth,
      token: { accessToken: "opaque-test-token", expiresAt: null },
      http: new ProviderHttpClient(
        () => Promise.resolve(new Response("{}")),
        3_000,
        4_096,
      ),
      environment,
      signal: controller.signal,
      remainingTimeMs: () => 650,
      resolveFiles: () => Promise.resolve([]),
      beginDispatch: () => Promise.reject(new Error("unexpected dispatch")),
      dispatch: <T>(action: () => Promise<T>) => {
        void action;
        return Promise.reject(new Error("unexpected dispatch"));
      },
      addRequiredScopes: () => undefined,
      setOutput: () => undefined,
      setFinalUrl: () => undefined,
    };
    let executionError: unknown;
    try {
      await resolution.binding.execute(context);
    } catch (error) {
      executionError = error;
    }
    expect(executionError).toBeInstanceOf(Error);
    expect((executionError as Error).message).toContain("cancelled");
    expect(observed).toEqual({
      timeoutMs: 650,
      signal: controller.signal,
    });
  });

  test("durably brackets one mutation and denies direct verification or handle reuse", async () => {
    const events: string[] = [];
    const hostErrors: string[] = [];
    let fetches = 0;
    const catalog = createPortableProviderPluginCatalog(
      emptyRegistry(),
      environment,
      {
        runHost: async (invocation) => {
          try {
            return await runPortableProviderPluginHost(invocation);
          } catch (error) {
            hostErrors.push(
              typeof error === "object"
                && error !== null
                && "code" in error
                && typeof error.code === "string"
                ? error.code
                : error instanceof Error
                  ? error.message
                  : String(error),
            );
            throw error;
          }
        },
        createFetchScope: () => Object.freeze({
          fetch: (_target, init) => {
            fetches += 1;
            events.push("fetch");
            expect(init.body).toBeInstanceOf(ArrayBuffer);
            if (!(init.body instanceof ArrayBuffer)) {
              throw new Error("portable request body is not an owned buffer");
            }
            expect(new TextDecoder().decode(init.body)).toBe(
              '{"text":"hello"}',
            );
            return Promise.resolve(new Response('{"id":"1"}', {
              status: 201,
              headers: { "content-type": "application/json" },
            }));
          },
          close: () => undefined,
        }),
      },
    );
    const manifest = catalog.registry.resolveOwnedManifest("portable-web");
    const binding = catalog.registry.requireSessionRoute("portable-web");
    if (manifest === undefined || binding.transport === "provider-api") {
      throw new Error("portable web projection is unavailable");
    }
    const run = (mode: "direct-verify" | "duplicate-mutation" | "normal") =>
      binding.execute(
        manifest,
        webRecipe(manifest, "messages.send"),
        { mode },
        cookiesAuth(cookiePath),
        {
          environment,
          beforeDispatch: () => {
            events.push("before");
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            events.push("after");
            return Promise.resolve();
          },
        },
      );

    const normal = await run("normal");
    expect(hostErrors).toEqual([]);
    expect(normal).toMatchObject({
      status: "succeeded",
      output: { submitted: true },
      dispatch: { planned: 1, started: 1, verified: 1 },
    });
    expect(events).toEqual(["before", "fetch", "after"]);
    expect(fetches).toBe(1);

    events.length = 0;
    fetches = 0;
    const direct = await run("direct-verify");
    expect(hostErrors).toEqual(["protocol-violation"]);
    expect(direct).toMatchObject({
      status: "indeterminate",
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(events).toEqual(["before"]);
    expect(fetches).toBe(0);

    events.length = 0;
    fetches = 0;
    hostErrors.length = 0;
    const duplicate = await run("duplicate-mutation");
    expect(hostErrors).toEqual(["protocol-violation"]);
    expect(duplicate).toMatchObject({
      status: "indeterminate",
      output: null,
      dispatch: { planned: 1, started: 1, verified: 0 },
    });
    expect(events).toEqual(["before", "fetch"]);
    expect(fetches).toBe(1);
  });
});
