import { describe, expect, test } from "bun:test";
import { parseCaptureArguments } from "@hraness/kb/capture";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createAuth, loadAuth, saveAuth } from "./auth";
import { PreservedBrowserArtifactsError } from "./browser";
import type * as MediaRuntimeModule from "./media";
import type { DoctorReport as MediaDoctorReport } from "./media/doctor";
import { canonicalJson, isWebSessionOperation, sha256, type WrenchManifest } from "./model";
import { planAssetBundlePath } from "./plan-assets";
import {
  defineProviderPlugin,
  lazyProviderApiRuntime,
  type ProviderApiPluginOperationDefinitionV1,
} from "./provider-plugin";
import {
  createProviderPluginRegistry,
  type ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  portableProviderPluginStoreRoot,
} from "./provider-plugin-lifecycle";
import {
  createPortableProviderPluginCatalog as buildPortableProviderPluginCatalog,
} from "./provider-plugin-portable-catalog";
import type { InvocationResult, RunReceipt } from "./runtime";
import {
  cachedInvocationView,
  invocationView,
  main,
  renderWrenchUsage,
  revalidatedInvocationView,
  runWrenchProcess,
  type WrenchClipEnvironmentInspection,
  type WrenchDependencies,
} from "./wrench";
import { hasUnsafeTerminalCharacters } from "@hraness/kb/clip/terminal";
import {
  acquireWebSessionCleanupAdmission,
} from "./web-session-cleanup-admission";
import {
  adapterManifestPath,
  installManifest as installManifestWithRegistry,
  loadInstalledManifest as loadInstalledManifestWithRegistry,
  writePrivateJson,
} from "./storage";
import type { ReconcileRunResult } from "./web-session-recovery";
import { getWebSessionContract, webSessionContractHash } from "./web-session-contracts";
import { isPublicWebSessionInvocationAuthority } from "./web-session-authentication-policy";

const installManifest = (
  manifest: Parameters<typeof installManifestWithRegistry>[0],
  options: Parameters<typeof installManifestWithRegistry>[1],
) => installManifestWithRegistry(manifest, {
  ...options,
  registry: options.registry ?? providerPluginRegistry,
});
const loadInstalledManifest = (
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry = providerPluginRegistry,
) => loadInstalledManifestWithRegistry(
  id,
  environment,
  registry,
);

type MediaRuntime = typeof MediaRuntimeModule;

type TestState = {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

function state(): TestState {
  const directory = mkdtempSync(join(tmpdir(), "wrench-cli-test-"));
  chmodSync(directory, 0o700);
  return { directory, environment: { ...process.env, WRENCH_STATE_HOME: directory } };
}

function manifest(risk: "R1" | "R2" | "R4" = "R2"): WrenchManifest {
  const mutating = risk === "R2";
  return {
    schemaVersion: 1,
    id: "example",
    version: "1.0.0",
    displayName: "Example",
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: {
      "messaging.send": {
        description: mutating ? "Send a message" : "Read a message",
        risk,
        sideEffect: risk === "R1" ? "none" : "Changes remote state",
        idempotency: mutating ? "local-at-most-once" : "none",
        dedupeWindowMs: mutating ? 86_400_000 : 0,
        input: {
          properties: {
            message: {
              type: "string",
              description: "Message body",
              minLength: 1,
              maxLength: 100_000,
            },
          },
          required: ["message"],
        },
        browser: {
          steps: mutating
            ? [
                { kind: "navigate", path: "/compose" },
                {
                  kind: "find",
                  locator: { by: "label", value: "Message" },
                  action: "fill",
                  with: "message",
                },
                {
                  kind: "find",
                  locator: { by: "role", value: "button", name: "Send" },
                  action: "click",
                  dispatch: true,
                },
                { kind: "assert-url", pattern: "https://example.com/thread/*" },
              ]
            : [
                { kind: "navigate", path: "/messages" },
                { kind: "read" },
              ],
          timeoutMs: 30_000,
          maxOutputBytes: 64 * 1024,
        },
      },
    },
  };
}


function xThreadManifest(): WrenchManifest {
  const bundled = xProviderManifest();
  const operation = bundled.operations["threads.publish"];
  if (operation === undefined) throw new Error("bundled X adapter omitted threads.publish");
  return { ...bundled, id: "x-thread", displayName: "X thread", operations: { "threads.publish": operation } };
}

function xProviderManifest(): WrenchManifest {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.json"),
    "utf8",
  )) as WrenchManifest;
}

function bundledWebManifest(site: "bluesky" | "linkedin" | "x"): WrenchManifest {
  return JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", site, "wrench-web-adapter.json"),
    "utf8",
  )) as WrenchManifest;
}

function reviewedTemplateReservationManifest(): WrenchManifest {
  return {
    schemaVersion: 5,
    id: "example-api",
    version: "1.0.0",
    displayName: "Example API",
    origins: ["https://example.com"],
    browserDomains: ["example.com"],
    operations: {
      "content.read": {
        description: "Read one target",
        risk: "R1",
        sideEffect: "none",
        idempotency: "none",
        dedupeWindowMs: 0,
        input: {
          properties: {
            target_id: { type: "string", description: "Target", minLength: 1, maxLength: 128 },
          },
          required: ["target_id"],
        },
        reviewedTemplate: {
          state: "capture-required",
          contractVersion: 1,
          instructions: "Capture and review an exact request before proposing a v2 account-bound template.",
        },
      },
    },
  };
}

function registryProtectingPortableCatalogFixture(): ProviderPluginRegistry {
  const operation: ProviderApiPluginOperationDefinitionV1 = {
    name: "records.read",
    contractVersion: 1,
    risk: "R1",
    input: { properties: {}, required: [] },
    sideEffect: "none",
    idempotency: "none",
    dedupeWindowMs: 0,
    state: "observed",
    dispatch: "none",
    implementation: "read portable catalog fixture records",
    planDispatches: () => [],
    validateInput: (input) => Object.keys(input).length === 0
      ? []
      : ["portable catalog fixture accepts no input"],
    requiredScopeSets: [["records.read"]],
    coverage: ["records"],
  };
  const plugin = defineProviderPlugin({
    apiVersion: 1,
    id: "portable-catalog-fixture-plugin",
    version: "1.0.0",
    displayName: "Portable catalog fixture plugin",
    sourceKind: "source",
    implementationSources: [{
      label: "plugin.ts",
      url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
    }],
    bindings: [{
      transport: "provider-api",
      surfaceId: "portable-catalog-fixture",
      origin: "https://api.portable-catalog.example",
      manifestOrigins: ["https://portable-catalog.example"],
      protectedHostnameFamilies: ["portable-catalog.example"],
      authKinds: ["oauth-token-file"],
      operations: [operation],
      subject: {
        format: "portable-catalog-fixture:<id>",
        matches: (value) =>
          /^portable-catalog-fixture:[a-z0-9-]{1,40}$/u.test(value),
      },
      runtime: lazyProviderApiRuntime(() => Promise.resolve({
        execute: () => Promise.resolve(),
      })),
    }],
  });
  return createProviderPluginRegistry([
    ...providerPluginRegistry.list(),
    plugin,
  ]);
}


function install(testState: TestState, risk: "R1" | "R2" | "R4" = "R2"): void {
  void risk;
  installManifest(xProviderManifest(), { force: false, environment: testState.environment });
  saveAuth(createAuth("x-official", {
    oauthProvider: "x",
    tokenFile: join(testState.directory, "x-token.json"),
    scopes: ["tweet.read", "tweet.write", "users.read"],
    subject: "12345",
  }), testState.environment);
}

function capture(): {
  readonly output: { readonly stdout: (value: string) => void; readonly stderr: (value: string) => void };
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  const standardOutput: string[] = [];
  const standardError: string[] = [];
  return {
    output: {
      stdout: (value) => standardOutput.push(value),
      stderr: (value) => standardError.push(value),
    },
    stdout: () => standardOutput.join(""),
    stderr: () => standardError.join(""),
  };
}

function clipEnvironmentInspection(
  browserCaptureReady = false,
  generatedAt = "2026-07-22T00:00:00.000Z",
): WrenchClipEnvironmentInspection {
  const report = {
    fixtureSchema: "opaque-kb-doctor-report",
    generatedAt,
    nestedEvidence: { preserved: true },
  };
  return {
    report,
    renderReport: () => `Opaque KB environment report at ${generatedAt}\n`,
    browserCaptureBootstrapReady: browserCaptureReady,
  };
}

function unavailableMediaReport(): MediaDoctorReport {
  return {
    ok: false,
    checks: [],
    warnings: [],
    errors: [],
    capabilities: {
      directHttp: true,
      acquisition: false,
      mediaSeparation: false,
      javascriptRuntime: false,
      localTranscription: false,
    },
  };
}

function mediaRuntime(overrides: Partial<MediaRuntime> = {}): MediaRuntime {
  return {
    runCli: () => Promise.resolve(0),
    runDoctor: () => Promise.resolve(unavailableMediaReport()),
    renderDoctorReport: () => "",
    ...overrides,
  };
}

async function runDoctor(
  testState: TestState,
  json = true,
): Promise<{ readonly code: number; readonly stdout: string }> {
  const wrench = capture();
  const code = await main(
    json ? ["doctor", "--json"] : ["doctor"],
    testState.environment,
    wrench.output,
    {
      inspectClipEnvironment: () => Promise.resolve(clipEnvironmentInspection()),
      loadMediaRuntime: () => Promise.resolve(mediaRuntime()),
    },
  );
  expect(wrench.stderr()).toBe("");
  return { code, stdout: wrench.stdout() };
}

function reconciliationResult(
  ok: boolean,
  runId = "00000000-0000-4000-8000-000000000000",
): ReconcileRunResult {
  return {
    ok,
    status: ok ? "reconciliation-observed" : "reconciliation-inconclusive",
    runId,
    originalReceiptStatus: "indeterminate",
    receiptUnchanged: true,
    providerWriteDispatched: false,
    recoveryArtifactsReleased: ok,
    observation: {
      schemaVersion: 1,
      observationId: "10000000-0000-4000-8000-000000000001",
      runId,
      observedAt: "2026-07-23T12:00:00.000Z",
      receiptHash: "a".repeat(64),
      adapterHash: "b".repeat(64),
      operation: "content.save",
      inputHash: "c".repeat(64),
      authHash: "d".repeat(64),
      contractHash: "e".repeat(64),
      inputSource: "provided",
      outcome: ok ? "desired-state-observed" : "inconclusive",
      desiredStateMatched: ok ? true : null,
      actualState: ok ? true : null,
      reason: ok ? "exact-readback" : "readback-failed",
    },
  };
}

const POST_ID_FOR_RECONCILIATION = "2078889282404569267";

