import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { canonicalJson } from "./canonical-json";
import {
  derivePortableProviderPluginMinimumRisk,
  LEGACY_PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
  parsePortableProviderPluginManifest,
  PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
  renderPortableProviderPluginManifest,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginFileV1,
  type PortableProviderApiPluginOperationV1,
  type PortableProviderPluginBindingV1,
  type PortableProviderPluginManifestV1,
  type PortableWebSessionPluginOperationV1,
  type VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  runPortableProviderPluginHost,
  type PortableProviderPluginCapabilityContext,
  type PortableProviderPluginCapabilityHost,
  type PortableProviderPluginHostResult,
} from "./provider-plugin-host";
import {
  projectPortableProviderPluginPackage,
} from "./provider-plugin-portable-catalog";
import {
  createProviderPluginRegistry,
  extendProviderPluginRegistryWithPortablePlugins,
} from "./provider-plugin-registry";
import {
  recoverPortableProviderPluginInvocationLeaseTombstones,
  type PortableProviderPluginInvocationLeaseRepairReport,
} from "./provider-plugin-invocation-lease";
import {
  assertPortableProviderPluginTrustApprovalMatches,
  disablePortableProviderPluginPackage,
  installPortableProviderPluginPackage,
  listPortableProviderPluginInstallations,
  loadPortableProviderPluginInstallation,
  parsePortableProviderPluginTrustApproval,
  removePortableProviderPluginPackage,
  type InstalledPortableProviderPlugin,
  type PortableProviderPluginAssertActivatable,
  type PortableProviderPluginAssertQuiescent,
} from "./provider-plugin-store";
import type {
  PortablePluginCapabilityRequest,
  PortablePluginCapabilityResult,
  PortablePluginInvocationAuth,
  PortablePluginInvocationFile,
  PortablePluginJsonObject,
  PortablePluginJsonValue,
  PortablePluginRoute,
} from "./provider-plugin-protocol";
import {
  PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
  normalizePortablePluginJsonObject,
  normalizePortablePluginJsonValue,
  parsePortableProviderPluginMessage,
} from "./provider-plugin-protocol";
import {
  readRegularFile,
  removePrivateDirectoryTree,
  wrenchStateHome,
} from "./storage";

const MAX_AUTHORING_MANIFEST_BYTES = 256 * 1024;
const MAX_AUTHORING_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 1024 * 1024;
const MAX_FIXTURE_CAPABILITY_STEPS = 128;
const MAX_AUTHORING_FILES = 256;
const MAX_AUTHORING_PARENT_ENTRIES = 10_000;
const MAX_ABANDONED_AUTHORING_STAGES = 64;
const authoringStageUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Environment = Readonly<Record<string, string | undefined>>;

export type PortableProviderPluginSummary = {
  readonly id: string;
  readonly version: string;
  readonly displayName: string;
  readonly bundleSha256: string;
  readonly manifestSha256: string;
  readonly sourceKind: "portable";
  readonly execution: "trusted-child-process";
  readonly sandboxed: false;
  readonly activation: "uninstalled" | "enabled" | "disabled";
  readonly bindings: number;
  readonly operations: number;
  readonly capabilities: PortableProviderPluginManifestV1["capabilities"];
};

