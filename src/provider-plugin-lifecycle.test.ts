import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  observePortableProviderPluginHostProcessForTest,
} from "./provider-plugin-host";
import {
  checkPortableProviderPlugin,
  disablePortableProviderPlugin,
  doctorPortableProviderPlugins,
  initPortableProviderPlugin,
  installPortableProviderPlugin,
  listPortableProviderPlugins,
  packPortableProviderPlugin,
  portableProviderPluginStoreRoot,
  removePortableProviderPlugin,
  showPortableProviderPlugin,
  testPortableProviderPlugin,
} from "./provider-plugin-lifecycle";
import {
  renderPortableProviderPluginManifest,
  type PortableLinkedDevicePluginBindingV1,
  type PortableProviderApiPluginBindingV1,
  type PortableProviderPluginManifestV1,
  type PortableWebSessionApiPluginBindingV1,
} from "./provider-plugin-package";

const allowActivation = (): void => {};
const assertQuiescent = (): void => {};
const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;
const lifecycleModuleUrl = new URL(
  "./provider-plugin-lifecycle.ts",
  import.meta.url,
).href;

function withRoot(
  callback: (
    root: string,
    environment: Readonly<Record<string, string | undefined>>,
  ) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wrench-plugin-lifecycle-"));
  chmodSync(root, 0o700);
  const environment = {
    ...process.env,
    WRENCH_STATE_HOME: join(root, "io-state"),
  };
  return Promise.resolve(callback(root, environment))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function replaceManifestText(
  root: string,
  before: string,
  after: string,
): void {
  const path = join(root, "wrench-plugin.json");
  const content = readFileSync(path, "utf8");
  if (!content.includes(before)) {
    throw new Error(`portable plugin manifest fixture is missing ${before}`);
  }
  writeFileSync(path, content.replace(before, after), { mode: 0o600 });
}

async function interruptAuthoringStage(
  kind: "init" | "pack",
  output: string,
  source?: string,
): Promise<string> {
  const script = kind === "init"
    ? `
      import { initPortableProviderPlugin } from ${JSON.stringify(lifecycleModuleUrl)};
      initPortableProviderPlugin({
        id: "interrupted-web",
        displayName: "Interrupted web",
        surfaceId: "interrupted",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: ${JSON.stringify(output)},
      });
    `
    : `
      import { packPortableProviderPlugin } from ${JSON.stringify(lifecycleModuleUrl)};
      packPortableProviderPlugin(${JSON.stringify(source)}, ${JSON.stringify(output)});
    `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      WRENCH_TEST_PLUGIN_AUTHORING_STAGE_FAULT: kind,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const prefix = `.${basename(output)}.wrench-plugin-${kind}-`;
  let stage: string | undefined;
  try {
    const deadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
    while (performance.now() < deadline) {
      const name = readdirSync(join(output, "..")).find((entry) =>
        entry.startsWith(prefix));
      if (name !== undefined) {
        stage = join(output, "..", name);
        break;
      }
      if (child.exitCode !== null) break;
      await Bun.sleep(10);
    }
    if (stage === undefined) {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      throw new Error(
        `interrupted ${kind} did not publish a stage (exit ${exitCode}): ${stdout}${stderr}`,
      );
    }
    child.kill("SIGKILL");
    await child.exited;
    await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return stage;
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

describe("portable provider plugin lifecycle", () => {
  test("recovers SIGKILL-abandoned Wrench and predecessor init and pack stages", async () => {
    await withRoot(async (root) => {
      const source = join(root, "recovered-plugin");
      const interruptedInit = await interruptAuthoringStage("init", source);
      const predecessorInit = join(
        root,
        ".recovered-plugin.oh-plugin-init-11111111-1111-4111-8111-111111111111",
      );
      mkdirSync(join(predecessorInit, "nested"), { recursive: true, mode: 0o700 });

      const initialized = initPortableProviderPlugin({
        id: "recovered-web",
        displayName: "Recovered web",
        surfaceId: "recovered",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: source,
      });

      expect(initialized.path).toBe(source);
      expect(basename(interruptedInit)).toContain(".wrench-plugin-init-");
      expect(existsSync(interruptedInit)).toBeFalse();
      expect(existsSync(predecessorInit)).toBeFalse();

      const output = join(root, "recovered.wrenchplugin");
      const interruptedPack = await interruptAuthoringStage("pack", output, source);
      const predecessorPack = join(
        root,
        ".recovered.wrenchplugin.oh-plugin-pack-22222222-2222-4222-8222-222222222222",
      );
      mkdirSync(join(predecessorPack, "nested"), { recursive: true, mode: 0o700 });

      const packed = packPortableProviderPlugin(source, output);

      expect(packed.path).toBe(output);
      expect(basename(interruptedPack)).toContain(".wrench-plugin-pack-");
      expect(existsSync(interruptedPack)).toBeFalse();
      expect(existsSync(predecessorPack)).toBeFalse();
      expect(readdirSync(root).filter((name) =>
        name.includes(".wrench-plugin-init-")
        || name.includes(".wrench-plugin-pack-")
        || name.includes(".oh-plugin-init-")
        || name.includes(".oh-plugin-pack-")))
        .toEqual([]);
    });
  });

  test("rejects unsafe and over-bound predecessor authoring stages without removing them", async () => {
    await withRoot((root) => {
      const linkedOutput = join(root, "linked-plugin");
      const referent = join(root, "referent");
      const linkedStage = join(
        root,
        ".linked-plugin.oh-plugin-init-33333333-3333-4333-8333-333333333333",
      );
      mkdirSync(referent, { mode: 0o700 });
      writeFileSync(join(referent, "owned.txt"), "preserve\n", { mode: 0o600 });
      symlinkSync(referent, linkedStage);

      expect(() => initPortableProviderPlugin({
        id: "linked-web",
        displayName: "Linked web",
        surfaceId: "linked",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: linkedOutput,
      })).toThrow("not a private current-user directory");
      expect(existsSync(linkedOutput)).toBeFalse();
      expect(readFileSync(join(referent, "owned.txt"), "utf8")).toBe("preserve\n");

      const boundedOutput = join(root, "bounded-plugin");
      const stages = Array.from({ length: 65 }, (_value, index) =>
        join(
          root,
          `.bounded-plugin.oh-plugin-init-${index.toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`,
        ));
      for (const stage of stages) mkdirSync(stage, { mode: 0o700 });

      expect(() => initPortableProviderPlugin({
        id: "bounded-web",
        displayName: "Bounded web",
        surfaceId: "bounded",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: boundedOutput,
      })).toThrow("more than 64 exact abandoned stages");
      expect(existsSync(boundedOutput)).toBeFalse();
      expect(stages.every((stage) => existsSync(stage))).toBeTrue();
    });
  });

  test("initializes, checks, tests, reproducibly packs, trusts, and inspects an inert plugin", async () => {
    await withRoot(async (root, environment) => {
      const source = join(root, "example-plugin");
      const initialized = initPortableProviderPlugin({
        id: "example-web",
        displayName: "Example web",
        surfaceId: "example",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: source,
      });
      expect(initialized.path).toBe(source);
      expect(initialized.manifest.bindings[0]?.operations[0]?.state)
        .toBe("capture-required");
      expect(statSync(source).mode & 0o777).toBe(0o700);
      expect(statSync(join(source, "wrench-plugin.json")).mode & 0o777).toBe(0o600);

      const checked = checkPortableProviderPlugin(source);
      expect(checked).toMatchObject({
        id: "example-web",
        sourceKind: "portable",
        execution: "trusted-child-process",
        sandboxed: false,
        operations: 1,
      });
      expect((await testPortableProviderPlugin(source, {
        trustExecutableCode: true,
      }))).toMatchObject({
        ok: true,
        pluginId: "example-web",
        bundleSha256: checked.bundleSha256,
        inert: 1,
        executed: 0,
      });

      const firstPackage = join(root, "example-one.wrenchplugin");
      const secondPackage = join(root, "example-two.wrenchplugin");
      const first = packPortableProviderPlugin(source, firstPackage);
      const second = packPortableProviderPlugin(source, secondPackage);
      expect(first.bundleSha256).toBe(second.bundleSha256);
      expect(
        readFileSync(join(firstPackage, "wrench-plugin.json")),
      ).toEqual(readFileSync(join(secondPackage, "wrench-plugin.json")));

      expect(() =>
        installPortableProviderPlugin(firstPackage, {
          trustExecutableCode: false,
          expectedCurrentBundleSha256: null,
          assertActivatable: allowActivation,
          assertCurrentQuiescent: assertQuiescent,
          environment,
        })).toThrow("requires --trust-code");
      expect(existsSync(portableProviderPluginStoreRoot(environment))).toBeFalse();

      const activatableBundleSha256: string[] = [];
      const installed = installPortableProviderPlugin(firstPackage, {
        trustExecutableCode: true,
        expectedCurrentBundleSha256: null,
        assertActivatable: (candidate) => {
          activatableBundleSha256.push(candidate.bundleSha256);
        },
        assertCurrentQuiescent: assertQuiescent,
        environment,
        now: new Date("2026-07-25T12:34:56.000Z"),
      });
      expect(installed.bundleSha256).toBe(first.bundleSha256);
      expect(activatableBundleSha256).toEqual([first.bundleSha256]);
      expect(listPortableProviderPlugins(environment)).toEqual([installed]);
      expect(showPortableProviderPlugin("example-web", environment))
        .toMatchObject({
          summary: installed,
          trust: {
            decision: "trust-executable-code",
            trustedAt: "2026-07-25T12:34:56.000Z",
          },
        });
      expect(doctorPortableProviderPlugins(environment)).toMatchObject({
        ok: true,
        installed: 1,
        issues: [],
      });
      const replacementChecks: string[] = [];
      const replacementArtifactPaths: string[] = [];
      expect(installPortableProviderPlugin(firstPackage, {
        trustExecutableCode: true,
        expectedCurrentBundleSha256: installed.bundleSha256,
        assertActivatable: (candidate) => {
          replacementChecks.push(`candidate:${candidate.bundleSha256}`);
        },
        assertCurrentQuiescent: (bundleSha256, artifactPath) => {
          replacementChecks.push(`current:${bundleSha256}`);
          replacementArtifactPaths.push(artifactPath);
        },
        environment,
        now: new Date("2026-07-25T12:45:00.000Z"),
      })).toEqual(installed);
      expect(replacementChecks).toEqual([
        `candidate:${installed.bundleSha256}`,
        `current:${installed.bundleSha256}`,
      ]);
      expect(replacementArtifactPaths).toHaveLength(1);
      const disabledArtifactPaths: string[] = [];
      expect(disablePortableProviderPlugin("example-web", {
        expectedBundleSha256: installed.bundleSha256,
        assertQuiescent: (bundleSha256, artifactPath) => {
          expect(bundleSha256).toBe(installed.bundleSha256);
          disabledArtifactPaths.push(artifactPath);
        },
        environment,
        now: new Date("2026-07-25T13:00:00.000Z"),
      }).activation).toBe("disabled");
      expect(disabledArtifactPaths).toEqual(replacementArtifactPaths);
      expect(listPortableProviderPlugins(environment)[0]?.activation)
        .toBe("disabled");
      const removedArtifactPaths: string[] = [];
      expect(removePortableProviderPlugin("example-web", {
        expectedBundleSha256: installed.bundleSha256,
        assertQuiescent: (bundleSha256, artifactPath) => {
          expect(bundleSha256).toBe(installed.bundleSha256);
          removedArtifactPaths.push(artifactPath);
        },
        environment,
      })).toMatchObject({
        activation: "uninstalled",
        retainedAuditArtifact: true,
      });
      expect(removedArtifactPaths).toEqual(disabledArtifactPaths);
      expect(listPortableProviderPlugins(environment)).toEqual([]);
    });
  });

  test("requires explicit trust before an observed fixture can spawn package code", async () => {
    await withRoot(async (root) => {
      const source = join(root, "observed-plugin");
      const initialized = initPortableProviderPlugin({
        id: "observed-web",
        displayName: "Observed web",
        surfaceId: "observed",
        origin: "https://www.example.com",
        operation: "records.update",
        transport: "provider-api",
        requiredScopeSets: [["records.write"]],
        coverage: ["records.update"],
        output: source,
      });
      const binding = initialized.manifest.bindings[0];
      if (
        binding === undefined
        || binding.transport !== "provider-api"
      ) {
        throw new Error("portable observed fixture is incomplete");
      }
      const operation = binding.operations[0];
      if (operation === undefined) {
        throw new Error("portable observed fixture is incomplete");
      }
      const observedBinding: PortableProviderApiPluginBindingV1 = {
        ...binding,
        operations: [{
          ...operation,
          state: "observed",
          input: {
            properties: {
              attachment: {
                type: "file",
                description: "One deterministic conformance attachment.",
                maxBytes: 13,
                mediaTypes: ["text/plain"],
              },
            },
            required: ["attachment"],
          },
          implementation: "Deterministic secret-free conformance fixture.",
        }],
      };
      const manifest: PortableProviderPluginManifestV1 = {
        ...initialized.manifest,
        capabilities: {
          ...initialized.manifest.capabilities,
          planFiles: "read",
        },
        bindings: [observedBinding],
      };
      writeFileSync(
        join(source, "wrench-plugin.json"),
        renderPortableProviderPluginManifest(manifest),
        { mode: 0o600 },
      );
      const runtimePath = join(source, "dist", "plugin.mjs");
      const inertRuntime = readFileSync(runtimePath, "utf8");
      writeFileSync(
        runtimePath,
        inertRuntime.replace(
          `  throw Object.assign(new Error("operation remains capture-required"), {
    code: "CAPTURE_REQUIRED",
  });`,
          `  const file = await context.capability({
    kind: "file.read",
    handle: "fixture-plan-file",
    offset: 0,
    length: 13,
  });
  if (
    file.kind !== "file.read"
    || file.data !== "Zml4dHVyZS1pbnB1dA=="
    || file.eof !== true
  ) throw new Error("invalid fixture file");
  const material = await context.capability({
    kind: "session.acquire",
    name: "oauth-access-token",
  });
  if (material.kind !== "session.acquire") throw new Error("invalid material");
  const dispatch = await context.capability({
    kind: "dispatch.begin",
    dispatchId: context.route.operation,
  });
  if (dispatch.kind !== "dispatch.begin") throw new Error("invalid dispatch");
  const response = await context.capability({
    kind: "http.request",
    method: "POST",
    url: "https://www.example.com/api/records/1",
    headers: [{ name: "content-type", value: "application/json" }],
    credentials: [{
      handle: material.materialHandle,
      sink: { kind: "header", name: "authorization" },
    }],
    body: {
      kind: "utf8",
      mediaType: "application/json",
      text: "{\\"attachment\\":\\"fixture-plan-file\\"}",
    },
    redirect: "error",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    dispatchHandle: dispatch.dispatchHandle,
  });
  if (response.kind !== "http.request" || response.body.kind !== "utf8") {
    throw new Error("invalid viewer response");
  }
  const viewer = JSON.parse(response.body.text);
  const verification = await context.capability({
    kind: "dispatch.verify",
    dispatchHandle: dispatch.dispatchHandle,
    proof: { status: response.status },
  });
  if (verification.kind !== "dispatch.verify") {
    throw new Error("invalid verification");
  }
  return { fileRead: true, subject: viewer.subject };`,
        ),
        { mode: 0o600 },
      );
      const fixturePath = join(
        source,
        "fixtures",
        "observed.records.update.v1.json",
      );
      writeFileSync(
        fixturePath,
        `${JSON.stringify({
          schemaVersion: 1,
          route: {
            transport: "provider-api",
            surfaceId: "observed",
            operation: "records.update",
            contractVersion: 1,
          },
          input: { attachment: "fixture-plan-file" },
          auth: { kind: "oauth-token-file" },
          files: [{
            input: "attachment",
            handle: "fixture-plan-file",
            bytes: 13,
            mediaType: "text/plain",
            sha256: "092b6c5fe457a50538f12defa6a27bbe9b2a686550495cb71787f7fae241e669",
          }],
          capabilityTranscript: [
            {
              request: {
                kind: "file.read",
                handle: "fixture-plan-file",
                offset: 0,
                length: 13,
              },
              result: {
                kind: "file.read",
                data: "Zml4dHVyZS1pbnB1dA==",
                eof: true,
              },
            },
            {
              request: {
                kind: "session.acquire",
                name: "oauth-access-token",
              },
              result: {
                kind: "session.acquire",
                materialHandle: "fixture-oauth-token",
              },
            },
            {
              request: {
                kind: "dispatch.begin",
                dispatchId: "records.update",
              },
              result: {
                kind: "dispatch.begin",
                dispatchHandle: "fixture-dispatch",
              },
            },
            {
              request: {
                kind: "http.request",
                method: "POST",
                url: "https://www.example.com/api/records/1",
                headers: [{
                  name: "content-type",
                  value: "application/json",
                }],
                credentials: [{
                  handle: "fixture-oauth-token",
                  sink: { kind: "header", name: "authorization" },
                }],
                body: {
                  kind: "utf8",
                  mediaType: "application/json",
                  text: "{\"attachment\":\"fixture-plan-file\"}",
                },
                redirect: "error",
                timeoutMs: 1_000,
                maxOutputBytes: 4_096,
                dispatchHandle: "fixture-dispatch",
              },
              result: {
                kind: "http.request",
                status: 200,
                headers: [{
                  name: "content-type",
                  value: "application/json",
                }],
                body: {
                  kind: "utf8",
                  text: "{\"subject\":\"account-123\"}",
                },
                finalUrl: "https://www.example.com/api/records/1",
              },
            },
            {
              request: {
                kind: "dispatch.verify",
                dispatchHandle: "fixture-dispatch",
                proof: { status: 200 },
              },
              result: { kind: "dispatch.verify", verified: true },
            },
          ],
          expected: {
            output: { fileRead: true, subject: "account-123" },
            finalUrl: null,
          },
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const executable = join(root, "observed.wrenchplugin");
      packPortableProviderPlugin(source, executable);
      const checked = checkPortableProviderPlugin(executable);
      let spawns = 0;
      const stopObserving =
        observePortableProviderPluginHostProcessForTest({
          beforeSpawn: () => {
            spawns += 1;
          },
        });
      try {
        let rejection = "";
        try {
          await testPortableProviderPlugin(executable, {
            trustExecutableCode: false,
          });
        } catch (error) {
          rejection = error instanceof Error ? error.message : String(error);
        }
        expect(rejection).toContain("requires --trust-code");
        expect(spawns).toBe(0);

        const result = await testPortableProviderPlugin(executable, {
          trustExecutableCode: true,
        });
        expect(result).toMatchObject({
          ok: true,
          pluginId: "observed-web",
          bundleSha256: checked.bundleSha256,
          inert: 0,
          executed: 1,
          fixtures: [{
            result: {
              output: { subject: "account-123", fileRead: true },
              dispatch: { planned: 1, started: 1, verified: 1 },
            },
          }],
        });
        expect(spawns).toBe(1);
      } finally {
        stopObserving();
      }

      const oversizedFileRead = JSON.parse(
        readFileSync(fixturePath, "utf8"),
      ) as Record<string, unknown>;
      const transcript = oversizedFileRead.capabilityTranscript as
        Record<string, unknown>[];
      const firstStep = transcript[0];
      if (firstStep === undefined) {
        throw new Error("portable observed fixture transcript is incomplete");
      }
      firstStep.result = {
        kind: "file.read",
        data: "Zml4dHVyZS1pbnB1dCE=",
        eof: true,
      };
      writeFileSync(
        fixturePath,
        `${JSON.stringify(oversizedFileRead, null, 2)}\n`,
        { mode: 0o600 },
      );
      const oversized = join(root, "observed-oversized.wrenchplugin");
      packPortableProviderPlugin(source, oversized);
      expect(testPortableProviderPlugin(oversized, {
        trustExecutableCode: true,
      })).rejects.toThrow(
        "returned before capability step 2 (session.acquire)",
      );
    });
  });

  test("uses explicit HTTP fixture results and failures without live provider access", async () => {
    await withRoot(async (root) => {
      const source = join(root, "response-plugin");
      const initialized = initPortableProviderPlugin({
        id: "response-web",
        displayName: "Response web",
        surfaceId: "response",
        origin: "https://www.example.com",
        operation: "records.read",
        output: source,
      });
      const binding = initialized.manifest.bindings[0];
      if (binding?.transport !== "web-session-api") {
        throw new Error("portable response fixture is incomplete");
      }
      const operation = binding.operations[0];
      if (operation === undefined) {
        throw new Error("portable response fixture is incomplete");
      }
      const observedBinding: PortableWebSessionApiPluginBindingV1 = {
        ...binding,
        subject: {
          ...binding.subject,
          probe: {
            operation: operation.name,
            contractVersion: operation.contractVersion,
          },
        },
        operations: [{
          ...operation,
          state: "observed",
          implementation: "Deterministic malformed and failure fixture.",
        }],
      };
      writeFileSync(
        join(source, "wrench-plugin.json"),
        renderPortableProviderPluginManifest({
          ...initialized.manifest,
          bindings: [observedBinding],
        }),
        { mode: 0o600 },
      );
      const runtimePath = join(source, "dist", "plugin.mjs");
      writeFileSync(
        runtimePath,
        readFileSync(runtimePath, "utf8").replace(
          `  throw Object.assign(new Error("operation remains capture-required"), {
    code: "CAPTURE_REQUIRED",
  });`,
          `  const malformed = await context.capability({
    kind: "http.request",
    method: "GET",
    url: "https://www.example.com/api/malformed",
    headers: [],
    credentials: [],
    body: { kind: "none" },
    redirect: "error",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
  });
  if (malformed.kind !== "http.request" || malformed.body.kind !== "utf8") {
    throw new Error("invalid response kind");
  }
  return { failureStatus: malformed.status };`,
        ),
        { mode: 0o600 },
      );
      const fixturePath = join(
        source,
        "fixtures",
        "response.records.read.v1.json",
      );
      const capabilityTranscript = [
        {
          request: {
            kind: "http.request",
            method: "GET",
            url: "https://www.example.com/api/malformed",
            headers: [],
            credentials: [],
            body: { kind: "none" },
            redirect: "error",
            timeoutMs: 1_000,
            maxOutputBytes: 4_096,
          },
          result: {
            kind: "http.request",
            status: 503,
            headers: [{ name: "content-type", value: "application/json" }],
            body: { kind: "utf8", text: "{\"unexpected\":true}" },
            finalUrl: "https://www.example.com/api/malformed",
          },
        },
      ];
      const fixture = {
        schemaVersion: 1,
        route: {
          transport: "web-session-api",
          surfaceId: "response",
          operation: "records.read",
          contractVersion: 1,
        },
        input: {},
        auth: { kind: "cookies-file" },
        capabilityTranscript,
        expected: {
          output: {
            failureStatus: 503,
          },
          finalUrl: null,
        },
      };
      writeFileSync(
        fixturePath,
        `${JSON.stringify(fixture, null, 2)}\n`,
        { mode: 0o600 },
      );

      const executable = join(root, "response.wrenchplugin");
      packPortableProviderPlugin(source, executable);
      expect(await testPortableProviderPlugin(executable, {
        trustExecutableCode: true,
      })).toMatchObject({
        ok: true,
        executed: 1,
        fixtures: [{
          result: {
            output: {
              failureStatus: 503,
            },
          },
        }],
      });

      writeFileSync(
        fixturePath,
        `${JSON.stringify({
          ...fixture,
          capabilityTranscript: [
            {
              ...capabilityTranscript[0],
              request: {
                ...capabilityTranscript[0]?.request,
                url: "https://www.example.com/api/different",
              },
            },
          ],
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const mismatched = join(root, "response-mismatch.wrenchplugin");
      packPortableProviderPlugin(source, mismatched);
      expect(testPortableProviderPlugin(mismatched, {
        trustExecutableCode: true,
      })).rejects.toThrow(
        "capability step 1 expected http.request with different fields",
      );

      writeFileSync(
        fixturePath,
        `${JSON.stringify({
          ...fixture,
          capabilityTranscript: [{
            ...capabilityTranscript[0],
            result: {
              ...capabilityTranscript[0]?.result,
              body: { kind: "utf8", text: "é".repeat(2_049) },
            },
          }],
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const oversized = join(root, "response-oversized.wrenchplugin");
      packPortableProviderPlugin(source, oversized);
      expect(testPortableProviderPlugin(oversized, {
        trustExecutableCode: true,
      })).rejects.toThrow(
        "portable provider plugin reported an execution failure",
      );

      writeFileSync(
        fixturePath,
        `${JSON.stringify({
          ...fixture,
          capabilityTranscript: [{
            ...capabilityTranscript[0],
            result: {
              ...capabilityTranscript[0]?.result,
              finalUrl: "https://www.example.com/api/other",
            },
          }],
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const wrongFinalUrl = join(root, "response-final-url.wrenchplugin");
      packPortableProviderPlugin(source, wrongFinalUrl);
      expect(testPortableProviderPlugin(wrongFinalUrl, {
        trustExecutableCode: true,
      })).rejects.toThrow(
        "portable provider plugin reported an execution failure",
      );

      for (const [field, message] of [
        ["files", "portable plugin fixture files are invalid"],
        [
          "capabilityTranscript",
          "portable plugin fixture capabilityTranscript must contain at most",
        ],
      ] as const) {
        writeFileSync(
          fixturePath,
          `${JSON.stringify({
            ...fixture,
            [field]: null,
          }, null, 2)}\n`,
          { mode: 0o600 },
        );
        const invalidNull = join(root, `response-null-${field}.wrenchplugin`);
        packPortableProviderPlugin(source, invalidNull);
        expect(testPortableProviderPlugin(invalidNull, {
          trustExecutableCode: true,
        })).rejects.toThrow(message);
      }
    });
  });

  test("replays complete R2 and R3 dispatch transcripts without network or credentials", async () => {
    await withRoot(async (root) => {
      for (const fixture of [
        { operation: "records.update", risk: "R2" },
        { operation: "records.create", risk: "R3" },
      ] as const) {
        const suffix = fixture.risk.toLowerCase();
        const source = join(root, `mutation-${suffix}`);
        const initialized = initPortableProviderPlugin({
          id: `mutation-${suffix}`,
          displayName: `Mutation ${fixture.risk}`,
          surfaceId: `mutation-${suffix}`,
          origin: "https://api.example.com",
          operation: fixture.operation,
          transport: "provider-api",
          requiredScopeSets: [["records.write"]],
          coverage: [fixture.operation],
          output: source,
        });
        const binding = initialized.manifest.bindings[0];
        if (binding?.transport !== "provider-api") {
          throw new Error("portable mutation fixture is incomplete");
        }
        const operation = binding.operations[0];
        if (operation === undefined) {
          throw new Error("portable mutation fixture is incomplete");
        }
        expect(operation.risk).toBe(fixture.risk);
        writeFileSync(
          join(source, "wrench-plugin.json"),
          renderPortableProviderPluginManifest({
            ...initialized.manifest,
            bindings: [{
              ...binding,
              operations: [{
                ...operation,
                state: "observed",
                implementation: `Deterministic ${fixture.risk} dispatch fixture.`,
              }],
            }],
          }),
          { mode: 0o600 },
        );
        const runtimePath = join(source, "dist", "plugin.mjs");
        writeFileSync(
          runtimePath,
          readFileSync(runtimePath, "utf8").replace(
            `  throw Object.assign(new Error("operation remains capture-required"), {
    code: "CAPTURE_REQUIRED",
  });`,
            `  const material = await context.capability({
    kind: "session.acquire",
    name: "oauth-access-token",
  });
  if (material.kind !== "session.acquire") throw new Error("invalid material");
  const dispatch = await context.capability({
    kind: "dispatch.begin",
    dispatchId: context.route.operation,
  });
  if (dispatch.kind !== "dispatch.begin") throw new Error("invalid dispatch");
  const response = await context.capability({
    kind: "http.request",
    method: "POST",
    url: "https://api.example.com/v1/records",
    headers: [{ name: "content-type", value: "application/json" }],
    credentials: [{
      handle: material.materialHandle,
      sink: { kind: "header", name: "authorization" },
    }],
    body: {
      kind: "utf8",
      mediaType: "application/json",
      text: '{"enabled":true}',
    },
    redirect: "error",
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    dispatchHandle: dispatch.dispatchHandle,
  });
  if (response.kind !== "http.request") throw new Error("invalid response");
  const verification = await context.capability({
    kind: "dispatch.verify",
    dispatchHandle: dispatch.dispatchHandle,
    proof: { status: response.status },
  });
  if (verification.kind !== "dispatch.verify") throw new Error("invalid verification");
  return { accepted: response.status === 201 };`,
          ),
          { mode: 0o600 },
        );
        const materialHandle = `fixture-oauth-${suffix}`;
        const dispatchHandle = `fixture-dispatch-${suffix}`;
        const capabilityTranscript = [
          {
            request: {
              kind: "session.acquire",
              name: "oauth-access-token",
            },
            result: {
              kind: "session.acquire",
              materialHandle,
            },
          },
          {
            request: {
              kind: "dispatch.begin",
              dispatchId: fixture.operation,
            },
            result: {
              kind: "dispatch.begin",
              dispatchHandle,
            },
          },
          {
            request: {
              kind: "http.request",
              method: "POST",
              url: "https://api.example.com/v1/records",
              headers: [{
                name: "content-type",
                value: "application/json",
              }],
              credentials: [{
                handle: materialHandle,
                sink: { kind: "header", name: "authorization" },
              }],
              body: {
                kind: "utf8",
                mediaType: "application/json",
                text: "{\"enabled\":true}",
              },
              redirect: "error",
              timeoutMs: 1_000,
              maxOutputBytes: 4_096,
              dispatchHandle,
            },
            result: {
              kind: "http.request",
              status: 201,
              headers: [{
                name: "content-type",
                value: "application/json",
              }],
              body: { kind: "utf8", text: "{\"accepted\":true}" },
              finalUrl: "https://api.example.com/v1/records",
            },
          },
          {
            request: {
              kind: "dispatch.verify",
              dispatchHandle,
              proof: { status: 201 },
            },
            result: { kind: "dispatch.verify", verified: true },
          },
        ];
        writeFileSync(
          join(
            source,
            "fixtures",
            `mutation-${suffix}.${fixture.operation}.v1.json`,
          ),
          `${JSON.stringify({
            schemaVersion: 1,
            route: {
              transport: "provider-api",
              surfaceId: `mutation-${suffix}`,
              operation: fixture.operation,
              contractVersion: 1,
            },
            input: {},
            auth: { kind: "oauth-token-file" },
            capabilityTranscript,
            expected: {
              output: { accepted: true },
              finalUrl: null,
            },
          }, null, 2)}\n`,
          { mode: 0o600 },
        );

        const executable = join(root, `mutation-${suffix}.wrenchplugin`);
        packPortableProviderPlugin(source, executable);
        expect(await testPortableProviderPlugin(executable, {
          trustExecutableCode: true,
        })).toMatchObject({
          ok: true,
          inert: 0,
          executed: 1,
          fixtures: [{
            result: {
              output: { accepted: true },
              dispatch: { planned: 1, started: 1, verified: 1 },
            },
          }],
        });
      }
    });
  });

  test("packing refreshes declared hashes but refuses undeclared files and existing outputs", async () => {
    await withRoot((root) => {
      const source = join(root, "example-plugin");
      initPortableProviderPlugin({
        id: "example-web",
        displayName: "Example web",
        surfaceId: "example",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: source,
      });
      const original = checkPortableProviderPlugin(source);
      writeFileSync(
        join(source, "dist", "plugin.mjs"),
        `${readFileSync(join(source, "dist", "plugin.mjs"), "utf8")}\n`,
        { mode: 0o600 },
      );
      expect(() => checkPortableProviderPlugin(source)).toThrow(
        "does not match",
      );

      const output = join(root, "refreshed.wrenchplugin");
      const packed = packPortableProviderPlugin(source, output);
      expect(packed.bundleSha256).not.toBe(original.bundleSha256);
      expect(checkPortableProviderPlugin(output).bundleSha256)
        .toBe(packed.bundleSha256);
      expect(() => packPortableProviderPlugin(source, output))
        .toThrow("already exists");

      writeFileSync(join(source, "undeclared.txt"), "not declared\n", {
        mode: 0o600,
      });
      expect(() =>
        packPortableProviderPlugin(
          source,
          join(root, "undeclared.wrenchplugin"),
        )).toThrow("exactly match");
    });
  });

  test("check applies activation projection at the 48-character adapter boundary", async () => {
    await withRoot((root) => {
      const adapter48 = `a${"b".repeat(47)}`;
      const surface48 = `s${"u".repeat(47)}`;
      const valid = join(root, "valid-boundaries");
      initPortableProviderPlugin({
        id: adapter48,
        displayName: "Valid boundaries",
        surfaceId: surface48,
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: valid,
      });
      expect(checkPortableProviderPlugin(valid)).toMatchObject({
        id: adapter48,
      });

      const adapter49 = `a${"b".repeat(48)}`;
      const invalidAdapter = join(root, "invalid-adapter");
      initPortableProviderPlugin({
        id: "invalid-adapter",
        displayName: "Invalid adapter",
        surfaceId: "adapter-boundary",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: invalidAdapter,
      });
      replaceManifestText(
        invalidAdapter,
        '"adapterId": "invalid-adapter"',
        `"adapterId": "${adapter49}"`,
      );
      expect(() => checkPortableProviderPlugin(invalidAdapter)).toThrow(
        "binding projection 0 adapterId must be lowercase kebab-case with at most 48 characters",
      );

      const surface49 = `s${"u".repeat(48)}`;
      const longSurface = join(root, "long-surface");
      initPortableProviderPlugin({
        id: "long-surface",
        displayName: "Long surface",
        surfaceId: "surface-boundary",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: longSurface,
      });
      replaceManifestText(
        longSurface,
        '"surfaceId": "surface-boundary"',
        `"surfaceId": "${surface49}"`,
      );
      expect(checkPortableProviderPlugin(longSurface)).toMatchObject({
        id: "long-surface",
      });
    });
  });

  test("check applies activation registry validation to candidate-internal routes", async () => {
    await withRoot((root) => {
      const source = join(root, "duplicate-session-route");
      const initialized = initPortableProviderPlugin({
        id: "duplicate-session-route",
        displayName: "Duplicate session route",
        surfaceId: "shared-surface",
        origin: "https://www.example.com",
        operation: "feeds.read",
        output: source,
      });
      const webBinding = initialized.manifest.bindings[0];
      if (webBinding?.transport !== "web-session-api") {
        throw new Error("portable plugin fixture lost its web-session binding");
      }
      const linkedBinding = {
        ...webBinding,
        transport: "linked-device",
        adapterId: "duplicate-linked",
        authKinds: ["linked-device-store"],
      } satisfies PortableLinkedDevicePluginBindingV1;
      const manifest = {
        ...initialized.manifest,
        bindings: [linkedBinding, webBinding],
      } satisfies PortableProviderPluginManifestV1;
      writeFileSync(
        join(source, "wrench-plugin.json"),
        renderPortableProviderPluginManifest(manifest),
        { mode: 0o600 },
      );

      expect(() => checkPortableProviderPlugin(source)).toThrow(
        "duplicate provider plugin session route",
      );
    });
  });
});