describe("run reconciliation CLI", () => {
  test("passes exact optional input to the read-only reconciler and returns its distinct exit status", async () => {
    const testState = state();
    try {
      const wrench = capture();
      const calls: Array<{
        readonly runId: string;
        readonly input: unknown;
        readonly environment: Readonly<Record<string, string | undefined>> | undefined;
      }> = [];
      const runId = "00000000-0000-4000-8000-000000000000";
      const code = await main(
        [
          "runs",
          "reconcile",
          runId,
          "--input",
          `{"post_id":"${POST_ID_FOR_RECONCILIATION}","saved":true}`,
          "--json",
        ],
        testState.environment,
        wrench.output,
        {
          reconcileWebSessionRun: (selectedRunId, input, options) => {
            calls.push({
              runId: selectedRunId,
              input,
              environment: options?.environment,
            });
            return Promise.resolve(reconciliationResult(true, selectedRunId));
          },
        },
      );

      expect(code).toBe(0);
      expect(wrench.stderr()).toBe("");
      expect(calls).toEqual([{
        runId,
        input: { post_id: POST_ID_FOR_RECONCILIATION, saved: true },
        environment: testState.environment,
      }]);
      expect(JSON.parse(wrench.stdout())).toEqual(reconciliationResult(true, runId));

      const inconclusiveWrench = capture();
      const inconclusiveCode = await main(
        ["runs", "reconcile", runId, "--json"],
        testState.environment,
        inconclusiveWrench.output,
        {
          reconcileWebSessionRun: (selectedRunId, input) => {
            expect(input).toBeUndefined();
            return Promise.resolve(reconciliationResult(false, selectedRunId));
          },
        },
      );
      expect(inconclusiveCode).toBe(5);
      expect(inconclusiveWrench.stderr()).toBe("");
      expect(JSON.parse(inconclusiveWrench.stdout())).toEqual(reconciliationResult(false, runId));
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("routes schema-6 runs to explicit portable evidence reconciliation", async () => {
    const testState = state();
    try {
      const runId = "20000000-0000-4000-8000-000000000002";
      writePrivateJson(
        join(testState.directory, "runs", `${runId}.json`),
        {
          schemaVersion: 6,
          runId,
          planDigest: "1".repeat(64),
          adapter: {
            id: "portable-web",
            version: "1.0.0",
            hash: "2".repeat(64),
          },
          operation: "likes.set",
          risk: "R2",
          inputHash: "3".repeat(64),
          auth: {
            id: "portable-auth",
            hash: "4".repeat(64),
            kind: "cookies-file",
          },
          transport: "portable-provider-plugin",
          status: "indeterminate",
          dispatchStarted: true,
          dispatch: { planned: 1, started: 1, verified: 0 },
          startedAt: "2026-07-25T12:00:00.000Z",
          finishedAt: "2026-07-25T12:00:01.000Z",
          finalOrigin: null,
          error: "outcome unknown",
          portablePluginContract: {
            pluginId: "portable-plugin",
            pluginVersion: "1.0.0",
            hostApiVersion: 1,
            bundleSha256: "5".repeat(64),
            manifestSha256: "6".repeat(64),
            adapterId: "portable-web",
            transport: "web-session-api",
            surfaceId: "portable-web",
            operation: "likes.set",
            contractVersion: 1,
            descriptorSha256: "7".repeat(64),
          },
        },
        { privateParent: true },
      );
      const wrench = capture();
      const evidence = {
        outcome: "not-applied",
        evidenceHash: "8".repeat(64),
      } as const;
      let observed: unknown;
      const code = await main(
        [
          "runs",
          "reconcile",
          runId,
          "--input",
          JSON.stringify(evidence),
          "--json",
        ],
        testState.environment,
        wrench.output,
        {
          reconcilePortableProviderPluginRun: (
            selectedRunId,
            input,
            options,
          ) => {
            observed = {
              selectedRunId,
              input,
              environment: options.environment,
            };
            return {
              ok: true,
              kind: "portable-provider-plugin-reconciliation",
              runId: selectedRunId,
              originalReceiptStatus: "indeterminate",
              receiptUnchanged: true,
              providerWriteDispatched: false,
              outcome: "not-applied",
              status: "safe-retry",
              evidenceHash: "8".repeat(64),
              recoveryArtifactsReleased: true,
            };
          },
        },
      );
      expect(code).toBe(0);
      expect(wrench.stderr()).toBe("");
      expect(observed).toEqual({
        selectedRunId: runId,
        input: evidence,
        environment: testState.environment,
      });
      expect(JSON.parse(wrench.stdout())).toMatchObject({
        kind: "portable-provider-plugin-reconciliation",
        outcome: "not-applied",
        status: "safe-retry",
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed reconciliation input before calling the reconciler", async () => {
    const testState = state();
    try {
      const wrench = capture();
      let calls = 0;
      const code = await main(
        [
          "runs",
          "reconcile",
          "00000000-0000-4000-8000-000000000000",
          "--input",
          "{not-json}",
        ],
        testState.environment,
        wrench.output,
        {
          reconcileWebSessionRun: () => {
            calls += 1;
            return Promise.resolve(reconciliationResult(true));
          },
        },
      );
      expect(code).toBe(3);
      expect(calls).toBe(0);
      expect(wrench.stdout()).toBe("");
      expect(wrench.stderr()).toContain("wrench:");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("auth CLI", () => {
  test("lists exact reviewed Google scopes without exposing the token file", async () => {
    const testState = state();
    try {
      const tokenFile = join(testState.directory, "private-google-token.json");
      const scopes = [
        "https://www.googleapis.com/auth/contacts.other.readonly",
        "https://www.googleapis.com/auth/contacts.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
      ].sort();
      saveAuth(createAuth("gmail-main", {
        oauthProvider: "gmail",
        tokenFile,
        scopes,
        subject: "person@gmail.com",
        managed: true,
      }), testState.environment);

      const listed = capture();
      expect(await main(
        ["auth", "list", "--json"],
        testState.environment,
        listed.output,
      )).toBe(0);
      const result = JSON.parse(listed.stdout()) as {
        readonly auth: readonly { readonly scopes?: readonly string[] }[];
      };
      expect(result.auth[0]?.scopes).toEqual(scopes);
      expect(listed.stdout()).toContain("contacts.other.readonly");
      expect(listed.stdout()).not.toContain(tokenFile);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("onboards, binds, and explicitly syncs a distinct WhatsApp linked device", async () => {
    const testState = state();
    try {
      const added = capture();
      expect(await main([
        "auth", "add", "whatsapp-protocol",
        "--linked-device", "whatsapp",
      ], testState.environment, added.output)).toBe(0);
      const defaultStore = join(
        realpathSync(testState.directory),
        "linked-device-stores",
        "whatsapp-protocol",
      );
      const onboardedAuth = loadAuth(
        "whatsapp-protocol",
        testState.environment,
      );
      expect(onboardedAuth).toMatchObject({
        schemaVersion: 1,
        id: "whatsapp-protocol",
        kind: "linked-device-store",
        provider: "whatsapp",
        path: defaultStore,
      });
      if (onboardedAuth.kind !== "linked-device-store") {
        throw new Error("onboarded WhatsApp auth has the wrong kind");
      }
      expect(onboardedAuth.realmKey).toMatch(/^[a-f0-9]{64}$/u);
      expect(added.stdout()).toContain("wrench auth pair whatsapp-protocol");

      const paired = capture();
      let pairCalls = 0;
      expect(await main(
        ["auth", "pair", "whatsapp-protocol", "--phone", "+15551234567"],
        testState.environment,
        paired.output,
        {
          pairLinkedDeviceAuth: async (_binding, auth, options) => {
            pairCalls += 1;
            expect(auth).toMatchObject({
              kind: "linked-device-store",
              provider: "whatsapp",
              path: defaultStore,
            });
            expect(options.phone).toBe("+15551234567");
            mkdirSync(defaultStore, { recursive: true, mode: 0o700 });
            await options.attempt.beforeExternalBegin();
            return "whatsapp:pn:15551234567";
          },
        },
      )).toBe(0);
      expect(pairCalls).toBe(1);
      expect(loadAuth("whatsapp-protocol", testState.environment)).toMatchObject({
        kind: "linked-device-store",
        provider: "whatsapp",
        subject: "whatsapp:pn:15551234567",
      });
      expect(paired.stdout()).toContain("separate device session");
      expect(paired.stdout()).not.toContain(defaultStore);
      const lifecycleJournalDirectory = join(
        realpathSync(testState.directory),
        "run-journals",
        "linked-device-lifecycle",
      );
      const pairJournalName = readdirSync(lifecycleJournalDirectory)[0];
      if (pairJournalName === undefined) {
        throw new Error("pairing omitted its durable lifecycle journal");
      }
      const pairJournalText = readFileSync(
        join(lifecycleJournalDirectory, pairJournalName),
        "utf8",
      );
      const pairJournalValue = JSON.parse(pairJournalText) as unknown;
      expect(pairJournalValue).toMatchObject({
        kind: "pair",
        authId: "whatsapp-protocol",
        phase: "terminal",
        status: "succeeded",
        result: {
          kind: "pair",
        },
      });
      expect(pairJournalText).toMatch(
        /"resultingAuthContentHash":"[a-f0-9]{64}"/u,
      );
      expect(pairJournalText).not.toContain("+15551234567");
      expect(pairJournalText).not.toContain("whatsapp:pn:15551234567");
      expect(pairJournalText).not.toContain(defaultStore);

      const synced = capture();
      let syncCalls = 0;
      expect(await main(
        ["auth", "sync", "whatsapp-protocol", "--once", "--json"],
        testState.environment,
        synced.output,
        {
          syncLinkedDeviceAuthOnce: async (_binding, auth, options) => {
            syncCalls += 1;
            expect(auth).toMatchObject({
              kind: "linked-device-store",
              provider: "whatsapp",
              subject: "whatsapp:pn:15551234567",
            });
            await options.attempt.beforeExternalBegin();
            return {
              itemsStored: 42,
              projection: "local-store",
              emitsProtocolAcknowledgements: true,
            };
          },
        },
      )).toBe(0);
      expect(syncCalls).toBe(1);
      expect(synced.stderr()).toContain("transport acknowledgements");
      expect(JSON.parse(synced.stdout())).toMatchObject({
        ok: true,
        messagesStored: 42,
        projection: "local-store",
        presenceMode: "quiet",
        emitsProtocolAcknowledgements: true,
      });

      const listed = capture();
      expect(await main(
        ["auth", "list", "--json"],
        testState.environment,
        listed.output,
      )).toBe(0);
      const listedAuth = JSON.parse(listed.stdout()) as {
        readonly ok: boolean;
        readonly auth: readonly Readonly<Record<string, unknown>>[];
      };
      const realmFingerprint = listedAuth.auth[0]?.realmFingerprint;
      if (typeof realmFingerprint !== "string") {
        throw new Error("listed WhatsApp auth omitted its realm fingerprint");
      }
      expect(realmFingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(listedAuth).toEqual({
        ok: true,
        auth: [{
          id: "whatsapp-protocol",
          kind: "linked-device-store",
          realmFingerprint,
          subject: "whatsapp:pn:15551234567",
          provider: "whatsapp",
        }],
      });
      expect(listed.stdout()).not.toContain(defaultStore);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("returns structured exit 5 for an indeterminate linked-device sync", async () => {
    const testState = state();
    const deviceStore = mkdtempSync(join(tmpdir(), "wrench-whatsapp-store-"));
    chmodSync(deviceStore, 0o700);
    try {
      saveAuth(createAuth("whatsapp-protocol", {
        linkedDeviceProvider: "whatsapp",
        deviceStore,
        subject: "whatsapp:pn:15551234567",
      }), testState.environment);
      const wrench = capture();
      const code = await main(
        ["auth", "sync", "whatsapp-protocol", "--once", "--json"],
        testState.environment,
        wrench.output,
        {
          syncLinkedDeviceAuthOnce: async (_binding, _auth, options) => {
            await options.attempt.beforeExternalBegin();
            throw new Error("private provider failure detail");
          },
        },
      );

      expect(code).toBe(5);
      const failure = JSON.parse(wrench.stdout()) as {
        readonly ok: boolean;
        readonly status: string;
        readonly journalId: string;
      };
      expect(failure).toEqual({
        ok: false,
        status: "indeterminate",
        journalId: failure.journalId,
      });
      expect(failure.journalId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(wrench.stdout()).not.toContain("private provider failure detail");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
      rmSync(deviceStore, { recursive: true, force: true });
    }
  });

  test("persists a hybrid Arc locator and lists no source profile path", async () => {
    const testState = state();
    try {
      const saved = capture();
      expect(await main([
        "auth", "add", "whatsapp-main",
        "--browser-profile", "/private/Arc/User Data/Profile 1",
        "--browser-executable", "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "--trust-profile-egress",
        "--cookie-source", "arc",
        "--cookie-profile", "Profile 1",
        "--subject", "urn:li:person:viewer-1",
      ], testState.environment, saved.output)).toBe(0);
      expect(loadAuth("whatsapp-main", testState.environment)).toEqual({
        schemaVersion: 1,
        id: "whatsapp-main",
        kind: "browser-profile",
        profile: "/private/Arc/User Data/Profile 1",
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        trustUnfilteredEgress: true,
        cookieSource: "arc",
        cookieProfile: "Profile 1",
        subject: "urn:li:person:viewer-1",
      });

      const listed = capture();
      expect(await main(["auth", "list", "--json"], testState.environment, listed.output)).toBe(0);
      const result = JSON.parse(listed.stdout()) as { readonly auth: readonly Record<string, unknown>[] };
      expect(result.auth).toEqual([{
        id: "whatsapp-main",
        kind: "browser-profile",
        realmFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        subject: "urn:li:person:viewer-1",
        trustUnfilteredEgress: true,
        cookieSource: "arc",
        cookieProfile: "Profile 1",
      }]);
      expect(listed.stdout()).not.toContain("/private/Arc");
      expect(listed.stdout()).not.toContain("/Applications/Chromium");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("persists subjects supplied with cookie-source and cookies-file locators", async () => {
    const testState = state();
    try {
      expect(await main([
        "auth", "add", "arc-account", "--cookie-source", "arc", "--subject", "15576933",
      ], testState.environment, capture().output)).toBe(0);
      expect(await main([
        "auth", "add", "file-account", "--cookies-file", "./cookies.json", "--subject", "viewer_123",
      ], testState.environment, capture().output)).toBe(0);

      expect(loadAuth("arc-account", testState.environment)).toEqual({
        schemaVersion: 1,
        id: "arc-account",
        kind: "cookie-source",
        source: "arc",
        subject: "15576933",
      });
      expect(loadAuth("file-account", testState.environment)).toMatchObject({
        schemaVersion: 1,
        id: "file-account",
        kind: "cookies-file",
        subject: "viewer_123",
      });

      const listed = capture();
      expect(await main(["auth", "list", "--json"], testState.environment, listed.output)).toBe(0);
      const result = JSON.parse(listed.stdout()) as { readonly auth: readonly Record<string, unknown>[] };
      expect(result.auth.find((entry) => entry.id === "arc-account"))
        .toMatchObject({ id: "arc-account", subject: "15576933" });
      expect(result.auth.find((entry) => entry.id === "file-account"))
        .toMatchObject({ id: "file-account", subject: "viewer_123" });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("probes and durably binds the active web-session account without exposing cookies", async () => {
    const testState = state();
    try {
      saveAuth(createAuth("arc-main", { source: "arc", profile: "Profile 1" }), testState.environment);
      const wrench = capture();
      expect(await main(
        ["auth", "bind", "arc-main", "--site", "x", "--json"],
        testState.environment,
        wrench.output,
        {
          probePluginSubject: () => Promise.resolve("2244994945"),
        },
      )).toBe(0);
      expect(loadAuth("arc-main", testState.environment)).toEqual({
        schemaVersion: 1,
        id: "arc-main",
        kind: "cookie-source",
        source: "arc",
        profile: "Profile 1",
        subject: "2244994945",
      });
      expect(JSON.parse(wrench.stdout())).toMatchObject({
        ok: true,
        id: "arc-main",
        site: "x",
        subject: "2244994945",
      });
      expect(wrench.stdout()).not.toContain("auth_token");

      const refused = capture();
      expect(await main(
        ["auth", "bind", "arc-main", "--site", "x"],
        testState.environment,
        refused.output,
        { probePluginSubject: () => Promise.resolve("999") },
      )).toBe(3);
      expect(refused.stderr()).toContain("already bound to a different account");
      expect(loadAuth("arc-main", testState.environment).subject).toBe("2244994945");

      expect(await main(
        ["auth", "bind", "arc-main", "--site", "linkedin", "--force"],
        testState.environment,
        capture().output,
        {
          probePluginSubject: () =>
            Promise.resolve("urn:li:fsd_profile:123"),
        },
      )).toBe(0);
      expect(loadAuth("arc-main", testState.environment).subject).toBe("urn:li:fsd_profile:123");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("returns the exact bounded browser recovery handle when auth binding cannot clean up", async () => {
    const testState = state();
    const recoveryHandle =
      "v1;session=aW8tYmx1ZXNreQ;config=L3RtcC9pby9jb25maWc;socket=L3RtcC9pby9zb2NrZXQ;artifacts=L3RtcC9pby9hcnRpZmFjdHM";
    try {
      saveAuth(createAuth("bluesky-main", {
        browserProfile: "Default",
        trustUnfilteredEgress: true,
      }), testState.environment);
      const json = capture();
      expect(await main(
        ["auth", "bind", "bluesky-main", "--site", "bluesky", "--json"],
        testState.environment,
        json.output,
        {
          probePluginSubject: () => Promise.reject(
            new PreservedBrowserArtifactsError(
              "Bluesky browser bootstrap preserved private artifacts",
              recoveryHandle,
              new Error("simulated cleanup failure"),
            ),
          ),
        },
      )).toBe(5);
      expect(json.stderr()).toBe("");
      expect(JSON.parse(json.stdout())).toEqual({
        ok: false,
        status: "indeterminate",
        privateArtifactsPreserved: true,
        error: "Bluesky browser bootstrap preserved private artifacts",
        recoveryHandle,
      });
      expect(json.stdout()).not.toContain("[REDACTED]");
      expect(loadAuth("bluesky-main", testState.environment).subject)
        .toBeUndefined();

      const text = capture();
      expect(await main(
        ["auth", "bind", "bluesky-main", "--site", "bluesky"],
        testState.environment,
        text.output,
        {
          probePluginSubject: () => Promise.reject(
            new PreservedBrowserArtifactsError(
              "Bluesky browser bootstrap preserved private artifacts",
              recoveryHandle,
              new Error("simulated cleanup failure"),
            ),
          ),
        },
      )).toBe(5);
      expect(text.stdout()).toBe("");
      expect(text.stderr()).toContain(`recovery handle: ${recoveryHandle}`);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("passes the process cancellation signal into auth subject probing", async () => {
    const testState = state();
    const controller = new AbortController();
    controller.abort();
    let observedSignal: AbortSignal | undefined;
    try {
      saveAuth(createAuth("arc-main", {
        source: "arc",
      }), testState.environment);
      const wrench = capture();
      expect(await main(
        ["auth", "bind", "arc-main", "--site", "x"],
        testState.environment,
        wrench.output,
        {
          probePluginSubject: (_binding, _auth, signal) => {
            observedSignal = signal;
            return Promise.reject(new Error(
              signal?.aborted === true
                ? "subject probe was cancelled"
                : "subject probe missed cancellation",
            ));
          },
        },
        controller.signal,
      )).toBe(3);
      expect(observedSignal).toBe(controller.signal);
      expect(wrench.stderr()).toContain("subject probe was cancelled");
      expect(loadAuth("arc-main", testState.environment).subject)
        .toBeUndefined();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("preserves a concurrent auth replacement while account probing is pending", async () => {
    const testState = state();
    let markProbeStarted: (() => void) | undefined;
    let finishProbe: ((subject: string) => void) | undefined;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const probeResult = new Promise<string>((resolve) => {
      finishProbe = resolve;
    });
    try {
      saveAuth(createAuth("arc-main", {
        source: "arc",
        profile: "Profile 1",
      }), testState.environment);
      const wrench = capture();
      const binding = main(
        ["auth", "bind", "arc-main", "--site", "x"],
        testState.environment,
        wrench.output,
        {
          probePluginSubject: () => {
            markProbeStarted?.();
            return probeResult;
          },
        },
      );
      await probeStarted;

      const winner = createAuth("arc-main", {
        cookiesFile: "/private/concurrent-winner-cookies.json",
        subject: "winner-account",
      });
      saveAuth(winner, testState.environment, { force: true });
      const winnerBytes = `${canonicalJson(winner)}\n`;
      finishProbe?.("2244994945");

      expect(await binding).toBe(3);
      expect(wrench.stderr()).toContain(
        "changed while its account was being probed",
      );
      expect(loadAuth("arc-main", testState.environment)).toEqual(winner);
      expect(readFileSync(
        join(testState.directory, "auth", "arc-main.json"),
        "utf8",
      )).toBe(winnerBytes);
    } finally {
      finishProbe?.("2244994945");
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("threads the command cancellation signal into capture admission", async () => {
    const testState = state();
    const wrench = capture();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    try {
      const code = await main(
        ["read", "https://example.com/article", "--mode", "browser"],
        testState.environment,
        wrench.output,
        {
          clipMain: async (
            arguments_,
            environment,
            _output,
            clipDependencies,
          ) => {
            const parsed = parseCaptureArguments(arguments_ ?? [], environment);
            if (!parsed.ok || parsed.value.command !== "inspect") {
              throw new Error("cancellation capture fixture did not parse");
            }
            const runCapture = clipDependencies?.runCapture;
            if (runCapture === undefined) {
              throw new Error("capture dependency was not installed");
            }
            await runCapture(parsed.value);
            return 0;
          },
          runCapture: async (_arguments, _environment, dependencies) => {
            observedSignal = dependencies?.signal;
            throw new Error("stop after observing capture cancellation signal");
          },
        },
        controller.signal,
      );
      expect(code).toBe(3);
      expect(observedSignal).toBe(controller.signal);
      expect(wrench.stderr()).toContain(
        "stop after observing capture cancellation signal",
      );
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reuses a stored hybrid Arc locator for clipping without exposing its path", async () => {
    const testState = state();
    const wrench = capture();
    const profileRoot = mkdtempSync(join(tmpdir(), "wrench-cli-profile-test-"));
    chmodSync(profileRoot, 0o700);
    const userData = join(profileRoot, "Arc User Data");
    const sourceProfile = join(userData, "Profile 1");
    mkdirSync(sourceProfile, { recursive: true });
    writeFileSync(join(userData, "Local State"), "{\"os_crypt\":{}}", { mode: 0o600 });
    writeFileSync(join(sourceProfile, "Preferences"), "source-must-not-change", { mode: 0o600 });
    let clonedUserData: string | undefined;
    try {
      saveAuth(createAuth("arc-main", {
        browserProfile: sourceProfile,
        browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        trustUnfilteredEgress: true,
        cookieSource: "arc",
        cookieProfile: "Profile 1",
      }), testState.environment);
      const code = await main(
        ["read", "https://www.linkedin.com/feed/", "--auth", "arc-main", "--json"],
        testState.environment,
        wrench.output,
        {
          clipMain: (arguments_, _environment, _output, clipDependencies, runtimeOptions) => {
            expect(clipDependencies?.runCapture).toBeFunction();
            const values = [...(arguments_ ?? [])];
            const profileIndex = values.indexOf("--browser-profile");
            const selected = values[profileIndex + 1];
            expect(profileIndex).toBeGreaterThan(-1);
            expect(selected).toBeString();
            if (selected === undefined) throw new Error("missing cloned profile");
            clonedUserData = selected;
            expect(selected).not.toBe(sourceProfile);
            expect(existsSync(join(selected, "Default", "Preferences"))).toBeTrue();
            expect(runtimeOptions).toEqual({
              browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
              ownedBrowserProfile: { path: selected, profileDirectory: "Default" },
            });
            expect(values.filter((value) => value !== selected)).toEqual([
              "inspect",
              "https://www.linkedin.com/feed/",
              "--json",
              "--browser-profile",
              "--cookie-source", "arc",
              "--cookie-profile", "Profile 1",
            ]);
            writeFileSync(join(selected, "Default", "Preferences"), "clone-was-mutated", { mode: 0o600 });
            return Promise.resolve(0);
          },
        },
      );
      expect(code).toBe(0);
      expect(readFileSync(join(sourceProfile, "Preferences"), "utf8")).toBe("source-must-not-change");
      expect(clonedUserData).toBeString();
      expect(existsSync(dirname(clonedUserData ?? sourceProfile))).toBeFalse();
      expect(wrench.stdout()).toBe("");
      expect(wrench.stderr()).toBe("");

      let failedClone: string | undefined;
      expect(await main(
        ["read", "https://www.linkedin.com/feed/", "--auth", "arc-main"],
        testState.environment,
        wrench.output,
        {
          clipMain: (arguments_) => {
            const values = [...(arguments_ ?? [])];
            failedClone = values[values.indexOf("--browser-profile") + 1];
            throw new Error("synthetic delegated capture failure");
          },
        },
      )).toBe(3);
      expect(failedClone).toBeString();
      expect(existsSync(dirname(failedClone ?? sourceProfile))).toBeFalse();
      expect(readFileSync(join(sourceProfile, "Preferences"), "utf8")).toBe("source-must-not-change");

      let malformedProfile: string | undefined;
      expect(await main(
        ["read", "https://www.linkedin.com/feed/", "--mode", "http", "--auth", "arc-main"],
        testState.environment,
        wrench.output,
        {
          clipMain: (arguments_, _environment, _output, _dependencies, runtimeOptions) => {
            const values = [...(arguments_ ?? [])];
            malformedProfile = values[values.indexOf("--browser-profile") + 1];
            expect(runtimeOptions).toBeUndefined();
            return Promise.resolve(2);
          },
        },
      )).toBe(2);
      expect(malformedProfile).toBe(sourceProfile);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
      rmSync(profileRoot, { recursive: true, force: true });
    }
  });

  test("routes Gmail OAuth reads and clips through the official private capture boundary", async () => {
    const testState = state();
    const privateOutput = join(realpathSync(testState.directory), "captures", "gmail");
    const explicitOutput = join(testState.directory, "explicit-export");
    try {
      saveAuth(createAuth("gmail-main", {
        oauthProvider: "gmail",
        tokenFile: join(testState.directory, "gmail-token.json"),
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        subject: "reader@gmail.com",
      }), testState.environment);

      let genericClipCalls = 0;
      const observed: Array<{
        readonly command: string;
        readonly outputBase: string;
        readonly stdout: boolean;
        readonly media: string;
        readonly authId: string;
      }> = [];
      const dependencies: Partial<WrenchDependencies> = {
        clipMain: () => {
          genericClipCalls += 1;
          return Promise.resolve(99);
        },
        gmailCaptureMain: (options, auth) => {
          observed.push({
            command: options.command,
            outputBase: options.outputBase,
            stdout: options.stdout,
            media: options.media,
            authId: auth.id,
          });
          return Promise.resolve(0);
        },
      };

      const defaultCapture = capture();
      const defaultExitCode = await main(
        ["clip", "https://mail.google.com/mail/u/0/#inbox/thread-1", "--auth", "gmail-main"],
        testState.environment,
        defaultCapture.output,
        dependencies,
      );
      expect(defaultCapture.stderr()).toBe("");
      expect(defaultExitCode).toBe(0);
      expect(existsSync(privateOutput)).toBeTrue();

      const readCapture = capture();
      expect(await main(
        ["read", "https://mail.google.com/mail/u/reader%40gmail.com/#all/thread-2", "--auth", "gmail-main"],
        testState.environment,
        readCapture.output,
        dependencies,
      )).toBe(0);
      expect(readCapture.stderr()).toBe("");

      const explicitCapture = capture();
      expect(await main(
        [
          "clip",
          "https://mail.google.com/mail/u/0/#sent/thread-3",
          "--auth", "gmail-main",
          "--output", explicitOutput,
        ],
        testState.environment,
        explicitCapture.output,
        dependencies,
      )).toBe(0);
      expect(explicitCapture.stderr()).toBe("");

      expect(genericClipCalls).toBe(0);
      expect(observed).toEqual([
        {
          command: "capture",
          outputBase: privateOutput,
          stdout: false,
          media: "all",
          authId: "gmail-main",
        },
        {
          command: "inspect",
          outputBase: "kb/articles",
          stdout: true,
          media: "none",
          authId: "gmail-main",
        },
        {
          command: "capture",
          outputBase: explicitOutput,
          stdout: false,
          media: "all",
          authId: "gmail-main",
        },
      ]);
      expect(existsSync(explicitOutput)).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps non-Gmail OAuth locators outside browser capture", async () => {
    const testState = state();
    try {
      saveAuth(createAuth("x-main", {
        oauthProvider: "x",
        tokenFile: join(testState.directory, "x-token.json"),
        scopes: ["tweet.read", "users.read"],
        subject: "12345",
      }), testState.environment);
      const wrench = capture();
      let delegated = false;
      expect(await main(
        ["clip", "https://x.com/example/status/1", "--auth", "x-main"],
        testState.environment,
        wrench.output,
        {
          clipMain: () => {
            delegated = true;
            return Promise.resolve(99);
          },
          gmailCaptureMain: () => {
            delegated = true;
            return Promise.resolve(99);
          },
        },
      )).toBe(3);
      expect(delegated).toBeFalse();
      expect(wrench.stderr()).toContain(
        "official x API capabilities and cannot be used for browser capture",
      );
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("Wrench media routing", () => {
  test("does not load the media runtime for an unrelated Wrench command", async () => {
    const wrench = capture();
    let mediaLoads = 0;
    const code = await main(
      ["platforms", "--json"],
      process.env,
      wrench.output,
      {
        loadMediaRuntime: () => {
          mediaLoads += 1;
          return Promise.resolve(mediaRuntime());
        },
      },
    );

    expect(code).toBe(0);
    expect(mediaLoads).toBe(0);
  });

  test("passes translated media arguments, environment, signal, and exit code through unchanged", async () => {
    const environment = { ...process.env, WRENCH_MEDIA_HOME: "/tmp/media-library" };
    const wrench = capture();
    const controller = new AbortController();
    const calls: string[][] = [];

    const code = await main(
      ["media", "audio", "https://media.example/item", "--json"],
      environment,
      wrench.output,
      {
        loadMediaRuntime: () => Promise.resolve(mediaRuntime({
          runCli: (arguments_, options) => {
            calls.push([...arguments_]);
            expect(options?.environment).toBe(environment);
            expect(options?.signal).toBe(controller.signal);
            options?.io?.stdout("media delegated output\n");
            return Promise.resolve(9);
          },
        })),
      },
      controller.signal,
    );

    expect(code).toBe(9);
    expect(calls).toEqual([["audio", "https://media.example/item", "--json"]]);
    expect(wrench.stdout()).toBe("media delegated output\n");
    expect(wrench.stderr()).toBe("");
  });

  test("keeps the KB inspection opaque while preserving JSON, terminal rendering, and readiness", async () => {
    const testState = state();
    const report = {
      fixtureSchema: "independent-from-kb-doctor-versions",
      nestedEvidence: { preserved: true },
    };
    let renderCalls = 0;
    const inspection: WrenchClipEnvironmentInspection = {
      report,
      renderReport: () => {
        renderCalls += 1;
        return "Opaque KB environment report\n";
      },
      browserCaptureBootstrapReady: true,
    };
    const dependencies = {
      inspectClipEnvironment: () => Promise.resolve(inspection),
      loadMediaRuntime: () => Promise.resolve(mediaRuntime()),
    };
    try {
      const json = capture();
      expect(await main(
        ["doctor", "--json"],
        testState.environment,
        json.output,
        dependencies,
      )).toBe(3);
      expect(JSON.parse(json.stdout())).toMatchObject({
        capture: report,
        wrench: { browserCaptureBootstrapReady: true },
      });
      expect(renderCalls).toBe(0);

      const text = capture();
      expect(await main(
        ["doctor"],
        testState.environment,
        text.output,
        dependencies,
      )).toBe(3);
      expect(text.stdout()).toContain("Opaque KB environment report");
      expect(text.stdout()).toContain("Browser capture/bootstrap: ready");
      expect(renderCalls).toBe(1);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("adds media evidence to doctor without making media readiness weaken action readiness", async () => {
    const environment = { ...process.env, WRENCH_STATE_HOME: state().directory };
    const clipInspection = clipEnvironmentInspection(
      true,
      "2026-07-21T00:00:00.000Z",
    );
    const mediaReport: MediaDoctorReport = {
      ok: false,
      checks: [],
      warnings: [],
      errors: ["yt-dlp is unavailable"],
      capabilities: {
        directHttp: true,
        acquisition: false,
        mediaSeparation: false,
        javascriptRuntime: false,
        localTranscription: false,
      },
    };
    const wrench = capture();
    try {
      const code = await main(["doctor", "--json"], environment, wrench.output, {
        inspectClipEnvironment: () => Promise.resolve(clipInspection),
        loadMediaRuntime: () => Promise.resolve(mediaRuntime({
          runDoctor: (options) => {
            expect(options?.env).toBe(environment);
            return Promise.resolve(mediaReport);
          },
        })),
      });

      expect(code).toBe(3);
      expect(JSON.parse(wrench.stdout())).toMatchObject({
        ok: false,
        media: mediaReport,
        wrench: {
          mediaArchiveReady: false,
          browserCaptureBootstrapReady: true,
          browserActionReady: false,
        },
      });
      expect(wrench.stderr()).toBe("");
    } finally {
      rmSync(environment.WRENCH_STATE_HOME, { recursive: true, force: true });
    }
  });

  test("reports official-provider readiness without requiring browser automation or exposing token metadata", async () => {
    const testState = state();
    const canonicalRoot = realpathSync(testState.directory);
    const tokenPath = join(canonicalRoot, "x-token.json");
    const scopes = ["tweet.read", "tweet.write", "users.read"] as const;
    const accessToken = "private-doctor-token-value";
    try {
      installManifest(xThreadManifest(), { force: false, environment: testState.environment });
      writeFileSync(tokenPath, JSON.stringify({
        schemaVersion: 1,
        provider: "x",
        subject: "12345",
        scopes,
        accessToken,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }), { mode: 0o600 });
      saveAuth(createAuth("x-official", {
        oauthProvider: "x",
        tokenFile: tokenPath,
        scopes,
        subject: "12345",
      }), testState.environment);
      const clipInspection = clipEnvironmentInspection(
        false,
        "2026-07-21T00:00:00.000Z",
      );
      const mediaReport: MediaDoctorReport = {
        ok: false,
        checks: [],
        warnings: [],
        errors: [],
        capabilities: {
          directHttp: true,
          acquisition: false,
          mediaSeparation: false,
          javascriptRuntime: false,
          localTranscription: false,
        },
      };
      const wrench = capture();
      expect(await main(["doctor", "--json"], testState.environment, wrench.output, {
        inspectClipEnvironment: () => Promise.resolve(clipInspection),
        loadMediaRuntime: () => Promise.resolve(mediaRuntime({
          runDoctor: () => Promise.resolve(mediaReport),
        })),
      })).toBe(0);
      const parsed = JSON.parse(wrench.stdout()) as {
        readonly oh: unknown;
        readonly wrench: unknown;
      };
      expect(parsed).toMatchObject({
        ok: true,
        wrench: {
          browserCaptureBootstrapReady: false,
          browserActionReady: false,
          providerApiReady: true,
          officialProviders: [
            { provider: "gmail", ready: false },
            { provider: "linkedin", ready: false },
            {
              provider: "x",
              adapters: ["x-thread"],
              auth: [{ id: "x-official", tokenReady: true, usableOperations: 1 }],
              ready: true,
            },
          ],
        },
      });
      expect(parsed.oh).toEqual(parsed.wrench);
      expect(wrench.stdout()).not.toContain(accessToken);
      expect(wrench.stdout()).not.toContain(tokenPath);
      expect(JSON.stringify(parsed.oh)).not.toContain(accessToken);
      expect(JSON.stringify(parsed.oh)).not.toContain(tokenPath);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("doctor authenticated API readiness", () => {
  test("reports observed LinkedIn private Article readiness independently from X", async () => {
    const testState = state();
    try {
      installManifest(bundledWebManifest("linkedin"), { force: false, environment: testState.environment });
      installManifest(bundledWebManifest("x"), { force: false, environment: testState.environment });
      saveAuth(createAuth("linkedin-bound", {
        source: "arc",
        subject: "urn:li:fsd_profile:12345",
      }), testState.environment);
      saveAuth(createAuth("x-unbound", { source: "arc", profile: "Profile 1" }), testState.environment);

      const linkedinReady = await runDoctor(testState);
      expect(linkedinReady.code).toBe(0);
      const linkedinReport = JSON.parse(linkedinReady.stdout) as {
        readonly wrench: {
          readonly webSessionSites: readonly {
            readonly site: string;
            readonly adapters: readonly string[];
            readonly observedOperations: readonly string[];
            readonly captureRequiredOperations: readonly string[];
            readonly accountBoundAuth: readonly string[];
            readonly ready: boolean;
          }[];
        };
      };
      expect(linkedinReport).toMatchObject({
        ok: true,
        wrench: {
          browserCaptureBootstrapReady: false,
          browserActionReady: false,
          providerApiReady: false,
          webSessionApiReady: true,
          webSessionAdapters: ["linkedin-web", "x-web"],
        },
      });
      expect(linkedinReport.wrench.webSessionSites.find((site) => site.site === "linkedin")).toEqual({
        site: "linkedin",
        adapters: ["linkedin-web"],
        observedOperations: [
          "articles.draft.save",
          "organizations.read",
          "posts.publish",
          "profiles.read",
        ],
        captureRequiredOperations: [
          "articles.publish",
          "articles.read",
          "comments.create",
          "comments.read",
          "contacts.list",
          "feeds.read",
          "media.publish",
          "messaging.list",
          "messaging.read",
          "messaging.send",
          "posts.quote",
          "posts.read",
          "posts.repost",
          "reactions.set",
          "relationships.connect",
          "relationships.recommendations.read",
          "replies.create",
        ],
        accountBoundAuth: ["linkedin-bound"],
        ready: true,
      });
      expect(linkedinReport.wrench.webSessionSites.find((site) => site.site === "x")).toMatchObject({
        site: "x",
        adapters: ["x-web"],
        observedOperations: [
          "articles.draft.save",
          "comments.read",
          "content.save",
          "feeds.read",
          "likes.set",
          "posts.publish",
          "posts.read",
          "profiles.read",
        ],
        accountBoundAuth: [],
        ready: false,
      });

      saveAuth(createAuth("x-bound", { source: "arc", subject: "2244994945" }), testState.environment);
      const ready = await runDoctor(testState);
      expect(ready.code).toBe(0);
      const readyReport = JSON.parse(ready.stdout) as {
        readonly wrench: {
          readonly webSessionSites: readonly {
            readonly site: string;
            readonly accountBoundAuth: readonly string[];
            readonly observedOperations: readonly string[];
            readonly captureRequiredOperations: readonly string[];
            readonly ready: boolean;
          }[];
        };
      };
      expect(readyReport).toMatchObject({
        ok: true,
        wrench: {
          browserCaptureBootstrapReady: false,
          browserActionReady: false,
          providerApiReady: false,
          webSessionApiReady: true,
        },
      });
      const readyLinkedIn = readyReport.wrench.webSessionSites.find((site) => site.site === "linkedin");
      expect(readyLinkedIn).toMatchObject({
        accountBoundAuth: ["linkedin-bound"],
        observedOperations: [
          "articles.draft.save",
          "organizations.read",
          "posts.publish",
          "profiles.read",
        ],
        ready: true,
      });
      expect(readyLinkedIn?.captureRequiredOperations).toContain("messaging.list");
      expect(readyReport.wrench.webSessionSites.find((site) => site.site === "x")).toMatchObject({
        accountBoundAuth: ["x-bound"],
        ready: true,
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reports same-boot authenticated-web cleanup uncertainty as unresolved recovery state", async () => {
    const testState = state();
    try {
      const selectedManifest = bundledWebManifest("x");
      installManifest(selectedManifest, {
        force: false,
        environment: testState.environment,
      });
      const selectedAuth = createAuth("x-bound", {
        source: "arc",
        subject: "2244994945",
      });
      saveAuth(selectedAuth, testState.environment);
      const admission = acquireWebSessionCleanupAdmission(
        {
          runId: "00000000-0000-4000-8000-000000000001",
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

      const diagnosed = await runDoctor(testState);
      expect(diagnosed.code).toBe(3);
      expect(JSON.parse(diagnosed.stdout)).toMatchObject({
        ok: false,
        wrench: {
          webSessionApiReady: true,
          webSessionCleanupAdmissionRecovery: {
            scanned: 1,
            repaired: 0,
            retained: 1,
            invalid: 0,
            issues: [{ kind: "cleanup-unsafe" }],
          },
        },
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reports schema-v5 generic templates as inert derivation reservations", async () => {
    const testState = state();
    try {
      installManifest(reviewedTemplateReservationManifest(), { force: false, environment: testState.environment });
      saveAuth(createAuth("profile-only", {
        browserProfile: "Default",
        trustUnfilteredEgress: true,
      }), testState.environment);

      const incompatible = await runDoctor(testState);
      expect(incompatible.code).toBe(3);
      expect(JSON.parse(incompatible.stdout)).toMatchObject({
        ok: false,
        wrench: {
          webSessionApiReady: false,
          reviewedTemplateApiReady: false,
          reviewedTemplateReservations: {
            mode: "derivation-reservation-only",
            adapters: ["example-api"],
            operations: ["example-api/content.read"],
            executable: false,
            requiredContract: "reviewed-template-v2-current-account-preflight",
          },
        },
      });

      saveAuth(createAuth("arc-cookie", { source: "arc" }), testState.environment);
      const stillInert = await runDoctor(testState);
      expect(stillInert.code).toBe(3);
      expect(JSON.parse(stillInert.stdout)).toMatchObject({
        ok: false,
        wrench: {
          webSessionApiReady: false,
          reviewedTemplateApiReady: false,
          reviewedTemplateReservations: {
            mode: "derivation-reservation-only",
            adapters: ["example-api"],
            operations: ["example-api/content.read"],
            executable: false,
            requiredContract: "reviewed-template-v2-current-account-preflight",
          },
        },
      });

      const text = await runDoctor(testState, false);
      expect(text.code).toBe(3);
      expect(text.stdout).toContain("Generic internal-API derivation: reservation-only");
      expect(text.stdout).toContain("Generic internal-API execution: not available (reviewed-template v2 account preflight required)");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("provider source plugin discovery CLI", () => {
  test("lists the validated static registry without exposing executable callbacks or file URLs", async () => {
    const testState = state();
    try {
      const wrench = capture();
      expect(await main(
        ["plugin", "list", "--json"],
        testState.environment,
        wrench.output,
      )).toBe(0);
      expect(wrench.stderr()).toBe("");
      const view = JSON.parse(wrench.stdout()) as {
      readonly ok: boolean;
      readonly kind: string;
      readonly trustBoundary: {
        readonly sourceExecution: string;
        readonly portableExecution: string;
        readonly sandboxed: boolean;
        readonly installedExecutablePlugins: boolean;
        readonly sourceRegistry: string;
        readonly portableRegistry: string;
        readonly installedCapabilitiesCommand: string;
      };
      readonly plugins: readonly {
        readonly id: string;
        readonly sourceKind: string;
        readonly bindingCount: number;
        readonly operationCount: number;
        readonly transports: readonly string[];
      readonly surfaces: readonly string[];
      }[];
      };
      expect(view).toMatchObject({
        ok: true,
        kind: "provider-plugin-list",
        trustBoundary: {
          sourceExecution: "trusted-in-process",
          portableExecution: "trusted-child-process",
          sandboxed: false,
          installedExecutablePlugins: true,
          sourceRegistry: "static-source",
          portableRegistry: "private-content-addressed",
          installedCapabilitiesCommand: "wrench capabilities [adapter]",
        },
      });
      expect(view.plugins.length).toBeGreaterThan(0);
      expect(view.plugins.map((plugin) => plugin.id)).toEqual(
        [...view.plugins.map((plugin) => plugin.id)].sort(),
      );
      expect(view.plugins.find((plugin) => plugin.id === "meta-web"))
        .toMatchObject({
          sourceKind: "built-in",
          bindingCount: 6,
          transports: ["web-session-api"],
          surfaces: [
            "facebook",
            "facebook-group",
            "facebook-marketplace",
            "facebook-page",
            "instagram",
            "threads",
          ],
        });
      expect(wrench.stdout()).not.toContain('"execute"');
      expect(wrench.stdout()).not.toContain('"matches"');
      expect(wrench.stdout()).not.toContain("file://");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("shows one plugin's safe route, subject, operation, and implementation metadata", async () => {
    const testState = state();
    try {
      const wrench = capture();
      expect(await main(
        ["plugins", "show", "x-web", "--json"],
        testState.environment,
        wrench.output,
      )).toBe(0);
      expect(wrench.stderr()).toBe("");
      const view = JSON.parse(wrench.stdout()) as {
        readonly plugin: {
          readonly id: string;
          readonly implementationSources: readonly string[];
          readonly bindings: readonly {
            readonly transport: string;
            readonly surfaceId: string;
            readonly origin: string;
            readonly authKinds: readonly string[];
            readonly subject: {
              readonly format: string;
              readonly hasCurrentSubjectProbe: boolean;
            };
            readonly operations: readonly {
              readonly name: string;
              readonly contractVersions: readonly number[];
            }[];
          }[];
        };
      };
      expect(view.plugin.id).toBe("x-web");
      expect(view.plugin.implementationSources).toContain("plugin.ts");
      expect(view.plugin.bindings).toHaveLength(1);
      expect(view.plugin.bindings[0]).toMatchObject({
        transport: "web-session-api",
        surfaceId: "x",
        origin: "https://x.com",
        authKinds: ["browser-profile", "cookie-source", "cookies-file"],
        subject: {
          format: "1–19 digit X account ID",
          hasCurrentSubjectProbe: true,
        },
      });
      expect(view.plugin.bindings[0]?.operations.some((operation) =>
        operation.name === "feeds.read"
        && operation.contractVersions.length === 1
        && operation.contractVersions[0] === 1
      )).toBeTrue();
      expect(wrench.stdout()).not.toContain('"execute"');
      expect(wrench.stdout()).not.toContain('"probe"');
      expect(wrench.stdout()).not.toContain("file://");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("shows every credential-bearing origin for an official provider", async () => {
    const testState = state();
    try {
      const wrench = capture();
      expect(await main(
        ["plugin", "show", "gmail-official", "--json"],
        testState.environment,
        wrench.output,
      )).toBe(0);
      expect(wrench.stderr()).toBe("");
      const view = JSON.parse(wrench.stdout()) as {
        readonly plugin: {
          readonly bindings: readonly {
            readonly origin: string;
            readonly runtimeOrigins?: readonly string[];
          }[];
        };
      };
      expect(view.plugin.bindings[0]).toMatchObject({
        origin: "https://gmail.googleapis.com",
        runtimeOrigins: [
          "https://gmail.googleapis.com",
          "https://people.googleapis.com",
        ],
      });
      expect(wrench.stdout()).not.toContain('"execute"');
      expect(wrench.stdout()).not.toContain('"accessToken"');
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("renders Wrench as the program and reports an unknown plugin distinctly", async () => {
    const testState = state();
    try {
      const listed = capture();
      expect(await main(
        ["plugin", "list"],
        testState.environment,
        listed.output,
      )).toBe(0);
      expect(listed.stderr()).toBe("");
      expect(listed.stdout()).toStartWith(
        "Wrench trusted provider source plugins",
      );
      expect(listed.stdout()).toContain(
        "Wrench installed portable provider plugins",
      );
      expect(listed.stdout()).toContain("Run 'wrench plugin show <id>'");
      expect(listed.stdout()).toContain("Run 'wrench capabilities [adapter]'");

      const missing = capture();
      expect(await main(
        ["plugin", "show", "missing-plugin"],
        testState.environment,
        missing.output,
      )).toBe(3);
      expect(missing.stderr()).toBe("");
      expect(missing.stdout()).toBe(
        "Wrench provider plugin missing-plugin was not found.\n"
        + "Run 'wrench plugin list' to inspect source and portable plugins.\n",
      );
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("reviewed platform policy helpers", () => {
  test("reports official-provider transport, scope alternatives, coverage, and contract identity", async () => {
    const testState = state();
    try {
      installManifest(xThreadManifest(), { force: false, environment: testState.environment });
      const wrench = capture();
      expect(await main(["capabilities", "x-thread", "--json"], testState.environment, wrench.output)).toBe(0);
      const view = JSON.parse(wrench.stdout()) as {
        readonly adapters: readonly {
          readonly operations: readonly Record<string, unknown>[];
        }[];
      };
      expect(view.adapters[0]?.operations).toHaveLength(1);
      const operation = view.adapters[0]?.operations[0];
      expect(operation).toMatchObject({
        id: "threads.publish",
        transport: "provider-api",
        provider: "x",
        providerAction: "threads.publish",
        providerContractVersion: 1,
        requiredScopeSets: [["tweet.read", "tweet.write", "users.read"]],
        coverage: ["write-result"],
      });
      expect(operation?.providerContractHash).toBeString();
      expect(operation?.providerContractHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(wrench.stdout()).toContain("sequential POST /2/tweets");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps reviewed URL-form OAuth scopes exact in capability JSON", async () => {
    const testState = state();
    const manifestPath = join(
      import.meta.dir,
      "assets",
      "adapters",
      "gmail",
      "wrench-adapter.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as WrenchManifest;
    try {
      installManifest(manifest, {
        force: false,
        environment: testState.environment,
      });
      const wrench = capture();
      expect(await main(
        ["capabilities", "gmail", "--json"],
        testState.environment,
        wrench.output,
      )).toBe(0);
      const view = JSON.parse(wrench.stdout()) as {
        readonly adapters: readonly {
          readonly operations: readonly {
            readonly id: string;
            readonly requiredScopeSets?: readonly (readonly string[])[];
          }[];
        }[];
      };
      const contacts = view.adapters[0]?.operations.find(
        (operation) => operation.id === "contacts.list",
      );
      expect(contacts?.requiredScopeSets?.every((scopeSet) =>
        scopeSet.includes(
          "https://www.googleapis.com/auth/contacts.other.readonly",
        ))).toBeTrue();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("validates, installs, and lists an injected official-provider plugin through the public CLI", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wrench-cli-plugin-manifest-"));
    chmodSync(sourceDirectory, 0o700);
    const surfaceId = "synthetic-cli-official";
    const operation: ProviderApiPluginOperationDefinitionV1 = {
      name: "records.read",
      contractVersion: 1,
      risk: "R1",
      input: {
        properties: {},
        required: [],
      },
      sideEffect: "none",
      idempotency: "none",
      dedupeWindowMs: 0,
      state: "observed",
      dispatch: "none",
      implementation: "synthetic CLI provider read",
      planDispatches: () => [],
      validateInput: (input) => Object.keys(input).length === 0
        ? []
        : ["synthetic CLI provider accepts no input"],
      requiredScopeSets: [["records.read"]],
      coverage: ["records"],
    };
    let runtimeLoads = 0;
    const registry = createProviderPluginRegistry([
      defineProviderPlugin({
        apiVersion: 1,
        id: "synthetic-cli-official-plugin",
        version: "1.0.0",
        displayName: "Synthetic CLI Official Plugin",
        sourceKind: "source",
        implementationSources: [{
          label: "plugin.ts",
          url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
        }],
        bindings: [{
          transport: "provider-api",
          surfaceId,
          origin: "https://api.synthetic-cli-official.example",
          manifestOrigins: ["https://synthetic-cli-official.example"],
          authKinds: ["oauth-token-file"],
          operations: [operation],
          subject: {
            format: "synthetic-cli-official:<id>",
            matches: (value) =>
              /^synthetic-cli-official:[a-z0-9-]{1,40}$/u.test(value),
          },
          runtime: lazyProviderApiRuntime(() => {
            runtimeLoads += 1;
            return Promise.resolve({
              execute: () => Promise.resolve(),
            });
          }),
        }],
      }),
    ]);
    const manifestPath = join(sourceDirectory, "wrench-adapter.json");
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 3,
      id: "synthetic-cli-official-adapter",
      version: "1.0.0",
      displayName: "Synthetic CLI Official Adapter",
      surfaceId,
      origins: ["https://synthetic-cli-official.example"],
      browserDomains: ["synthetic-cli-official.example"],
      operations: {
        [operation.name]: {
          description: operation.implementation,
          risk: operation.risk,
          sideEffect: operation.sideEffect,
          idempotency: operation.idempotency,
          dedupeWindowMs: operation.dedupeWindowMs,
          input: operation.input,
          provider: {
            provider: surfaceId,
            action: operation.name,
            contractVersion: operation.contractVersion,
            timeoutMs: 60_000,
            maxOutputBytes: 1_024,
          },
        },
      },
    }), { encoding: "utf8", mode: 0o600 });
    const dependencies = { providerPluginRegistry: registry };
    try {
      const validated = capture();
      expect(await main([
        "adapter",
        "validate",
        manifestPath,
        "--json",
      ], testState.environment, validated.output, dependencies)).toBe(0);
      expect(JSON.parse(validated.stdout())).toMatchObject({
        ok: true,
        id: "synthetic-cli-official-adapter",
        operations: ["records.read"],
      });
      expect(validated.stderr()).toBe("");

      const installed = capture();
      expect(await main([
        "adapter",
        "install",
        manifestPath,
      ], testState.environment, installed.output, dependencies)).toBe(0);
      expect(installed.stdout()).toContain(
        "Installed synthetic-cli-official-adapter",
      );
      expect(installed.stderr()).toBe("");

      saveAuth(createAuth("synthetic-cli-file-auth", {
        oauthProvider: surfaceId,
        tokenFile: join(testState.directory, "synthetic-token.json"),
        scopes: ["records.read"],
        subject: "synthetic-cli-official:account",
      }), testState.environment);
      const identity = capture();
      expect(await main([
        "invoke",
        "synthetic-cli-official-adapter",
        "records.read",
        "--input",
        "{}",
        "--auth",
        "synthetic-cli-file-auth",
        "--projection-identity-only",
        "--json",
      ], testState.environment, identity.output, dependencies)).toBe(0);
      const identityView = JSON.parse(identity.stdout()) as {
        readonly ok: unknown;
        readonly source: unknown;
        readonly status: unknown;
        readonly authIdentity: unknown;
        readonly authHash: unknown;
        readonly inputHash: unknown;
        readonly projection: { readonly key: unknown };
      };
      expect(identityView).toMatchObject({
        ok: true,
        source: "projection-identity",
        status: "ready",
        authHash: sha256(canonicalJson(loadAuth(
          "synthetic-cli-file-auth",
          testState.environment,
        ))),
        inputHash: sha256(canonicalJson({})),
      });
      expect(Object.keys(identityView).sort()).toEqual([
        "authHash",
        "authIdentity",
        "inputHash",
        "ok",
        "projection",
        "source",
        "status",
      ]);
      expect(identityView.projection.key).toBeString();
      expect(identityView.projection.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(identityView.authIdentity).toBeString();
      expect(identityView.authIdentity).toMatch(/^[a-f0-9]{64}$/u);
      expect(identity.stderr()).toBe("");
      expect(runtimeLoads).toBe(0);

      const listed = capture();
      expect(await main([
        "capabilities",
        "synthetic-cli-official-adapter",
        "--json",
      ], testState.environment, listed.output, dependencies)).toBe(0);
      expect(JSON.parse(listed.stdout())).toMatchObject({
        ok: true,
        adapters: [{
          id: "synthetic-cli-official-adapter",
          surfaceId,
          operations: [{
            id: "records.read",
            transport: "provider-api",
            provider: surfaceId,
            providerAction: "records.read",
            providerContractVersion: 1,
            requiredScopeSets: [["records.read"]],
            coverage: ["records"],
          }],
        }],
      });
      expect(listed.stderr()).toBe("");
      expect(runtimeLoads).toBe(0);

      const loaded = loadInstalledManifest(
        "synthetic-cli-official-adapter",
        testState.environment,
        registry,
      );
      expect(loaded.ok).toBeTrue();
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("checks adapter ownership from a catalog rebuilt under the mutation lock", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(
      join(tmpdir(), "wrench-cli-adapter-lock-catalog-test-"),
    );
    const owned = reviewedTemplateReservationManifest();
    const manifestPath = join(sourceDirectory, "wrench-adapter.json");
    writeFileSync(
      manifestPath,
      `${canonicalJson(owned)}\n`,
      { mode: 0o600 },
    );
    const sourceRegistry = createProviderPluginRegistry([]);
    const ownedRegistry: ProviderPluginRegistry = Object.freeze({
      ...sourceRegistry,
      listOwnedManifests: () => Object.freeze([owned]),
      resolveOwnedManifest: (adapterId) =>
        adapterId === owned.id
          ? owned
          : sourceRegistry.resolveOwnedManifest(adapterId),
    });
    let catalogLoads = 0;
    try {
      const wrench = capture();
      expect(await main(
        ["adapter", "install", manifestPath],
        testState.environment,
        wrench.output,
        {
          providerPluginRegistry: sourceRegistry,
          createPortableProviderPluginCatalog: (registry, environment) => {
            catalogLoads += 1;
            expect(existsSync(join(
              portableProviderPluginStoreRoot(environment),
              "locks",
              ".catalog-mutation.lock",
            ))).toBeTrue();
            const catalog = buildPortableProviderPluginCatalog(
              registry,
              environment,
            );
            return Object.freeze({ ...catalog, registry: ownedRegistry });
          },
        },
      )).toBe(3);
      expect(catalogLoads).toBe(1);
      expect(wrench.stderr()).toContain(
        "adapter example-api is owned by an enabled portable provider plugin",
      );
      expect(existsSync(
        adapterManifestPath("example-api", testState.environment),
      )).toBeFalse();
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("uses one active portable catalog for adapter validation, installation, and HAR derivation", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(
      join(tmpdir(), "wrench-cli-active-portable-catalog-test-"),
    );
    const manifestPath = join(sourceDirectory, "wrench-adapter.json");
    const harPath = join(sourceDirectory, "capture.har");
    const outputDirectory = join(sourceDirectory, "derived");
    writeFileSync(manifestPath, `${canonicalJson({
      schemaVersion: 5,
      id: "portable-catalog-reservation",
      version: "0.1.0",
      displayName: "Portable Catalog Reservation",
      origins: ["https://portable-catalog.example"],
      browserDomains: ["portable-catalog.example"],
      operations: {},
    })}\n`, { mode: 0o600 });
    writeFileSync(
      harPath,
      `${canonicalJson({ log: { entries: [] } })}\n`,
      { mode: 0o600 },
    );
    const activeRegistry = registryProtectingPortableCatalogFixture();
    let catalogLoads = 0;
    const dependencies = {
      inspectClipEnvironment: () => Promise.resolve(clipEnvironmentInspection()),
      loadMediaRuntime: () => Promise.resolve(mediaRuntime()),
      createPortableProviderPluginCatalog: (
        registry: ProviderPluginRegistry,
        environment: Readonly<Record<string, string | undefined>> = process.env,
      ) => {
        catalogLoads += 1;
        const catalog = buildPortableProviderPluginCatalog(
          registry,
          environment,
        );
        return Object.freeze({ ...catalog, registry: activeRegistry });
      },
    };
    try {
      const validated = capture();
      expect(await main(
        ["adapter", "validate", manifestPath, "--json"],
        testState.environment,
        validated.output,
        dependencies,
      )).toBe(2);
      expect(JSON.parse(validated.stdout())).toMatchObject({
        ok: false,
        issues: [expect.stringContaining(
          "reviewed-template reservations are prohibited on protected signed-in site hostname",
        )],
      });

      const installed = capture();
      expect(await main(
        ["adapter", "install", manifestPath],
        testState.environment,
        installed.output,
        dependencies,
      )).toBe(3);
      expect(installed.stderr()).toContain(
        "reviewed-template reservations are prohibited on protected signed-in site hostname",
      );
      expect(existsSync(adapterManifestPath(
        "portable-catalog-reservation",
        testState.environment,
      ))).toBeFalse();

      const derived = capture();
      expect(await main([
        "derive",
        "analyze",
        harPath,
        "--adapter",
        "portable-catalog-derived",
        "--origin",
        "https://portable-catalog.example",
        "--output",
        outputDirectory,
        "--json",
      ], testState.environment, derived.output, dependencies)).toBe(0);
      expect(JSON.parse(derived.stdout())).toMatchObject({
        ok: true,
        manifestPath: join(outputDirectory, "wrench-adapter.json"),
      });
      expect(JSON.parse(
        readFileSync(join(outputDirectory, "wrench-adapter.json"), "utf8"),
      )).toMatchObject({
        schemaVersion: 4,
        origins: ["https://portable-catalog.example"],
      });
      expect(JSON.parse(
        readFileSync(
          join(outputDirectory, "reviewed-template.reservation.json"),
          "utf8",
        ),
      )).toMatchObject({
        targetManifestSchemaVersion: 4,
      });

      const diagnosed = capture();
      expect(await main(
        ["doctor", "--json"],
        testState.environment,
        diagnosed.output,
        dependencies,
      )).toBe(3);
      const doctorReport = JSON.parse(diagnosed.stdout()) as {
        readonly wrench: {
          readonly officialProviders: readonly {
            readonly provider: string;
          }[];
        };
      };
      expect(doctorReport.wrench.officialProviders.find(
        (provider) =>
          provider.provider === "portable-catalog-fixture",
      )).toMatchObject({
        provider: "portable-catalog-fixture",
      });
      expect(catalogLoads).toBe(4);
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("renders policy separately from installed capabilities", async () => {
    const testState = state();
    try {
      const json = capture();
      expect(await main(["platforms", "x", "--json"], testState.environment, json.output)).toBe(0);
      const view = JSON.parse(json.stdout()) as {
        readonly kind: string;
        readonly policyOnly: boolean;
        readonly installationStatus: string;
        readonly notice: string;
        readonly surfaces: readonly Record<string, unknown>[];
      };
      expect(view).toMatchObject({
        kind: "reviewed-platform-policy",
        policyOnly: true,
        installationStatus: "not-evaluated",
      });
      expect(view.notice).toContain("does not mean an adapter or capability is installed");
      expect(view.surfaces).toHaveLength(1);
      expect(view.surfaces[0]).toMatchObject({
        id: "x",
        operations: { "posts.publish": { state: "adapter-eligible", risk: "R3" } },
      });

      const installed = capture();
      expect(await main(["capabilities", "x", "--json"], testState.environment, installed.output)).toBe(3);
      expect(JSON.parse(installed.stdout())).toEqual({ ok: false, adapters: [] });

      const text = capture();
      expect(await main(["platforms", "facebook-marketplace"], testState.environment, text.output)).toBe(0);
      expect(text.stdout()).toContain("reviewed platform policy");
      expect(text.stdout()).toContain("adapter-eligible does not mean");
      expect(text.stdout()).toContain("Facebook Marketplace (facebook-marketplace)");
      expect(text.stdout()).toContain("listings.publish (R3)");
      expect(text.stderr()).toBe("");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps the archived LinkedIn DOM adapter diagnostic-only while migrating its exact installed hash", async () => {
    const testState = state();
    const oldPath = join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.v0.4.0.json");
    const newPath = join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.json");
    const oldManifest = JSON.parse(readFileSync(oldPath, "utf8")) as WrenchManifest;
    const newManifest = JSON.parse(readFileSync(newPath, "utf8")) as WrenchManifest;
    try {
      expect(() => installManifest(oldManifest, { force: false, environment: testState.environment }))
        .toThrow("runtime DOM action recipes are disabled");
      const retired = capture();
      expect(await main([
        "adapter", "validate", oldPath, "--json",
      ], testState.environment, retired.output)).toBe(2);
      const retiredView = JSON.parse(retired.stdout()) as { readonly ok: boolean; readonly issues: readonly string[] };
      expect(retiredView.ok).toBeFalse();
      expect(retiredView.issues).toHaveLength(2);
      expect(retiredView.issues.every((issue) => issue.includes("runtime DOM action recipes are disabled"))).toBeTrue();

      installManifest(newManifest, { force: false, environment: testState.environment });
      writeFileSync(
        adapterManifestPath("linkedin", testState.environment),
        `${canonicalJson(oldManifest)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      const beforeMigration = loadInstalledManifest("linkedin", testState.environment);
      expect(beforeMigration.ok).toBeFalse();

      const installedOutput = capture();
      expect(await main([
        "adapter", "install", newPath, "--upgrade-from", oldPath,
      ], testState.environment, installedOutput.output)).toBe(0);
      const installed = loadInstalledManifest("linkedin", testState.environment);
      expect(installed.ok).toBeTrue();
      if (!installed.ok) throw new Error(installed.issues.join("; "));
      expect(installed.value).toMatchObject({ schemaVersion: 3, id: "linkedin", version: "1.1.0" });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("splits inline and file text within reviewed bounds with an exact JSON round trip", async () => {
    const testState = state();
    try {
      const inlineText = `${"🙂".repeat(200)}\u202eright`;
      const inline = capture();
      expect(await main([
        "thread", "split", "x", "--text", inlineText, "--json",
      ], testState.environment, inline.output)).toBe(0);
      expect(hasUnsafeTerminalCharacters(inline.stdout())).toBeFalse();
      const inlineView = JSON.parse(inline.stdout()) as {
        readonly published: boolean;
        readonly localSplitRequiresInstalledCapability: boolean;
        readonly publicationInstallationStatus: string;
        readonly notice: string;
        readonly exactRoundTrip: boolean;
        readonly maxWeightedLength: number;
        readonly chunks: readonly { readonly text: string; readonly weightedLength: number }[];
      };
      expect(inlineView).toMatchObject({
        published: false,
        localSplitRequiresInstalledCapability: false,
        publicationInstallationStatus: "not-evaluated",
        exactRoundTrip: true,
        maxWeightedLength: 280,
      });
      expect(inlineView.notice).toContain("Publishing still requires");
      expect(inlineView.chunks.map((chunk) => chunk.text).join("")).toBe(inlineText);
      expect(inlineView.chunks.every((chunk) => chunk.weightedLength <= inlineView.maxWeightedLength)).toBeTrue();

      const fileText = `${"e\u0301".repeat(300)}\nfinal`;
      const path = join(testState.directory, "thread.txt");
      writeFileSync(path, fileText, { encoding: "utf8", mode: 0o600 });
      const fromFile = capture();
      expect(await main([
        "thread", "split", "bluesky", "--text", `@${path}`, "--json",
      ], testState.environment, fromFile.output)).toBe(0);
      const fileView = JSON.parse(fromFile.stdout()) as {
        readonly chunks: readonly { readonly text: string }[];
      };
      expect(fileView.chunks.map((chunk) => chunk.text).join("")).toBe(fileText);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("turns a local split into one exact confirmed thread plan", async () => {
    const testState = state();
    try {
      installManifest(xThreadManifest(), { force: false, environment: testState.environment });
      saveAuth(createAuth("example", {
        oauthProvider: "x",
        tokenFile: join(testState.directory, "x-token.json"),
        scopes: ["tweet.read", "tweet.write", "users.read"],
        subject: "12345",
      }), testState.environment);
      const text = `${"a".repeat(280)}${"b".repeat(120)}`;
      const output = capture();
      expect(await main([
        "thread", "publish", "x",
        "--adapter", "x-thread",
        "--text", text,
        "--auth", "example",
        "--preview",
        "--json",
      ], testState.environment, output.output)).toBe(0);
      const preview = JSON.parse(output.stdout()) as {
        readonly digest: string;
        readonly operation: string;
        readonly input: { readonly items: readonly string[] };
        readonly dispatches: readonly { readonly id: string }[];
        readonly thread: { readonly surfaceId: string; readonly items: number; readonly exactRoundTrip: boolean };
      };
      expect(preview).toMatchObject({
        operation: "threads.publish",
        thread: { surfaceId: "x", items: 2, exactRoundTrip: true },
      });
      expect(preview.input.items.join("")).toBe(text);
      expect(preview.dispatches.map(({ id }) => id)).toEqual(["publish-item[1]", "publish-item[2]"]);

      expect(await main([
        "plans", "cancel", preview.digest, "--yes",
      ], testState.environment, capture().output)).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("fails closed for surfaces without native thread policy and over-cap drafts", async () => {
    const testState = state();
    try {
      const unsupported = capture();
      expect(await main([
        "thread", "split", "reddit", "--text", "draft",
      ], testState.environment, unsupported.output)).toBe(3);
      expect(unsupported.stderr()).toContain("thread publishing is not-applicable");

      const tooMany = capture();
      expect(await main([
        "thread", "split", "x", "--text", "🙂".repeat(3_501), "--json",
      ], testState.environment, tooMany.output)).toBe(3);
      expect(tooMany.stderr()).toContain("more than the reviewed 25-item limit");

      const oversizedPath = join(testState.directory, "oversized-thread.txt");
      writeFileSync(oversizedPath, "a".repeat(64 * 1024 + 1), { encoding: "utf8", mode: 0o600 });
      const oversized = capture();
      expect(await main([
        "thread", "split", "x", "--text", `@${oversizedPath}`,
      ], testState.environment, oversized.output)).toBe(3);
      expect(oversized.stderr()).toContain("no larger than 65536 bytes");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("initializes an empty manifest from exact catalog origins without installing it", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(
      join(tmpdir(), "wrench-cli-adapter-init-test-"),
    );
    try {
      const directory = join(sourceDirectory, "youtube-adapter");
      const initialized = capture();
      expect(await main([
        "adapter", "init", "youtube-publisher", "--platform", "youtube", "--output", directory,
      ], testState.environment, initialized.output)).toBe(0);
      const manifest = JSON.parse(readFileSync(join(directory, "wrench-adapter.json"), "utf8")) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        id: "youtube-publisher",
        displayName: "YouTube",
        surfaceId: "youtube",
        origins: ["https://www.youtube.com", "https://studio.youtube.com"],
        browserDomains: ["www.youtube.com", "studio.youtube.com"],
        operations: {},
      });
      expect(initialized.stdout()).toContain("empty, uninstalled manifest");
      const validation = capture();
      expect(await main([
        "adapter", "validate", join(directory, "wrench-adapter.json"), "--json",
      ], testState.environment, validation.output)).toBe(0);
      expect(JSON.parse(validation.stdout())).toMatchObject({ ok: true, id: "youtube-publisher", operations: [] });

      expect(existsSync(join(testState.directory, "adapters", "youtube-publisher.json"))).toBeFalse();

      const substackDirectory = join(sourceDirectory, "substack-adapter");
      const substackOutput = capture();
      expect(await main([
        "adapter", "init", "substack-reader", "--platform", "substack", "--output", substackDirectory,
      ], testState.environment, substackOutput.output)).toBe(0);
      const substack = JSON.parse(readFileSync(join(substackDirectory, "wrench-adapter.json"), "utf8")) as Record<string, unknown>;
      expect(substack).toMatchObject({
        surfaceId: "substack",
        origins: ["https://substack.com", "https://www.substack.com"],
        browserDomains: ["substack.com", "www.substack.com"],
        operations: {},
      });
      expect(substackOutput.stdout()).toContain("No custom publication origin was inferred");

      const customDirectory = join(sourceDirectory, "custom-adapter");
      expect(await main([
        "adapter", "init", "newsletter", "--origin", "https://letters.example.com", "--output", customDirectory,
      ], testState.environment, capture().output)).toBe(0);
      const custom = JSON.parse(readFileSync(join(customDirectory, "wrench-adapter.json"), "utf8")) as Record<string, unknown>;
      expect(custom).toMatchObject({
        origins: ["https://letters.example.com"],
        browserDomains: ["letters.example.com"],
      });

      const inferredDirectory = join(sourceDirectory, "x-adapter");
      expect(await main([
        "adapter", "init", "x-reader", "--origin", "https://x.com", "--output", inferredDirectory,
      ], testState.environment, capture().output)).toBe(0);
      const inferred = JSON.parse(readFileSync(join(inferredDirectory, "wrench-adapter.json"), "utf8")) as Record<string, unknown>;
      expect(inferred).toMatchObject({
        surfaceId: "x",
        origins: ["https://x.com"],
        browserDomains: ["x.com"],
      });

      const ambiguousDirectory = join(testState.directory, "ambiguous-facebook-adapter");
      const ambiguous = capture();
      expect(await main([
        "adapter", "init", "facebook-reader", "--origin", "https://www.facebook.com", "--output", ambiguousDirectory,
      ], testState.environment, ambiguous.output)).toBe(3);
      expect(ambiguous.stderr()).toContain("select one with --platform");
      expect(existsSync(ambiguousDirectory)).toBeFalse();
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("CLI previews and exit semantics", () => {
  test("renders cache hits, misses, and live revalidation as distinct read sources", () => {
    const cacheKey = "d".repeat(64);
    const dataRevision = "e".repeat(64);
    const output = {
      messages: [{ id: "message-1", text: "persisted message" }],
    };
    const cached = {
      status: "hit",
      source: "cache",
      key: cacheKey,
      output,
      dataRevision,
      createdAt: "2026-07-31T12:00:00.000Z",
      dataChangedAt: "2026-07-31T12:00:00.000Z",
      validatedAt: "2026-07-31T12:05:00.000Z",
      runId: "00000000-0000-4000-8000-000000000001",
      ageMs: 30_000,
      freshness: { state: "fresh", freshForMs: 60_000 },
    } satisfies Parameters<typeof cachedInvocationView>[0];

    expect(cachedInvocationView(cached)).toEqual({
      ok: true,
      status: "cached",
      source: "cache",
      projection: {
        key: cacheKey,
        dataRevision,
        createdAt: "2026-07-31T12:00:00.000Z",
        dataChangedAt: "2026-07-31T12:00:00.000Z",
        validatedAt: "2026-07-31T12:05:00.000Z",
        runId: "00000000-0000-4000-8000-000000000001",
        ageMs: 30_000,
        freshness: { state: "fresh", freshForMs: 60_000 },
      },
      output,
    });
    expect(cachedInvocationView({ status: "miss", key: cacheKey })).toEqual({
      ok: false,
      status: "cache-miss",
      source: "cache",
      projection: { key: cacheKey },
    });

    const live: InvocationResult = {
      receipt: {
        schemaVersion: 3,
        runId: "00000000-0000-4000-8000-000000000002",
        planDigest: null,
        adapter: { id: "x", version: "1.0.0", hash: "a".repeat(64) },
        operation: "posts.read",
        risk: "R1",
        inputHash: "b".repeat(64),
        auth: { id: "x-official", hash: "c".repeat(64), kind: "oauth-token-file" },
        transport: "provider-api",
        providerContractHash: "f".repeat(64),
        status: "succeeded",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
        startedAt: "2026-07-31T12:06:00.000Z",
        finishedAt: "2026-07-31T12:06:01.000Z",
        finalOrigin: "https://api.x.com",
        error: null,
      },
      output: { messages: [{ id: "message-2", text: "live message" }] },
      replayed: false,
      privateArtifactsPreserved: false,
    };
    const revalidated = revalidatedInvocationView({
      cachedBefore: cached,
      live,
      cache: {
        status: "stored",
        publication: {
          key: cacheKey,
          dataRevision: "f".repeat(64),
          validatedAt: "2026-07-31T12:06:01.000Z",
          dataChangedAt: "2026-07-31T12:06:01.000Z",
          disposition: "changed",
        },
      },
    });
    expect(revalidated).toMatchObject({
      ok: true,
      status: "succeeded",
      source: "live",
      output: live.output,
      cache: {
        status: "stored",
        publication: {
          key: cacheKey,
          dataRevision: "f".repeat(64),
          disposition: "changed",
        },
      },
    });
  });

  test("returns cached R1 reads without a provider roundtrip and distinguishes misses", async () => {
    const testState = state();
    try {
      install(testState, "R1");
      const cacheKey = "d".repeat(64);
      const dataRevision = "e".repeat(64);
      const exactMessage =
        "token=ordinary-message-value left\u202eright\u0085tail";
      const cached = {
        status: "hit",
        source: "cache",
        key: cacheKey,
        output: {
          items: [{ id: "2078889282404569267", text: exactMessage }],
        },
        dataRevision,
        createdAt: "2026-07-31T12:00:00.000Z",
        dataChangedAt: "2026-07-31T12:00:00.000Z",
        validatedAt: "2026-07-31T12:05:00.000Z",
        runId: "00000000-0000-4000-8000-000000000003",
        ageMs: 15_000,
        freshness: { state: "stale", freshForMs: 10_000 },
      } satisfies Parameters<typeof cachedInvocationView>[0];
      const arguments_ = [
        "invoke",
        "x",
        "posts.read",
        "--input",
        '{"post_ids":["2078889282404569267"]}',
        "--auth",
        "x-official",
        "--cache-only",
        "--json",
      ] as const;

      const hit = capture();
      expect(await main(arguments_, testState.environment, hit.output, {
        readCachedPreparedCapability: (invocation) => {
          expect(invocation.operationId).toBe("posts.read");
          return cached;
        },
      })).toBe(0);
      expect(JSON.parse(hit.stdout())).toMatchObject({
        ok: true,
        status: "cached",
        source: "cache",
        projection: { key: cacheKey, dataRevision },
        output: cached.output,
      });
      expect(hasUnsafeTerminalCharacters(hit.stdout())).toBeFalse();
      expect(hit.stdout()).toContain("token=ordinary-message-value");
      expect(hit.stdout()).toContain("\\u202e");
      expect(hit.stdout()).toContain("\\u0085");
      expect(hit.stderr()).toBe("");

      const human = capture();
      expect(await main(
        arguments_.filter((argument) => argument !== "--json"),
        testState.environment,
        human.output,
        { readCachedPreparedCapability: () => cached },
      )).toBe(0);
      expect(human.stdout()).not.toContain("ordinary-message-value");
      expect(hasUnsafeTerminalCharacters(human.stdout())).toBeFalse();

      const miss = capture();
      expect(await main(arguments_, testState.environment, miss.output, {
        readCachedPreparedCapability: () => ({ status: "miss", key: cacheKey }),
      })).toBe(3);
      expect(JSON.parse(miss.stdout())).toEqual({
        ok: false,
        status: "cache-miss",
        source: "cache",
        projection: { key: cacheKey },
      });
      expect(miss.stderr()).toBe("");

      let identityCacheReads = 0;
      const identity = capture();
      expect(await main(
        arguments_.map((argument) =>
          argument === "--cache-only"
            ? "--projection-identity-only"
            : argument),
        testState.environment,
        identity.output,
        {
          readCachedPreparedCapability: () => {
            identityCacheReads += 1;
            return cached;
          },
        },
      )).toBe(0);
      expect(identityCacheReads).toBe(0);
      const identityView = JSON.parse(identity.stdout()) as {
        readonly ok: unknown;
        readonly source: unknown;
        readonly status: unknown;
        readonly authIdentity: unknown;
        readonly authHash: unknown;
        readonly inputHash: unknown;
        readonly projection: { readonly key: unknown };
      };
      expect(identityView).toMatchObject({
        ok: true,
        source: "projection-identity",
        status: "ready",
        authHash: sha256(canonicalJson(loadAuth(
          "x-official",
          testState.environment,
        ))),
        inputHash: sha256(canonicalJson({
          post_ids: ["2078889282404569267"],
        })),
      });
      expect(Object.keys(identityView).sort()).toEqual([
        "authHash",
        "authIdentity",
        "inputHash",
        "ok",
        "projection",
        "source",
        "status",
      ]);
      expect(identityView.projection.key).toBeString();
      expect(identityView.projection.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(identityView.authIdentity).toBeString();
      expect(identityView.authIdentity).toMatch(/^[a-f0-9]{64}$/u);
      expect(identity.stderr()).toBe("");

      saveAuth(createAuth("x-unbound-read", {
        oauthProvider: "x",
        tokenFile: join(testState.directory, "x-unbound-token.json"),
        scopes: ["tweet.read", "users.read"],
      }), testState.environment);
      const unbound = capture();
      expect(await main([
        "invoke",
        "x",
        "posts.read",
        "--input",
        '{"post_ids":["2078889282404569267"]}',
        "--auth",
        "x-unbound-read",
        "--projection-identity-only",
        "--json",
      ], testState.environment, unbound.output, {
        readCachedPreparedCapability: () => {
          identityCacheReads += 1;
          return cached;
        },
      })).toBe(0);
      const unboundView = JSON.parse(unbound.stdout()) as Record<string, unknown>;
      expect(Object.keys(unboundView).sort()).toEqual([
        "authHash",
        "authIdentity",
        "inputHash",
        "ok",
        "source",
        "status",
      ]);
      expect(unboundView).toMatchObject({
        ok: true,
        source: "projection-identity",
        status: "unbound",
        authHash: sha256(canonicalJson(loadAuth(
          "x-unbound-read",
          testState.environment,
        ))),
        inputHash: sha256(canonicalJson({
          post_ids: ["2078889282404569267"],
        })),
      });
      expect(unboundView.authIdentity).toMatch(/^[a-f0-9]{64}$/u);
      expect(identityCacheReads).toBe(0);
      expect(unbound.stderr()).toBe("");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("prints the live result and projection publication for a revalidated R1 read", async () => {
    const testState = state();
    try {
      install(testState, "R1");
      const exactMessage =
        "Authorization: Bearer ordinary-message-value left\u202eright\u0085tail";
      const live: InvocationResult = {
        receipt: {
          schemaVersion: 3,
          runId: "00000000-0000-4000-8000-000000000004",
          planDigest: null,
          adapter: { id: "x", version: "1.0.0", hash: "a".repeat(64) },
          operation: "posts.read",
          risk: "R1",
          inputHash: "b".repeat(64),
          auth: { id: "x-official", hash: "c".repeat(64), kind: "oauth-token-file" },
          transport: "provider-api",
          providerContractHash: "f".repeat(64),
          status: "succeeded",
          dispatchStarted: true,
          dispatch: { planned: 1, started: 1, verified: 1 },
          startedAt: "2026-07-31T12:10:00.000Z",
          finishedAt: "2026-07-31T12:10:01.000Z",
          finalOrigin: "https://api.x.com",
          error: null,
        },
        output: {
          items: [{ id: "2078889282404569267", text: exactMessage }],
        },
        replayed: false,
        privateArtifactsPreserved: false,
      };
      const cacheKey = "d".repeat(64);
      const wrench = capture();

      expect(await main([
        "invoke",
        "x",
        "posts.read",
        "--input",
        '{"post_ids":["2078889282404569267"]}',
        "--auth",
        "x-official",
        "--json",
      ], testState.environment, wrench.output, {
        revalidatePreparedCapability: (invocation, options) => {
          expect(invocation.operationId).toBe("posts.read");
          expect(options.headed).toBeFalse();
          return Promise.resolve({
            cachedBefore: { status: "miss", key: cacheKey },
            live,
            cache: {
              status: "stored",
              publication: {
                key: cacheKey,
                dataRevision: "e".repeat(64),
                validatedAt: live.receipt.finishedAt,
                dataChangedAt: live.receipt.finishedAt,
                disposition: "created",
              },
            },
          });
        },
      })).toBe(0);

      expect(JSON.parse(wrench.stdout())).toMatchObject({
        ok: true,
        status: "succeeded",
        runId: live.receipt.runId,
        source: "live",
        output: live.output,
        cache: {
          status: "stored",
          publication: {
            key: cacheKey,
            dataRevision: "e".repeat(64),
            disposition: "created",
          },
        },
      });
      expect(hasUnsafeTerminalCharacters(wrench.stdout())).toBeFalse();
      expect(wrench.stdout()).toContain("Authorization: Bearer ordinary-message-value");
      expect(wrench.stdout()).toContain("\\u202e");
      expect(wrench.stdout()).toContain("\\u0085");
      expect(wrench.stderr()).toBe("");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("invokes the reviewed Bluesky public profile read without --auth and rejects an explicit locator", async () => {
    const testState = state();
    try {
      installManifest(bundledWebManifest("bluesky"), {
        force: false,
        environment: testState.environment,
      });
      const wrench = capture();
      expect(await main([
        "invoke",
        "bluesky-web",
        "profiles.read",
        "--input",
        '{"handle":"hraness.bsky.social"}',
        "--json",
      ], testState.environment, wrench.output, {
        revalidatePreparedCapability: (invocation) => {
          expect(isPublicWebSessionInvocationAuthority(invocation.auth))
            .toBeTrue();
          const live: InvocationResult = {
            receipt: {
              schemaVersion: 4,
              runId: "00000000-0000-4000-8000-000000000104",
              planDigest: null,
              adapter: {
                id: invocation.manifest.id,
                version: invocation.manifest.version,
                hash: "a".repeat(64),
              },
              operation: invocation.operationId,
              risk: "R1",
              inputHash: "b".repeat(64),
              auth: {
                id: invocation.auth.id,
                hash: sha256(canonicalJson(invocation.auth)),
                kind: "public-web-session",
              },
              transport: "web-session-api",
              webSessionContractHash: "c".repeat(64),
              status: "succeeded",
              dispatchStarted: false,
              dispatch: { planned: 0, started: 0, verified: 0 },
              startedAt: "2026-08-22T15:00:00.000Z",
              finishedAt: "2026-08-22T15:00:01.000Z",
              finalOrigin: "https://bsky.app",
              error: null,
            },
            output: { metrics: { followers: { value: 52 } } },
            replayed: false,
            privateArtifactsPreserved: false,
          };
          return Promise.resolve({
            cachedBefore: { status: "miss", key: "d".repeat(64) },
            live,
            cache: {
              status: "stored",
              publication: {
                key: "d".repeat(64),
                dataRevision: "e".repeat(64),
                validatedAt: live.receipt.finishedAt,
                dataChangedAt: live.receipt.finishedAt,
                disposition: "created",
              },
            },
          });
        },
      })).toBe(0);
      expect(JSON.parse(wrench.stdout())).toMatchObject({
        ok: true,
        status: "succeeded",
        output: { metrics: { followers: { value: 52 } } },
      });
      expect(wrench.stderr()).toBe("");

      const explicit = capture();
      expect(await main([
        "invoke",
        "bluesky-web",
        "profiles.read",
        "--input",
        '{"handle":"hraness.bsky.social"}',
        "--auth",
        "bluesky-main",
        "--json",
      ], testState.environment, explicit.output, {
        revalidatePreparedCapability: () => {
          throw new Error("explicit auth must fail before execution");
        },
      })).toBe(3);
      expect(explicit.stderr()).toContain(
        "is public and does not accept an auth locator",
      );
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reports both completed reads and submitted writes as successful JSON outcomes", () => {
    const receipt = (status: RunReceipt["status"]): RunReceipt => ({
      schemaVersion: 2,
      runId: crypto.randomUUID(),
      planDigest: null,
      adapter: { id: "example", version: "1.0.0", hash: "a".repeat(64) },
      operation: "messaging.send",
      risk: "R3",
      inputHash: "b".repeat(64),
      auth: { id: "example", hash: "c".repeat(64), kind: "cookie-source" },
      transport: "browser",
      status,
      dispatchStarted: status !== "failed" && status !== "pending",
      dispatch: {
        planned: 1,
        started: status !== "failed" && status !== "pending" ? 1 : 0,
        verified: status === "succeeded" ? 1 : 0,
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      finalOrigin: status === "failed" ? null : "https://example.com",
      error: status === "failed" || status === "indeterminate" ? "bounded failure" : null,
    });
    const view = (status: RunReceipt["status"]): Record<string, unknown> => invocationView({
      receipt: receipt(status),
      output: null,
      replayed: false,
      privateArtifactsPreserved: false,
    } satisfies InvocationResult);
    expect(view("succeeded").ok).toBeTrue();
    expect(view("submitted").ok).toBeTrue();
    expect(view("failed").ok).toBeFalse();
    expect(view("indeterminate").ok).toBeFalse();
  });

  test("uses exit 4 for an unconfirmed write and exit 0 for an explicit preview", async () => {
    const testState = state();
    try {
      install(testState);
      const unconfirmed = capture();
      const unconfirmedCode = await main([
        "invoke", "x", "posts.publish", "--input", '{"body":"hello"}', "--auth", "x-official", "--json",
      ], testState.environment, unconfirmed.output);
      expect(unconfirmedCode).toBe(4);
      expect(JSON.parse(unconfirmed.stdout())).toMatchObject({ status: "confirmation-required", input: { body: "hello" } });
      expect(unconfirmed.stderr()).toBe("");

      const preview = capture();
      const previewCode = await main([
        "invoke", "x", "posts.publish", "--input", '{"body":"second"}', "--auth", "x-official", "--preview", "--json",
      ], testState.environment, preview.output);
      expect(previewCode).toBe(0);
      expect(JSON.parse(preview.stdout())).toMatchObject({ status: "confirmation-required", input: { body: "second" } });

      const headed = capture();
      expect(await main([
        "invoke", "x", "posts.publish", "--input", '{"body":"headed"}', "--auth", "x-official", "--headed", "--json",
      ], testState.environment, headed.output)).toBe(4);
      const headedView = JSON.parse(headed.stdout()) as { readonly confirmCommand?: unknown };
      expect(headedView.confirmCommand).toBeString();
      expect(headedView.confirmCommand as string).toMatch(/ --headed$/u);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("shows the exact bound subject and selected internal API contract in a write confirmation", async () => {
    const testState = state();
    try {
      const xWeb = bundledWebManifest("x");
      const operation = xWeb.operations["likes.set"];
      if (operation === undefined || !isWebSessionOperation(operation)) {
        throw new Error("bundled X adapter omitted its authenticated likes.set contract");
      }
      installManifest(xWeb, { force: false, environment: testState.environment });
      const selectedAuth = createAuth("x-bound", {
        source: "arc",
        subject: "2244994945",
      });
      saveAuth(selectedAuth, testState.environment);
      const authHash = sha256(canonicalJson(selectedAuth));

      const wrench = capture();
      expect(await main([
        "invoke",
        "x-web",
        "likes.set",
        "--input",
        '{"post_id":"2078889282404569267","liked":true}',
        "--auth",
        "x-bound",
        "--preview",
        "--json",
      ], testState.environment, wrench.output)).toBe(0);

      expect(JSON.parse(wrench.stdout())).toMatchObject({
        status: "confirmation-required",
        auth: {
          id: "x-bound",
          kind: "cookie-source",
          realmFingerprint: authHash.slice(0, 16),
        },
        identityBinding: {
          subject: "2244994945",
          accountActor: "2244994945",
          requestedActor: null,
          status: "account-subject",
        },
        contract: {
          transport: "web-session-api",
          identity: "x/likes.set@2",
          site: "x",
          action: "likes.set",
          version: 2,
          hash: webSessionContractHash(
            getWebSessionContract(operation.webSession, providerPluginRegistry),
            providerPluginRegistry,
          ),
        },
      });
      expect(wrench.stdout()).not.toContain(authHash);
      expect(wrench.stderr()).toBe("");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("shows requested actors only for code-owned provider writes and rejects arbitrary browser input", async () => {
    const testState = state();
    try {
      const linkedin = JSON.parse(readFileSync(
        join(import.meta.dir, "assets", "adapters", "linkedin", "wrench-adapter.json"),
        "utf8",
      )) as WrenchManifest;
      installManifest(linkedin, { force: false, environment: testState.environment });
      const linkedinAuth = createAuth("linkedin-official", {
        oauthProvider: "linkedin",
        tokenFile: join(testState.directory, "linkedin-token.json"),
        scopes: ["w_member_social"],
        subject: "urn:li:person:member-1",
      });
      saveAuth(linkedinAuth, testState.environment);
      const provider = capture();
      expect(await main([
        "invoke",
        "linkedin",
        "posts.publish",
        "--input",
        '{"author":"urn:li:person:member-1","body":"Bound provider post"}',
        "--auth",
        "linkedin-official",
        "--preview",
        "--json",
      ], testState.environment, provider.output)).toBe(0);
      expect(JSON.parse(provider.stdout())).toMatchObject({
        auth: {
          realmFingerprint: sha256(canonicalJson(linkedinAuth)).slice(0, 16),
        },
        identityBinding: {
          subject: "urn:li:person:member-1",
          accountActor: null,
          requestedActor: "urn:li:person:member-1",
          status: "subject-match",
        },
      });

      const browserOperation = manifest("R2").operations["messaging.send"];
      if (browserOperation === undefined) throw new Error("generic fixture omitted messaging.send");
      const browserManifest: WrenchManifest = {
        ...manifest("R2"),
        operations: {
          "messaging.send": {
            ...browserOperation,
            input: {
              properties: {
                ...browserOperation.input.properties,
                actor: {
                  type: "string",
                  description: "Untrusted caller-supplied display actor",
                  minLength: 1,
                  maxLength: 100,
                },
              },
              required: ["message", "actor"],
            },
          },
        },
      };
      expect(() => installManifest(browserManifest, { force: false, environment: testState.environment }))
        .toThrow("runtime DOM action recipes are disabled");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects unbound code-owned write previews without persisting a confirmation plan", async () => {
    const testState = state();
    try {
      installManifest(bundledWebManifest("x"), { force: false, environment: testState.environment });
      saveAuth(createAuth("x-unbound", { source: "arc", profile: "Profile 1" }), testState.environment);
      const web = capture();
      expect(await main([
        "invoke",
        "x-web",
        "likes.set",
        "--input",
        '{"post_id":"2078889282404569267","liked":true}',
        "--auth",
        "x-unbound",
        "--preview",
        "--json",
      ], testState.environment, web.output)).toBe(3);
      expect(web.stderr()).toContain("account-bound auth subject");
      expect(existsSync(join(testState.directory, "plans"))).toBeFalse();

      installManifest(xThreadManifest(), { force: false, environment: testState.environment });
      saveAuth(createAuth("x-official-unbound", {
        oauthProvider: "x",
        tokenFile: join(testState.directory, "x-token.json"),
        scopes: ["tweet.read", "tweet.write", "users.read"],
      }), testState.environment);
      const provider = capture();
      expect(await main([
        "invoke",
        "x-thread",
        "threads.publish",
        "--input",
        '{"items":["one bounded item"]}',
        "--auth",
        "x-official-unbound",
        "--preview",
        "--json",
      ], testState.environment, provider.output)).toBe(3);
      expect(provider.stderr()).toContain("account-bound auth subject");
      expect(existsSync(join(testState.directory, "plans"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("shows an executable-free R1 preview without a confirmation digest or expiry", async () => {
    const testState = state();
    try {
      install(testState, "R1");
      const wrench = capture();
      const code = await main([
        "invoke", "x", "posts.read", "--input", '{"post_ids":["2078889282404569267"]}', "--auth", "x-official", "--preview", "--json",
      ], testState.environment, wrench.output);
      expect(code).toBe(0);
      const view = JSON.parse(wrench.stdout()) as Record<string, unknown>;
      expect(view).toMatchObject({ status: "preview", requiresConfirmation: false, risk: "R1" });
      expect(view.digest).toBeUndefined();
      expect(view.expiresAt).toBeUndefined();
      expect(view.confirmCommand).toBeUndefined();
      expect(existsSync(join(testState.directory, "plans"))).toBeFalse();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("propagates a pre-aborted command signal through reads and confirmations", async () => {
    const testState = state();
    try {
      install(testState);
      const controller = new AbortController();
      controller.abort();

      const read = capture();
      expect(await main([
        "invoke",
        "x",
        "posts.read",
        "--input",
        '{"post_ids":["2078889282404569267"]}',
        "--auth",
        "x-official",
        "--json",
      ], testState.environment, read.output, {}, controller.signal)).toBe(3);
      expect(JSON.parse(read.stdout())).toMatchObject({
        status: "failed",
        receipt: {
          status: "failed",
          dispatchStarted: false,
          error: "official API operation failed before the dispatch boundary; reason: official provider operation was cancelled",
        },
      });
      expect(read.stderr()).toBe("");

      const preview = capture();
      expect(await main([
        "invoke",
        "x",
        "posts.publish",
        "--input",
        '{"body":"cancel before dispatch"}',
        "--auth",
        "x-official",
        "--json",
      ], testState.environment, preview.output)).toBe(4);
      const previewResult = JSON.parse(preview.stdout()) as {
        readonly digest?: unknown;
      };
      if (typeof previewResult.digest !== "string") {
        throw new Error("write preview omitted its confirmation digest");
      }

      const confirm = capture();
      expect(await main([
        "confirm",
        previewResult.digest,
        "--json",
      ], testState.environment, confirm.output, {}, controller.signal)).toBe(3);
      expect(JSON.parse(confirm.stdout())).toMatchObject({
        status: "failed",
        receipt: {
          status: "failed",
          dispatchStarted: false,
          dispatch: { planned: 1, started: 0, verified: 0 },
          error: "official API operation failed before the dispatch boundary; reason: official provider operation was cancelled",
        },
      });
      expect(confirm.stderr()).toBe("");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("round-trips bidi and C1 controls in preview JSON without emitting raw terminal controls", async () => {
    const testState = state();
    try {
      install(testState);
      const unsafeMessage = "left\u202eright\u0085tail";
      const wrench = capture();
      const code = await main([
        "invoke",
        "x",
        "posts.publish",
        "--input",
        JSON.stringify({ body: unsafeMessage }),
        "--auth",
        "x-official",
        "--preview",
        "--json",
      ], testState.environment, wrench.output);

      expect(code).toBe(0);
      expect(hasUnsafeTerminalCharacters(wrench.stdout())).toBeFalse();
      expect(wrench.stdout()).toContain("\\u202e");
      expect(wrench.stdout()).toContain("\\u0085");
      expect(JSON.parse(wrench.stdout())).toMatchObject({ input: { body: unsafeMessage } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("returns distinct usage and execution failures and rejects retired DOM actions before startup", async () => {
    const testState = state();
    try {
      const usage = capture();
      expect(await main(["unknown-command"], testState.environment, usage.output)).toBe(2);
      expect(usage.stderr()).toContain("unknown command");

      const missing = capture();
      expect(await main(["capabilities", "missing", "--json"], testState.environment, missing.output)).toBe(3);
      expect(JSON.parse(missing.stdout())).toEqual({ ok: false, adapters: [] });

      expect(() => installManifest(manifest("R4"), { force: false, environment: testState.environment }))
        .toThrow("runtime DOM action recipes are disabled");

      const nonexistent = capture();
      expect(await main(["confirm", "a".repeat(64), "--json"], testState.environment, nonexistent.output)).toBe(3);
      expect(nonexistent.stderr()).toContain("could not safely open encrypted plan");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("renders the canonical Wrench command surface", async () => {
    const usage = renderWrenchUsage();
    expect(usage).toStartWith("Usage:\n  wrench ");
    expect(usage).toContain("wrench invoke <adapter> <operation>");
    expect(usage).toContain("Shorthand for 'wrench invoke'");
    expect(usage).toContain("wrench plugin list [--json]");
    expect(usage).toContain("wrench plugin show <id> [--json]");
    expect(usage).toContain("wrench plugin scaffold --site <id>");
    expect(usage).toContain("wrench plugin check <directory> [--json]");
    expect(usage).toContain("Compatibility alias for 'wrench plugin scaffold'");
    expect(usage).not.toContain("install-local.sh");
    expect(usage).not.toContain("uninstall-local.sh");

    const output = capture();
    expect(await main(
      ["unknown-command"],
      process.env,
      output.output,
    )).toBe(2);
    expect(output.stderr()).toStartWith("unknown command: unknown-command\n\nUsage:\n  wrench ");
  });

  test("keeps exact write inputs encrypted on disk after preview", async () => {
    const testState = state();
    try {
      install(testState);
      const secret = "message-that-must-not-be-plaintext";
      const wrench = capture();
      expect(await main([
        "invoke", "x", "posts.publish", "--input", JSON.stringify({ body: secret }), "--auth", "x-official", "--preview",
      ], testState.environment, wrench.output)).toBe(0);
      const preview = JSON.parse(wrench.stdout()) as { digest: string };
      const plan = readFileSync(join(testState.directory, "plans", `${preview.digest}.json`), "utf8");
      expect(plan).toContain("aes-256-gcm");
      expect(plan).not.toContain(secret);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("previews attachment metadata without exposing its source path or filename", async () => {
    const testState = state();
    const sourceDirectory = mkdtempSync(join(tmpdir(), "wrench-cli-attachment-"));
    const source = join(sourceDirectory, "private-personal-name.png");
    writeFileSync(source, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]), { mode: 0o600 });
    try {
      install(testState);
      const wrench = capture();
      expect(await main([
        "invoke", "x", "posts.publish", "--input", JSON.stringify({ body: "reviewed media", media: [source] }),
        "--auth", "x-official", "--preview", "--json",
      ], testState.environment, wrench.output)).toBe(0);
      const view = JSON.parse(wrench.stdout()) as {
        readonly digest: string;
        readonly input: { readonly media: readonly Record<string, unknown>[] };
        readonly inputHash: string;
        readonly dispatches: readonly Record<string, unknown>[];
      };
      expect(view.input.media[0]).toMatchObject({ kind: "file", bytes: 16, mediaType: "image/png" });
      expect(view.input.media[0]?.sha256).toBeString();
      expect(view.inputHash).toBeString();
      expect(view.dispatches).toEqual([{ id: "posts-publish", description: "Execute x posts.publish" }]);
      expect(wrench.stdout()).not.toContain(source);
      expect(wrench.stdout()).not.toContain("private-personal-name");
      expect(existsSync(planAssetBundlePath(view.digest, testState.environment))).toBeTrue();
      expect(await main(["plans", "cancel", view.digest, "--yes"], testState.environment, capture().output)).toBe(0);
      expect(existsSync(planAssetBundlePath(view.digest, testState.environment))).toBeFalse();
    } finally {
      rmSync(sourceDirectory, { recursive: true, force: true });
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("lists and cancels previews and explicitly removes adapters", async () => {
    const testState = state();
    try {
      install(testState);
      const preview = capture();
      expect(await main([
        "invoke", "x", "posts.publish", "--input", '{"body":"private cancellation value"}', "--auth", "x-official", "--preview", "--json",
      ], testState.environment, preview.output)).toBe(0);
      const digest = (JSON.parse(preview.stdout()) as { digest: string }).digest;

      const listed = capture();
      expect(await main(["plans", "list", "--json"], testState.environment, listed.output)).toBe(0);
      expect(JSON.parse(listed.stdout())).toMatchObject({ ok: true, plans: [{ digest, operation: "posts.publish" }] });
      expect(listed.stdout()).not.toContain("private cancellation value");

      const notConfirmed = capture();
      expect(await main(["plans", "cancel", digest], testState.environment, notConfirmed.output)).toBe(3);
      expect(notConfirmed.stderr()).toContain("requires --yes");
      expect(await main(["plans", "cancel", digest, "--yes"], testState.environment, capture().output)).toBe(0);

      const removeWithoutYes = capture();
      expect(await main(["adapter", "remove", "x"], testState.environment, removeWithoutYes.output)).toBe(3);
      expect(removeWithoutYes.stderr()).toContain("requires --yes");
      expect(await main(["adapter", "remove", "x", "--yes"], testState.environment, capture().output)).toBe(0);
      const capabilities = capture();
      expect(await main(["capabilities", "x", "--json"], testState.environment, capabilities.output)).toBe(3);
      expect(JSON.parse(capabilities.stdout())).toEqual({ ok: false, adapters: [] });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});

describe("Wrench process termination boundary", () => {
  test("reserves the browser cleanup window before restoring forced signal delivery", async () => {
    let terminate:
      | ((signal: NodeJS.Signals) => void)
      | undefined;
    let mainSignal: AbortSignal | undefined;
    let markMainStarted: (() => void) | undefined;
    const mainStarted = new Promise<void>((resolve) => {
      markMainStarted = resolve;
    });
    let finishMain: ((code: number) => void) | undefined;
    const mainCompletion = new Promise<number>((resolve) => {
      finishMain = resolve;
    });
    let fallbackDelayMs: number | undefined;
    let fallbackCancelled = 0;
    let signalsResent = 0;
    let observedExitCode: number | undefined;
    try {
      const operation = runWrenchProcess({
        rawArguments: ["auth", "bind", "bluesky-main", "--site", "bluesky"],
        environment: {},
        output: capture().output,
        runMain: (_arguments, _environment, _output, _overrides, signal) => {
          mainSignal = signal;
          markMainStarted?.();
          return mainCompletion;
        },
        subscribeTermination: (listener) => {
          terminate = listener;
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
          };
        },
        scheduleForcedTermination: (_callback, delayMs) => {
          fallbackDelayMs = delayMs;
          let scheduled = true;
          return () => {
            if (!scheduled) return;
            scheduled = false;
            fallbackCancelled += 1;
          };
        },
        resendSignal: () => {
          signalsResent += 1;
        },
        setExitCode: (code) => {
          observedExitCode = code;
        },
      });
      await mainStarted;
      if (terminate === undefined) {
        throw new Error("process boundary omitted its termination handler");
      }
      terminate("SIGINT");

      expect(mainSignal?.aborted).toBeTrue();
      expect(fallbackDelayMs).toBeGreaterThan(30_000);
      expect(signalsResent).toBe(0);

      finishMain?.(5);
      await operation;
      expect(fallbackCancelled).toBe(1);
      expect(signalsResent).toBe(0);
      expect(observedExitCode).toBe(5);
    } finally {
      finishMain?.(5);
    }
  });
});

describe("UTF-8 stdin", () => {
  test("splits thread text from stdin without changing a multibyte scalar", async () => {
    const testState = state();
    try {
      const text = `${"🙂".repeat(200)}\nend`;
      const bytes = Buffer.from(text, "utf8");
      const split = Buffer.from("🙂", "utf8").byteLength - 1;
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "wrench.ts"),
        "thread",
        "split",
        "x",
        "--text",
        "-",
        "--json",
      ], {
        cwd: process.cwd(),
        env: testState.environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await child.stdin.write(bytes.subarray(0, split));
      await child.stdin.write(bytes.subarray(split));
      await child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const view = JSON.parse(stdout) as { readonly chunks: readonly { readonly text: string }[] };
      expect(view.chunks.map((chunk) => chunk.text).join("")).toBe(text);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("decodes a multibyte scalar split across stdin chunks", async () => {
    const testState = state();
    try {
      install(testState);
      const message = "snowman ☃, emoji 🧪, café";
      const bytes = Buffer.from(JSON.stringify({ body: message }), "utf8");
      const emoji = Buffer.from("🧪", "utf8");
      const emojiStart = bytes.indexOf(emoji);
      expect(emojiStart).toBeGreaterThan(0);
      const split = emojiStart + 2;
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "wrench.ts"),
        "invoke",
        "x",
        "posts.publish",
        "--input",
        "-",
        "--auth",
        "x-official",
        "--preview",
        "--json",
      ], {
        cwd: process.cwd(),
        env: testState.environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await child.stdin.write(bytes.subarray(0, split));
      await child.stdin.write(bytes.subarray(split));
      await child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({ input: { body: message } });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed UTF-8 instead of replacement-decoding it", async () => {
    const testState = state();
    try {
      install(testState);
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "wrench.ts"),
        "invoke",
        "x",
        "posts.publish",
        "--input",
        "-",
        "--auth",
        "x-official",
        "--preview",
        "--json",
      ], {
        cwd: process.cwd(),
        env: testState.environment,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await child.stdin.write(Buffer.concat([Buffer.from('{"body":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
      await child.stdin.end();
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(3);
      expect(stderr).toMatch(/Invalid byte sequence|encoded data was not valid/u);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