export type PortableProviderPluginFixtureV1 = {
  readonly schemaVersion: 1;
  readonly route: PortablePluginRoute;
  readonly input: PortablePluginJsonObject;
  readonly auth: Omit<PortablePluginInvocationAuth, "handle">;
  readonly files: readonly PortablePluginInvocationFile[];
  readonly capabilityTranscript: readonly {
    readonly request: PortablePluginCapabilityRequest;
    readonly result: PortablePluginCapabilityResult;
  }[];
  readonly expected: {
    readonly output: PortablePluginJsonValue;
    readonly finalUrl: string | null;
  };
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function pluginStoreRoot(environment: Environment): string {
  return join(wrenchStateHome(environment), "provider-plugins");
}

export function portableProviderPluginStoreRoot(
  environment: Environment = process.env,
): string {
  return pluginStoreRoot(environment);
}

function packageSummary(
  packageValue: VerifiedPortableProviderPluginPackage,
  activation: PortableProviderPluginSummary["activation"],
): PortableProviderPluginSummary {
  const operations = packageValue.manifest.bindings.reduce(
    (count, binding) => count + binding.operations.length,
    0,
  );
  return Object.freeze({
    id: packageValue.manifest.id,
    version: packageValue.manifest.version,
    displayName: packageValue.manifest.displayName,
    bundleSha256: packageValue.bundleSha256,
    manifestSha256: packageValue.manifestSha256,
    sourceKind: "portable",
    execution: "trusted-child-process",
    sandboxed: false,
    activation,
    bindings: packageValue.manifest.bindings.length,
    operations,
    capabilities: packageValue.manifest.capabilities,
  });
}

function summary(
  installed: InstalledPortableProviderPlugin,
): PortableProviderPluginSummary {
  return packageSummary(installed.package, installed.active.status);
}

export function listPortableProviderPlugins(
  environment: Environment = process.env,
): readonly PortableProviderPluginSummary[] {
  return Object.freeze(
    listPortableProviderPluginInstallations(pluginStoreRoot(environment))
      .map(summary),
  );
}

export function showPortableProviderPlugin(
  id: string,
  environment: Environment = process.env,
): {
  readonly summary: PortableProviderPluginSummary;
  readonly manifest: PortableProviderPluginManifestV1;
  readonly trust: InstalledPortableProviderPlugin["trust"];
  readonly active: InstalledPortableProviderPlugin["active"];
} | null {
  const installed = loadPortableProviderPluginInstallation(
    pluginStoreRoot(environment),
    id,
  );
  if (installed === null) return null;
  return Object.freeze({
    summary: summary(installed),
    manifest: installed.package.manifest,
    trust: installed.trust,
    active: installed.active,
  });
}

export function checkPortableProviderPlugin(
  pathValue: string,
): PortableProviderPluginSummary & {
  readonly path: string;
  readonly payloadBytes: number;
} {
  const packageValue = verifyPortableProviderPluginPackageDirectory(pathValue);
  // Mirror activation's package-local checks before any package code runs.
  const projected = projectPortableProviderPluginPackage(packageValue);
  extendProviderPluginRegistryWithPortablePlugins(
    createProviderPluginRegistry([]),
    [projected],
  );
  return Object.freeze({
    ...packageSummary(packageValue, "uninstalled"),
    path: packageValue.root,
    payloadBytes: packageValue.payloadBytes,
  });
}

export function installPortableProviderPlugin(
  pathValue: string,
  options: {
    readonly trustExecutableCode: boolean;
    readonly expectedCurrentBundleSha256: string | null;
    readonly assertActivatable: PortableProviderPluginAssertActivatable;
    readonly assertCurrentQuiescent: PortableProviderPluginAssertQuiescent;
    readonly environment?: Environment;
    readonly now?: Date;
  },
): PortableProviderPluginSummary {
  if (!options.trustExecutableCode) {
    throw new Error(
      "portable plugin installation requires --trust-code because a child process is isolation, not a hostile-code sandbox",
    );
  }
  const packageValue = verifyPortableProviderPluginPackageDirectory(pathValue);
  const installed = installPortableProviderPluginPackage(pathValue, {
    storeRoot: pluginStoreRoot(options.environment ?? process.env),
    approval: {
      decision: "trust-executable-code",
      pluginId: packageValue.manifest.id,
      pluginVersion: packageValue.manifest.version,
      bundleSha256: packageValue.bundleSha256,
    },
    expectedCurrentBundleSha256: options.expectedCurrentBundleSha256,
    assertActivatable: options.assertActivatable,
    assertCurrentQuiescent: options.assertCurrentQuiescent,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return summary(installed);
}

export function disablePortableProviderPlugin(
  id: string,
  options: {
    readonly expectedBundleSha256: string;
    readonly assertQuiescent: PortableProviderPluginAssertQuiescent;
    readonly environment?: Environment;
    readonly now?: Date;
  },
): PortableProviderPluginSummary {
  return summary(disablePortableProviderPluginPackage(
    pluginStoreRoot(options.environment ?? process.env),
    id,
    {
      expectedBundleSha256: options.expectedBundleSha256,
      assertQuiescent: options.assertQuiescent,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  ));
}

export function removePortableProviderPlugin(
  id: string,
  options: {
    readonly expectedBundleSha256: string;
    readonly assertQuiescent: PortableProviderPluginAssertQuiescent;
    readonly environment?: Environment;
    readonly now?: Date;
  },
): PortableProviderPluginSummary & {
  readonly activation: "uninstalled";
  readonly retainedAuditArtifact: true;
} {
  const removed = removePortableProviderPluginPackage(
    pluginStoreRoot(options.environment ?? process.env),
    id,
    {
      expectedBundleSha256: options.expectedBundleSha256,
      assertQuiescent: options.assertQuiescent,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
  return Object.freeze({
    ...packageSummary(removed.package, "uninstalled"),
    activation: "uninstalled",
    retainedAuditArtifact: true,
  });
}

function safeAuthoringPath(
  pathValue: string,
  label: string,
): string {
  const path = resolve(pathValue);
  const parent = dirname(path);
  const stats = lstatSync(parent);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} parent must be one real directory`);
  }
  try {
    lstatSync(path);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (
      error instanceof Error
      && error.message === `${label} already exists`
    ) throw error;
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) {
      throw new Error(`${label} could not be inspected`);
    }
  }
  return path;
}

type PortableProviderPluginAuthoringStageKind = "init" | "pack";

function recoverAbandonedAuthoringStages(
  output: string,
  kind: PortableProviderPluginAuthoringStageKind,
): void {
  const parent = dirname(output);
  const outputName = basename(output);
  const prefixes = [
    `.${outputName}.wrench-plugin-${kind}-`,
    `.${outputName}.oh-plugin-${kind}-`,
  ] as const;
  const stages: {
    readonly path: string;
    readonly identity: { readonly device: string; readonly inode: string };
  }[] = [];
  const directory = opendirSync(parent);
  try {
    for (let entriesRead = 0;; entriesRead += 1) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entriesRead >= MAX_AUTHORING_PARENT_ENTRIES) {
        throw new Error(
          `portable plugin ${kind} recovery exceeds its ${MAX_AUTHORING_PARENT_ENTRIES} parent-entry bound`,
        );
      }
      const prefix = prefixes.find((candidate) => entry.name.startsWith(candidate));
      if (
        prefix === undefined
        || !authoringStageUuidPattern.test(entry.name.slice(prefix.length))
      ) continue;
      if (stages.length >= MAX_ABANDONED_AUTHORING_STAGES) {
        throw new Error(
          `portable plugin ${kind} recovery found more than ${MAX_ABANDONED_AUTHORING_STAGES} exact abandoned stages`,
        );
      }
      const path = join(parent, entry.name);
      const stats = lstatSync(path, { bigint: true });
      const currentUid = typeof process.getuid === "function"
        ? BigInt(process.getuid())
        : stats.uid;
      if (
        entry.isSymbolicLink()
        || !entry.isDirectory()
        || !stats.isDirectory()
        || stats.isSymbolicLink()
        || stats.uid !== currentUid
        || (stats.mode & 0o777n) !== 0o700n
      ) {
        throw new Error(
          `portable plugin ${kind} abandoned stage is not a private current-user directory: ${path}`,
        );
      }
      stages.push({
        path,
        identity: {
          device: stats.dev.toString(),
          inode: stats.ino.toString(),
        },
      });
    }
  } finally {
    directory.closeSync();
  }
  for (const stage of stages) {
    if (!removePrivateDirectoryTree(stage.path, stage.identity)) {
      throw new Error(`portable plugin ${kind} abandoned stage disappeared during recovery`);
    }
  }
}

function pauseAfterAuthoringStageForTest(
  kind: PortableProviderPluginAuthoringStageKind,
): void {
  if (
    process.env.NODE_ENV !== "test"
    || process.env.WRENCH_TEST_PLUGIN_AUTHORING_STAGE_FAULT !== kind
  ) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  if (Atomics.wait(signal, 0, 0, 60_000) === "timed-out") {
    throw new Error(`portable plugin ${kind} stage test pause expired`);
  }
}

function writePrivateAuthoringFile(path: string, bytes: Uint8Array | string): void {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function runtimeTemplate(): string {
  return `import { createInterface } from "node:readline";

let invocation = null;
let running = null;
const pending = new Map();
const send = (value) => process.stdout.write(\`\${JSON.stringify(value)}\\n\`);

async function invoke(context) {
  // Replace this inert reservation only after capturing authorized provider
  // evidence and updating wrench-plugin.json to state "observed".
  throw Object.assign(new Error("operation remains capture-required"), {
    code: "CAPTURE_REQUIRED",
  });
}

const capability = (request) => new Promise((resolve, reject) => {
  const requestId = crypto.randomUUID();
  pending.set(requestId, { resolve, reject });
  send({
    protocolVersion: 1,
    kind: "plugin.capability.request",
    invocationId: invocation.invocationId,
    requestId,
    request,
  });
});

async function runInvocation(message) {
  invocation = message;
  try {
    const output = await invoke({
      route: message.route,
      input: message.input,
      auth: message.auth,
      files: message.files,
      capability,
    });
    send({
      protocolVersion: 1,
      kind: "plugin.result",
      invocationId: message.invocationId,
      output,
      finalUrl: null,
    });
  } catch (error) {
    send({
      protocolVersion: 1,
      kind: "plugin.error",
      stage: "invocation",
      invocationId: message.invocationId,
      code: typeof error?.code === "string" ? error.code : "PLUGIN_FAILED",
      message: "plugin invocation failed",
    });
  } finally {
    invocation = null;
  }
}

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
  if (message.kind === "host.capability.result") {
    pending.get(message.requestId)?.resolve(message.result);
    pending.delete(message.requestId);
    continue;
  }
  if (message.kind === "host.capability.error") {
    pending.get(message.requestId)?.reject(
      Object.assign(new Error(message.error.message), {
        code: message.error.code,
      }),
    );
    pending.delete(message.requestId);
    continue;
  }
  if (message.kind !== "host.invoke") continue;
  if (running !== null) {
    send({
      protocolVersion: 1,
      kind: "plugin.error",
      stage: "invocation",
      invocationId: message.invocationId,
      code: "INVOCATION_IN_PROGRESS",
      message: "plugin invocation failed",
    });
    continue;
  }
  running = runInvocation(message).finally(() => {
    running = null;
  });
}
await running;
`;
}

function guideTemplate(
  id: string,
  surfaceId: string,
  operation: string,
): string {
  return `# Contents

- \`wrench-plugin.json\` – strict static identity, capability ceiling, adapter, and operation descriptor.
- \`dist/plugin.mjs\` – self-contained child-process runtime; it may use only the versioned Wrench message protocol.
- \`fixtures/\` – secret-free deterministic invocation fixtures.

# Guidelines

- Keep ${id}/${surfaceId}/${operation} capture-required until authorized evidence proves its exact request, response, account, and reconciliation semantics.
- Parse every foreign value from unknown and reject extra fields.
- Ask Wrench for declared capabilities; never read WRENCH_STATE_HOME, browser profiles, token files, or arbitrary filesystem paths.
- Give each observed operation fixture bounded \`files\` metadata and an exact ordered \`capabilityTranscript\`. Each step contains one bounded \`request\` and \`result\`, including explicit failure statuses and malformed response shapes; plugin tests never use live credentials or the network.
- A child process isolates crashes and dependencies but is not a hostile-code sandbox. Testing and installation require explicit executable-code trust.
- Run \`wrench plugin check .\`, \`wrench plugin test . --trust-code\`, and \`wrench plugin pack . --output ../${id}.wrenchplugin\` after each change.
`;
}

export function initPortableProviderPlugin(options: {
  readonly id: string;
  readonly displayName: string;
  readonly surfaceId: string;
  readonly origin: string;
  readonly operation: string;
  readonly transport?:
    PortableProviderPluginManifestV1["bindings"][number]["transport"];
  readonly requiredScopeSets?: readonly (readonly string[])[];
  readonly coverage?: readonly string[];
  readonly output: string;
}): {
  readonly path: string;
  readonly manifest: PortableProviderPluginManifestV1;
  readonly bundleSha256: string;
} {
  const output = safeAuthoringPath(options.output, "portable plugin output");
  recoverAbandonedAuthoringStages(output, "init");
  const stage = join(
    dirname(output),
    `.${basename(output)}.wrench-plugin-init-${crypto.randomUUID()}`,
  );
  mkdirSync(stage, { mode: 0o700 });
  try {
    pauseAfterAuthoringStageForTest("init");
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(options.origin);
    } catch {
      throw new Error("portable plugin init origin must be exact canonical HTTPS");
    }
    if (
      parsedOrigin.protocol !== "https:"
      || parsedOrigin.username !== ""
      || parsedOrigin.password !== ""
      || parsedOrigin.pathname !== "/"
      || parsedOrigin.search !== ""
      || parsedOrigin.hash !== ""
      || parsedOrigin.origin !== options.origin
    ) {
      throw new Error("portable plugin init origin must be exact canonical HTTPS");
    }
    const origin = parsedOrigin.origin as `https://${string}`;
    const transport = options.transport ?? "web-session-api";
    if (
      transport === "provider-api"
      && (
        options.requiredScopeSets === undefined
        || options.coverage === undefined
      )
    ) {
      throw new Error(
        "provider-api portable plugin init requires explicit requiredScopeSets and coverage",
      );
    }
    if (
      transport !== "provider-api"
      && (
        options.requiredScopeSets !== undefined
        || options.coverage !== undefined
      )
    ) {
      throw new Error(
        "only provider-api portable plugins may declare scope sets and coverage",
      );
    }
    const authKinds = transport === "provider-api"
      ? ["oauth-token-file"] as const
      : transport === "linked-device"
        ? ["linked-device-store"] as const
        : [
            "browser-profile",
            "cookie-source",
            "cookies-file",
          ] as const;
    const sessionMaterial: PortableProviderPluginManifestV1["capabilities"]["sessionMaterial"] = transport === "provider-api"
      ? ["oauth-access-token"]
      : transport === "web-session-api"
        ? ["cookie-jar"]
        : [];
    mkdirSync(join(stage, "dist"), { mode: 0o700 });
    mkdirSync(join(stage, "fixtures"), { mode: 0o700 });
    const runtime = Buffer.from(runtimeTemplate(), "utf8");
    const guide = Buffer.from(
      guideTemplate(options.id, options.surfaceId, options.operation),
      "utf8",
    );
    const fixtureName =
      `fixtures/${options.surfaceId}.${options.operation}.v1.json`;
    const fixture = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      route: {
        transport,
        surfaceId: options.surfaceId,
        operation: options.operation,
        contractVersion: 1,
      },
      input: {},
      auth: {
        kind: authKinds[0],
      },
      files: [],
      capabilityTranscript: [],
      expected: {
        output: null,
        finalUrl: null,
      },
    }, null, 2)}\n`, "utf8");
    const risk = derivePortableProviderPluginMinimumRisk(options.operation);
    const dispatch = risk === "R2" || risk === "R3" ? "single" : "none";
    const baseOperation: PortableWebSessionPluginOperationV1 = {
      name: options.operation,
      contractVersion: 1,
      timeoutMs: 30_000,
      maxOutputBytes: 256 * 1024,
      state: "capture-required",
      risk,
      dispatch,
      sideEffect: dispatch === "none"
        ? "none"
        : "capture-required remote side effect",
      idempotency: dispatch === "none"
        ? "none"
        : "local-at-most-once",
      dedupeWindowMs: dispatch === "none" ? 0 : 60_000,
      input: {
        properties: {},
        required: [],
      },
      implementation:
        "Network-inert reservation awaiting authorized provider evidence.",
    };
    const providerOperation: PortableProviderApiPluginOperationV1 | null =
      transport === "provider-api"
        ? {
            ...baseOperation,
            requiredScopeSets: options.requiredScopeSets
              ?? (() => {
                throw new Error(
                  "provider-api portable plugin init requires scope sets",
                );
              })(),
            coverage: options.coverage
              ?? (() => {
                throw new Error(
                  "provider-api portable plugin init requires coverage",
                );
              })(),
          }
        : null;
    const binding: PortableProviderPluginBindingV1 =
      transport === "provider-api"
        ? (() => {
            if (providerOperation === null) {
              throw new Error(
                "provider-api portable plugin operation disappeared",
              );
            }
            return {
              transport,
              adapterId: options.id,
              surfaceId: options.surfaceId,
              origin,
              authKinds: ["oauth-token-file"] as const,
              subject: {
                format: "bounded provider account identifier",
                kind: "opaque-token" as const,
                probe: null,
              },
              operations: [providerOperation],
            };
          })()
        : transport === "linked-device"
          ? {
              transport,
              adapterId: options.id,
              surfaceId: options.surfaceId,
              origin,
              authKinds: ["linked-device-store"],
              subject: {
                format: "bounded linked-device account identifier",
                kind: "opaque-token",
                probe: null,
              },
              operations: [baseOperation],
            }
          : {
              transport,
              adapterId: options.id,
              surfaceId: options.surfaceId,
              origin,
              authKinds: [
                "browser-profile",
                "cookie-source",
                "cookies-file",
              ],
              subject: {
                format: "bounded signed-in account identifier",
                kind: "opaque-token",
                probe: null,
              },
              operations: [baseOperation],
            };
    const manifest: PortableProviderPluginManifestV1 = {
      schemaVersion: 1,
      hostApiVersion: 1,
      id: options.id,
      version: "0.1.0",
      displayName: options.displayName,
      runtime: {
        kind: "bun-js",
        entrypoint: "dist/plugin.mjs",
      },
      provenance: { kind: "local" },
      capabilities: {
        networkOrigins: [origin],
        planFiles: "none",
        state: "none",
        sessionMaterial,
      },
      bindings: [binding],
      files: [
        fileRecord("AGENTS.md", "data", guide),
        fileRecord("dist/plugin.mjs", "runtime", runtime),
        fileRecord(fixtureName, "data", fixture),
      ],
    };
    writePrivateAuthoringFile(join(stage, "AGENTS.md"), guide);
    writePrivateAuthoringFile(join(stage, "dist", "plugin.mjs"), runtime);
    writePrivateAuthoringFile(join(stage, ...fixtureName.split("/")), fixture);
    writePrivateAuthoringFile(
      join(stage, "wrench-plugin.json"),
      renderPortableProviderPluginManifest(manifest),
    );
    const verified = verifyPortableProviderPluginPackageDirectory(stage);
    renameSync(stage, output);
    return Object.freeze({
      path: output,
      manifest: verified.manifest,
      bundleSha256: verified.bundleSha256,
    });
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function fileRecord(
  path: string,
  kind: PortableProviderPluginFileV1["kind"],
  bytes: Uint8Array,
): PortableProviderPluginFileV1 {
  return Object.freeze({
    path,
    kind,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

function sourceManifestName(source: string): string {
  const names = [
    PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
    LEGACY_PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
  ].filter((name) => existsSync(join(source, name)));
  if (names.length === 0) {
    throw new Error(
      `portable plugin source is missing ${PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME}`,
    );
  }
  if (names.length > 1) {
    throw new Error(
      `portable plugin source must contain exactly one of ${names.join(" or ")}`,
    );
  }
  const name = names[0];
  if (name === undefined) throw new Error("portable plugin manifest selection failed");
  return name;
}

function readSourceManifest(source: string): {
  readonly name: string;
  readonly value: PortableProviderPluginManifestV1;
} {
  const name = sourceManifestName(source);
  const text = readRegularFile(
    join(source, name),
    MAX_AUTHORING_MANIFEST_BYTES,
    "portable plugin authoring manifest",
  );
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("portable plugin authoring manifest must contain JSON");
  }
  const parsed = parsePortableProviderPluginManifest(value);
  if (!parsed.ok) {
    throw new Error(
      `portable plugin authoring manifest is invalid: ${parsed.issues.join("; ")}`,
    );
  }
  return { name, value: parsed.value };
}

function readDeclaredSourceFile(
  source: string,
  file: PortableProviderPluginFileV1,
): Buffer {
  const path = join(source, ...file.path.split("/"));
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile()
      || stats.size < 1
      || stats.size > MAX_AUTHORING_FILE_BYTES
    ) {
      throw new Error(`portable plugin source file ${file.path} is invalid`);
    }
    return readFileSync(descriptor);
  } finally {
    // Node's descriptor is closed by readFileSync only when it opened the
    // path, not when it receives the caller's descriptor.
    closeSync(descriptor);
  }
}

function authoringFiles(source: string): readonly string[] {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    const directory = relativeDirectory === ""
      ? source
      : join(source, ...relativeDirectory.split("/"));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`portable plugin source contains symlink ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visit(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
        if (files.length > MAX_AUTHORING_FILES + 1) {
          throw new Error("portable plugin source contains too many files");
        }
      } else {
        throw new Error(
          `portable plugin source contains unsupported entry ${relativePath}`,
        );
      }
    }
  };
  visit("");
  return Object.freeze(files.sort());
}

export function packPortableProviderPlugin(
  sourceValue: string,
  outputValue: string,
): {
  readonly path: string;
  readonly bundleSha256: string;
  readonly manifestSha256: string;
} {
  const source = resolve(sourceValue);
  const sourceStats = lstatSync(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error("portable plugin source must be one real directory");
  }
  const output = safeAuthoringPath(outputValue, "portable plugin package output");
  recoverAbandonedAuthoringStages(output, "pack");
  const sourceManifest = readSourceManifest(source);
  const manifest = sourceManifest.value;
  const actualFiles = authoringFiles(source)
    .filter((path) => path !== sourceManifest.name);
  const declaredFiles = manifest.files.map((file) => file.path);
  if (
    actualFiles.length !== declaredFiles.length
    || actualFiles.some((path, index) => path !== declaredFiles[index])
  ) {
    throw new Error(
      "portable plugin source files must exactly match its static manifest before packing",
    );
  }
  const payload = new Map<string, Buffer>();
  const refreshedFiles = manifest.files.map((file) => {
    const bytes = readDeclaredSourceFile(source, file);
    payload.set(file.path, bytes);
    return fileRecord(file.path, file.kind, bytes);
  });
  const refreshed: PortableProviderPluginManifestV1 = {
    ...manifest,
    files: Object.freeze(refreshedFiles),
  };
  const stage = join(
    dirname(output),
    `.${basename(output)}.wrench-plugin-pack-${crypto.randomUUID()}`,
  );
  mkdirSync(stage, { mode: 0o700 });
  try {
    pauseAfterAuthoringStageForTest("pack");
    for (const file of refreshed.files) {
      const destination = join(stage, ...file.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const bytes = payload.get(file.path);
      if (bytes === undefined) {
        throw new Error("portable plugin pack omitted a declared file");
      }
      writePrivateAuthoringFile(destination, bytes);
    }
    writePrivateAuthoringFile(
      join(stage, "wrench-plugin.json"),
      renderPortableProviderPluginManifest(refreshed),
    );
    const verified = verifyPortableProviderPluginPackageDirectory(stage);
    renameSync(stage, output);
    return Object.freeze({
      path: output,
      bundleSha256: verified.bundleSha256,
      manifestSha256: verified.manifestSha256,
    });
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function parseFixtureCapabilityRequest(
  value: unknown,
  index: number,
): PortablePluginCapabilityRequest {
  const parsed = parsePortableProviderPluginMessage({
    protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
    kind: "plugin.capability.request",
    invocationId: "fixture-invocation",
    requestId: `fixture-step-${index + 1}`,
    request: value,
  });
  if (!parsed.ok) {
    throw new Error(
      `portable plugin fixture capabilityTranscript[${index}].request is invalid: ${parsed.issues.join("; ")}`,
    );
  }
  if (parsed.value.kind !== "plugin.capability.request") {
    throw new Error("portable plugin fixture capability request parser drifted");
  }
  if (parsed.value.request.kind === "log.write") {
    throw new Error(
      `portable plugin fixture capabilityTranscript[${index}] must not include log.write because the host acknowledges bounded logs directly`,
    );
  }
  return parsed.value.request;
}

function parseFixtureCapabilityResult(
  value: unknown,
  request: PortablePluginCapabilityRequest,
  index: number,
): PortablePluginCapabilityResult {
  const parsed = parsePortableProviderPluginMessage({
    protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
    kind: "host.capability.result",
    invocationId: "fixture-invocation",
    requestId: `fixture-step-${index + 1}`,
    result: value,
  });
  if (!parsed.ok) {
    throw new Error(
      `portable plugin fixture capabilityTranscript[${index}].result is invalid: ${parsed.issues.join("; ")}`,
    );
  }
  if (parsed.value.kind !== "host.capability.result") {
    throw new Error("portable plugin fixture capability result parser drifted");
  }
  if (parsed.value.result.kind !== request.kind) {
    throw new Error(
      `portable plugin fixture capabilityTranscript[${index}] result kind must match ${request.kind}`,
    );
  }
  return parsed.value.result;
}

function parseFixtureCapabilityTranscript(
  value: unknown,
): PortableProviderPluginFixtureV1["capabilityTranscript"] {
  if (
    !Array.isArray(value)
    || value.length > MAX_FIXTURE_CAPABILITY_STEPS
  ) {
    throw new Error(
      `portable plugin fixture capabilityTranscript must contain at most ${MAX_FIXTURE_CAPABILITY_STEPS} steps`,
    );
  }
  return Object.freeze(value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(
        `portable plugin fixture capabilityTranscript[${index}] must be an object`,
      );
    }
    exactKeys(
      candidate,
      ["request", "result"],
      `portable plugin fixture capabilityTranscript[${index}]`,
    );
    const request = parseFixtureCapabilityRequest(candidate.request, index);
    return Object.freeze({
      request,
      result: parseFixtureCapabilityResult(candidate.result, request, index),
    });
  }));
}

function parseFixtureFiles(
  value: unknown,
  route: PortablePluginRoute,
  input: PortablePluginJsonObject,
  auth: Omit<PortablePluginInvocationAuth, "handle">,
): readonly PortablePluginInvocationFile[] {
  const parsed = parsePortableProviderPluginMessage({
    protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
    kind: "host.invoke",
    invocationId: "fixture-invocation",
    route,
    input,
    auth: { ...auth, handle: "fixture-auth" },
    files: value === undefined ? [] : value,
    timeoutMs: 5_000,
  });
  if (!parsed.ok) {
    throw new Error(
      `portable plugin fixture files are invalid: ${parsed.issues.join("; ")}`,
    );
  }
  if (parsed.value.kind !== "host.invoke") {
    throw new Error("portable plugin fixture file parser drifted");
  }
  return parsed.value.files;
}

function parseFixture(
  value: unknown,
): PortableProviderPluginFixtureV1 {
  if (!isRecord(value)) throw new Error("portable plugin fixture must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "route",
      "input",
      "auth",
      ...(value.files === undefined ? [] : ["files"]),
      ...(value.capabilityTranscript === undefined
        ? []
        : ["capabilityTranscript"]),
      "expected",
    ],
    "portable plugin fixture",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("portable plugin fixture schemaVersion is unsupported");
  }
  if (!isRecord(value.route)) throw new Error("portable plugin fixture route is invalid");
  exactKeys(
    value.route,
    ["transport", "surfaceId", "operation", "contractVersion"],
    "portable plugin fixture route",
  );
  if (
    value.route.transport !== "provider-api"
    && value.route.transport !== "web-session-api"
    && value.route.transport !== "linked-device"
  ) {
    throw new Error("portable plugin fixture transport is invalid");
  }
  if (
    typeof value.route.surfaceId !== "string"
    || typeof value.route.operation !== "string"
    || typeof value.route.contractVersion !== "number"
    || !Number.isSafeInteger(value.route.contractVersion)
  ) {
    throw new Error("portable plugin fixture route is invalid");
  }
  if (!isRecord(value.auth)) throw new Error("portable plugin fixture auth is invalid");
  const authKeys = [
    "kind",
    ...(value.auth.subject === undefined ? [] : ["subject"]),
  ];
  exactKeys(value.auth, authKeys, "portable plugin fixture auth");
  if (
    value.auth.kind !== "cookie-source"
    && value.auth.kind !== "cookies-file"
    && value.auth.kind !== "browser-profile"
    && value.auth.kind !== "oauth-token-file"
    && value.auth.kind !== "linked-device-store"
  ) {
    throw new Error("portable plugin fixture auth kind is invalid");
  }
  if (
    value.auth.subject !== undefined
    && typeof value.auth.subject !== "string"
  ) {
    throw new Error("portable plugin fixture auth subject is invalid");
  }
  if (!isRecord(value.expected)) {
    throw new Error("portable plugin fixture expected result is invalid");
  }
  exactKeys(
    value.expected,
    ["output", "finalUrl"],
    "portable plugin fixture expected result",
  );
  if (
    value.expected.finalUrl !== null
    && typeof value.expected.finalUrl !== "string"
  ) {
    throw new Error("portable plugin fixture finalUrl is invalid");
  }
  const route: PortablePluginRoute = Object.freeze({
    transport: value.route.transport,
    surfaceId: value.route.surfaceId,
    operation: value.route.operation,
    contractVersion: value.route.contractVersion,
  });
  const input = normalizePortablePluginJsonObject(
    value.input,
    "portable plugin fixture input",
  );
  const auth: Omit<PortablePluginInvocationAuth, "handle"> = Object.freeze({
    kind: value.auth.kind,
    ...(value.auth.subject === undefined
      ? {}
      : { subject: value.auth.subject }),
  });
  return Object.freeze({
    schemaVersion: 1,
    route,
    input,
    auth,
    files: parseFixtureFiles(value.files, route, input, auth),
    capabilityTranscript: parseFixtureCapabilityTranscript(
      value.capabilityTranscript === undefined
        ? []
        : value.capabilityTranscript,
    ),
    expected: Object.freeze({
      output: normalizePortablePluginJsonValue(
        value.expected.output,
        "portable plugin fixture expected output",
      ),
      finalUrl: value.expected.finalUrl,
    }),
  });
}

function fixtureCapabilityHost(
  fixture: PortableProviderPluginFixtureV1,
): {
  readonly host: PortableProviderPluginCapabilityHost;
  readonly assertSatisfied: () => void;
} {
  const label = `${fixture.route.surfaceId}/${fixture.route.operation}`;
  let next = 0;
  let mismatch: string | null = null;
  const fail = (message: string): never => {
    mismatch ??= message;
    throw new Error(message);
  };
  return Object.freeze({
    host: Object.freeze({
      handle: (
        request: PortablePluginCapabilityRequest,
        context: PortableProviderPluginCapabilityContext,
      ): Promise<PortablePluginCapabilityResult> => {
        if (context.signal.aborted) {
          throw new Error("portable plugin fixture capability was cancelled");
        }
        if (mismatch !== null) throw new Error(mismatch);
        const step = fixture.capabilityTranscript[next];
        if (step === undefined) {
          return fail(
            `portable plugin fixture ${label} emitted unexpected ${request.kind} capability after its transcript ended`,
          );
        }
        if (canonicalJson(step.request) !== canonicalJson(request)) {
          return fail(
            `portable plugin fixture ${label} capability step ${next + 1} expected ${step.request.kind} with different fields than the emitted ${request.kind} request`,
          );
        }
        next += 1;
        return Promise.resolve(step.result);
      },
    }),
    assertSatisfied: () => {
      if (mismatch !== null) throw new Error(mismatch);
      const step = fixture.capabilityTranscript[next];
      if (step !== undefined) {
        throw new Error(
          `portable plugin fixture ${label} returned before capability step ${next + 1} (${step.request.kind})`,
        );
      }
    },
  });
}

function fixturePath(
  packageValue: VerifiedPortableProviderPluginPackage,
  route: PortablePluginRoute,
): string {
  return join(
    packageValue.root,
    "fixtures",
    `${route.surfaceId}.${route.operation}.v${route.contractVersion}.json`,
  );
}

export async function testPortableProviderPlugin(
  pathValue: string,
  options: {
    readonly trustExecutableCode: boolean;
  },
): Promise<{
  readonly ok: true;
  readonly pluginId: string;
  readonly bundleSha256: string;
  readonly inert: number;
  readonly executed: number;
  readonly fixtures: readonly {
    readonly route: PortablePluginRoute;
    readonly result: PortableProviderPluginHostResult;
  }[];
}> {
  if (!options.trustExecutableCode) {
    throw new Error(
      "portable plugin test requires --trust-code because fixtures execute package code in a child process, not a hostile-code sandbox",
    );
  }
  const packageValue = verifyPortableProviderPluginPackageDirectory(pathValue);
  const approval = parsePortableProviderPluginTrustApproval({
    decision: "trust-executable-code",
    pluginId: packageValue.manifest.id,
    pluginVersion: packageValue.manifest.version,
    bundleSha256: packageValue.bundleSha256,
  });
  assertPortableProviderPluginTrustApprovalMatches(approval, packageValue);
  let inert = 0;
  let executed = 0;
  const fixtures: {
    readonly route: PortablePluginRoute;
    readonly result: PortableProviderPluginHostResult;
  }[] = [];
  for (const binding of packageValue.manifest.bindings) {
    for (const operation of binding.operations) {
      const route: PortablePluginRoute = {
        transport: binding.transport,
        surfaceId: binding.surfaceId,
        operation: operation.name,
        contractVersion: operation.contractVersion,
      };
      if (operation.state === "capture-required") {
        inert += 1;
        continue;
      }
      const text = readRegularFile(
        fixturePath(packageValue, route),
        MAX_FIXTURE_BYTES,
        "portable plugin fixture",
      );
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw new Error("portable plugin fixture must contain JSON");
      }
      const fixture = parseFixture(value);
      if (canonicalJson(fixture.route) !== canonicalJson(route)) {
        throw new Error("portable plugin fixture route does not match its operation");
      }
      const transcript = fixtureCapabilityHost(fixture);
      let result: PortableProviderPluginHostResult;
      try {
        result = await runPortableProviderPluginHost({
          package: packageValue,
          route,
          input: fixture.input,
          auth: {
            ...fixture.auth,
            handle: "fixture-auth",
          },
          files: fixture.files,
          timeoutMs: 5_000,
          hostVersion: "1.0.0",
          plannedDispatchIds: operation.dispatch === "single"
            ? [operation.name]
            : [],
          // The exact fixture transcript is the only installed capability host.
          // It returns no ambient credentials and performs no network or file IO.
          capabilityHost: transcript.host,
        });
      } finally {
        transcript.assertSatisfied();
      }
      if (
        canonicalJson(result.output) !== canonicalJson(fixture.expected.output)
        || result.finalUrl !== fixture.expected.finalUrl
      ) {
        throw new Error(
          `portable plugin fixture ${route.surfaceId}/${route.operation} returned an unexpected result`,
        );
      }
      executed += 1;
      fixtures.push(Object.freeze({ route, result }));
    }
  }
  return Object.freeze({
    ok: true,
    pluginId: packageValue.manifest.id,
    bundleSha256: packageValue.bundleSha256,
    inert,
    executed,
    fixtures: Object.freeze(fixtures),
  });
}

export function doctorPortableProviderPlugins(
  environment: Environment = process.env,
): {
  readonly ok: boolean;
  readonly installed: number;
  readonly issues: readonly string[];
  readonly plugins: readonly PortableProviderPluginSummary[];
  readonly invocationLeases:
    PortableProviderPluginInvocationLeaseRepairReport | null;
} {
  try {
    const plugins = listPortableProviderPlugins(environment);
    const invocationLeases =
      recoverPortableProviderPluginInvocationLeaseTombstones(environment);
    const issues = [
      ...(invocationLeases.invalid === 0
        ? []
        : [
            `${invocationLeases.invalid} portable invocation lease(s) are invalid`,
          ]),
      ...(invocationLeases.unknown === 0
        ? []
        : [
            `${invocationLeases.unknown} portable invocation lease owner(s) are unverifiable`,
          ]),
    ];
    return Object.freeze({
      ok: issues.length === 0,
      installed: plugins.length,
      issues: Object.freeze(issues),
      plugins,
      invocationLeases,
    });
  } catch {
    return Object.freeze({
      ok: false,
      installed: 0,
      issues: Object.freeze([
        "portable plugin store is invalid; no portable plugin was loaded",
      ]),
      plugins: Object.freeze([]),
      invocationLeases: null,
    });
  }
}
