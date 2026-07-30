import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { main as defaultWrenchMain, type WrenchDependencies } from "../wrench";
import {
  isProviderOperation,
  isWebSessionOperation,
  manifestHash,
  parseDiagnosticManifest,
  parseRuntimeManifest,
  type WrenchManifest,
} from "../model";
import type { ProviderPluginRegistry } from "../provider-plugin-registry";
import {
  portableProviderPluginStoreRoot,
} from "../provider-plugin-lifecycle";
import {
  createPortableProviderPluginCatalog,
  type PortableProviderPluginCatalog,
} from "../provider-plugin-portable-catalog";
import {
  withPortableProviderPluginCatalogLock,
} from "../provider-plugin-store";
import { providerPluginRegistry } from "../provider-plugins";
import {
  adapterManifestPath,
  installBundledAdapterGeneration,
  listInstalledDiagnosticManifestSnapshots,
  type BundledAdapterGenerationSelection,
} from "../storage";

type SyncOutput = {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

type WrenchMain = (
  rawArguments: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  output: {
    readonly stdout: (value: string) => void;
    readonly stderr: (value: string) => void;
  },
  dependencyOverrides?: Partial<WrenchDependencies>,
) => Promise<number>;

type GenerationInstaller = (
  selections: readonly BundledAdapterGenerationSelection[],
  environment: Readonly<Record<string, string | undefined>>,
) => {
  readonly commitId: string;
  readonly installed: number;
  readonly preservedLegacy: number;
};

type SourceSnapshot = {
  readonly path: string;
  readonly sourceContentSha256: string;
  readonly bytes: Uint8Array;
  readonly value: unknown;
};

export type DiscoveredBundledAdapter = {
  readonly id: string;
  readonly current: SourceSnapshot & { readonly manifest: WrenchManifest };
  readonly upgradeFrom: readonly (
    SourceSnapshot & { readonly manifest: WrenchManifest }
  )[];
  readonly routeKey: string;
};

const defaultOutput: SyncOutput = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

const defaultAssetsDirectory = join(
  import.meta.dir,
  "..",
  "assets",
  "adapters",
);
const maximumSourceBytes = 1024 * 1024;
const currentManifestNames = new Set([
  "wrench-adapter.json",
  "wrench-web-adapter.json",
]);
const archivedManifestNamePattern =
  /^(wrench(?:-web)?-adapter)\.v[0-9]+\.[0-9]+\.[0-9]+\.json$/u;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableCatalogFingerprint(
  catalog: PortableProviderPluginCatalog,
): string {
  const identities = catalog.installed.map((entry) => ({
    pluginId: entry.active.pluginId,
    pluginVersion: entry.active.pluginVersion,
    bundleSha256: entry.active.bundleSha256,
    manifestSha256: entry.package.manifestSha256,
    status: entry.active.status,
    activatedAt: entry.active.activatedAt,
    ...(entry.active.status === "disabled"
      ? { disabledAt: entry.active.disabledAt }
      : {}),
    trustedAt: entry.trust.trustedAt,
  })).sort((left, right) =>
    left.pluginId.localeCompare(right.pluginId)
    || left.bundleSha256.localeCompare(right.bundleSha256));
  return sha256(JSON.stringify(identities));
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readSourceSnapshot(path: string): SourceSnapshot {
  const lexical = lstatSync(path, { bigint: true });
  if (lexical.isSymbolicLink() || !lexical.isFile()) {
    throw new Error(`bundled adapter source is not a real regular file: ${path}`);
  }
  if (lexical.size > BigInt(maximumSourceBytes)) {
    throw new Error(`bundled adapter source exceeds ${maximumSourceBytes} bytes: ${path}`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || !sameFileIdentity(lexical, before)
      || before.size > BigInt(maximumSourceBytes)
    ) {
      throw new Error(`bundled adapter source changed before snapshot: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const finalLexical = lstatSync(path, { bigint: true });
    if (
      bytes.byteLength > maximumSourceBytes
      || !sameFileIdentity(before, after)
      || !sameFileIdentity(after, finalLexical)
    ) {
      throw new Error(`bundled adapter source changed while being snapshotted: ${path}`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(`bundled adapter source is not valid UTF-8: ${path}`, {
        cause: error,
      });
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`bundled adapter source is not valid JSON: ${path}`, {
        cause: error,
      });
    }
    return Object.freeze({
      path,
      sourceContentSha256: sha256(bytes),
      bytes: Uint8Array.from(bytes),
      value,
    });
  } finally {
    closeSync(descriptor);
  }
}

function routeKey(transport: string, surfaceId: string): string {
  return `${transport}:${surfaceId}`;
}

function manifestRouteKey(
  manifest: WrenchManifest,
  registry: ProviderPluginRegistry,
): string {
  if (manifest.surfaceId === undefined) {
    throw new Error(`bundled adapter ${manifest.id} has no provider surface`);
  }
  const operations = Object.entries(manifest.operations);
  const usesProviderApi = operations.every(([, operation]) =>
    isProviderOperation(operation)
  );
  const usesSessionApi = operations.every(([, operation]) =>
    isWebSessionOperation(operation)
  );
  if (!usesProviderApi && !usesSessionApi) {
    throw new Error(`bundled adapter ${manifest.id} mixes provider transports`);
  }
  const candidates = registry.list().flatMap((plugin) =>
    plugin.bindings.filter((binding) => {
      if (binding.surfaceId !== manifest.surfaceId) return false;
      if (
        (usesProviderApi && binding.transport !== "provider-api")
        || (usesSessionApi && binding.transport === "provider-api")
      ) {
        return false;
      }
      return operations.every(
        ([operationId, operation]) => {
          if (!isProviderOperation(operation) && !isWebSessionOperation(operation)) {
            return false;
          }
          const contractVersion = isProviderOperation(operation)
            ? operation.provider.contractVersion
            : operation.webSession.contractVersion;
          return registry.resolveOperationDefinition(
            binding.transport,
            binding.surfaceId,
            operationId,
            contractVersion,
          ) !== undefined;
        },
      );
    })
  );
  if (candidates.length !== 1) {
    throw new Error(
      `bundled adapter ${manifest.id} does not resolve to exactly one provider plugin binding`,
    );
  }
  return routeKey(candidates[0]!.transport, candidates[0]!.surfaceId);
}

/**
 * Discover the distribution inventory from assets, then prove inverse parity
 * with the built-in provider registry. Neither side can silently add a route.
 */
export function discoverBundledAdapters(
  assetsDirectory: string = defaultAssetsDirectory,
  registry: ProviderPluginRegistry = providerPluginRegistry,
): readonly DiscoveredBundledAdapter[] {
  const rootStats = lstatSync(assetsDirectory);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("bundled adapter asset root must be a real directory");
  }
  const discovered: DiscoveredBundledAdapter[] = [];
  const surfaceEntries = readdirSync(assetsDirectory, {
    withFileTypes: true,
  }).sort((left, right) => left.name.localeCompare(right.name));
  for (const surfaceEntry of surfaceEntries) {
    if (surfaceEntry.isSymbolicLink() || !surfaceEntry.isDirectory()) {
      throw new Error(
        `bundled adapter asset root contains an unsafe entry: ${surfaceEntry.name}`,
      );
    }
    const surfaceDirectory = join(assetsDirectory, surfaceEntry.name);
    const surfaceStats = lstatSync(surfaceDirectory);
    if (surfaceStats.isSymbolicLink() || !surfaceStats.isDirectory()) {
      throw new Error(`bundled adapter surface is not a real directory: ${surfaceEntry.name}`);
    }
    const files = readdirSync(surfaceDirectory, {
      withFileTypes: true,
    }).sort((left, right) => left.name.localeCompare(right.name));
    for (const file of files) {
      if (file.isSymbolicLink()) {
        throw new Error(
          `bundled adapter surface contains a symbolic link: ${surfaceEntry.name}/${file.name}`,
        );
      }
    }
    const currentFiles = files.filter(
      (file) => file.isFile() && currentManifestNames.has(file.name),
    );
    if (currentFiles.length === 0) {
      throw new Error(`bundled adapter surface has no current manifest: ${surfaceEntry.name}`);
    }
    for (const currentFile of currentFiles) {
      const current = readSourceSnapshot(
        join(surfaceDirectory, currentFile.name),
      );
      const currentParsed = parseRuntimeManifest(current.value, registry);
      if (!currentParsed.ok) {
        throw new Error(
          `bundled adapter ${currentFile.name} is invalid: ${currentParsed.issues.join("; ")}`,
        );
      }
      const currentStem = currentFile.name.slice(0, -".json".length);
      const archived = files.filter((file) => {
        const match = archivedManifestNamePattern.exec(file.name);
        return file.isFile() && match?.[1] === currentStem;
      }).map((file) => {
        const snapshot = readSourceSnapshot(join(surfaceDirectory, file.name));
        const parsed = parseDiagnosticManifest(snapshot.value, registry);
        if (!parsed.ok) {
          throw new Error(
            `bundled adapter baseline ${file.name} is invalid: ${parsed.issues.join("; ")}`,
          );
        }
        if (parsed.value.id !== currentParsed.value.id) {
          throw new Error(
            `bundled adapter baseline ${file.name} has the wrong adapter ID`,
          );
        }
        return Object.freeze({ ...snapshot, manifest: parsed.value });
      });
      const archivedHashes = archived.map((entry) =>
        manifestHash(entry.manifest)
      );
      if (new Set(archivedHashes).size !== archivedHashes.length) {
        throw new Error(
          `bundled adapter ${currentParsed.value.id} has duplicate upgrade baselines`,
        );
      }
      discovered.push(Object.freeze({
        id: currentParsed.value.id,
        current: Object.freeze({
          ...current,
          manifest: currentParsed.value,
        }),
        upgradeFrom: Object.freeze(archived),
        routeKey: manifestRouteKey(currentParsed.value, registry),
      }));
    }
  }
  discovered.sort((left, right) => left.id.localeCompare(right.id));
  const ids = discovered.map((adapter) => adapter.id);
  const routes = discovered.map((adapter) => adapter.routeKey);
  if (new Set(ids).size !== ids.length) {
    throw new Error("bundled adapter inventory contains duplicate IDs");
  }
  if (new Set(routes).size !== routes.length) {
    throw new Error("bundled adapter inventory contains duplicate provider routes");
  }
  const expectedRoutes = registry.list().flatMap((plugin) =>
    plugin.bindings.map((binding) =>
      routeKey(binding.transport, binding.surfaceId)
    )
  ).sort();
  const actualRoutes = [...routes].sort();
  if (
    expectedRoutes.length !== actualRoutes.length
    || expectedRoutes.some((route, index) => route !== actualRoutes[index])
  ) {
    throw new Error(
      `bundled adapter inventory and provider plugin registry differ (assets: ${actualRoutes.join(", ")}; registry: ${expectedRoutes.join(", ")})`,
    );
  }
  return Object.freeze(discovered);
}

function captureOutput(): {
  readonly output: SyncOutput;
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    output: {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function compactDetail(value: string): string {
  return value.trim().slice(0, 4_096);
}

async function validateSnapshotWithCli(
  adapter: DiscoveredBundledAdapter,
  stagedPath: string,
  environment: Readonly<Record<string, string | undefined>>,
  wrenchMain: WrenchMain,
  registry: ProviderPluginRegistry,
): Promise<void> {
  const captured = captureOutput();
  const status = await wrenchMain(
    ["adapter", "validate", stagedPath, "--json"],
    environment,
    captured.output,
    { providerPluginRegistry: registry },
  );
  if (status !== 0) {
    const detail = compactDetail(captured.stderr() || captured.stdout());
    throw new Error(
      `bundled ${adapter.id} adapter failed validation${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(captured.stdout()) as unknown;
  } catch {
    throw new Error(`bundled ${adapter.id} adapter validation returned malformed JSON`);
  }
  if (
    typeof response !== "object"
    || response === null
    || !("ok" in response)
    || response.ok !== true
    || !("id" in response)
    || response.id !== adapter.id
    || !("manifestHash" in response)
    || response.manifestHash !== manifestHash(adapter.current.manifest)
  ) {
    throw new Error(
      `bundled ${adapter.id} adapter validation returned the wrong identity`,
    );
  }
}

function publishBundledAdapterGeneration(
  bundledAdapters: readonly DiscoveredBundledAdapter[],
  environment: Readonly<Record<string, string | undefined>>,
  output: SyncOutput,
  registry: ProviderPluginRegistry,
  installGeneration?: GenerationInstaller,
): {
  readonly installed: number;
  readonly preserved: number;
  readonly commitId: string;
} {
  const portableAdapterIds = new Set(
    registry.listOwnedManifests().map((manifest) =>
      manifest.id
    ),
  );
  const collision = bundledAdapters.find((adapter) =>
    portableAdapterIds.has(adapter.id)
  );
  if (collision !== undefined) {
    throw new Error(
      `bundled adapter ${collision.id} is owned by an enabled portable provider plugin`,
    );
  }

  const selections: BundledAdapterGenerationSelection[] = [];
  const preservedIds: string[] = [];
  let installed = 0;
  const installedSnapshots = new Map(
    listInstalledDiagnosticManifestSnapshots(environment, registry).map((entry) =>
      [entry.id, entry.snapshot] as const
    ),
  );
  for (const adapter of bundledAdapters) {
    const snapshot = installedSnapshots.get(adapter.id) ?? {
      result: {
        ok: false as const,
        issues: [`adapter ${adapter.id} is not installed`],
      },
      availability: "absent" as const,
      contentSha256: null,
    };
    if (snapshot.availability === "unsafe") {
      const detail = snapshot.result.ok
        ? "unsafe installed-state snapshot"
        : snapshot.result.issues.join("; ");
      throw new Error(
        `installed adapter ${adapter.id} cannot be snapshotted safely: ${detail}`,
      );
    }
    if (snapshot.availability === "absent") {
      selections.push({
        id: adapter.id,
        state: "present",
        manifest: adapter.current.manifest,
        sourceContentSha256: adapter.current.sourceContentSha256,
        expectedCurrentContentSha256: null,
      });
      installed += 1;
      continue;
    }
    if (!snapshot.result.ok) {
      selections.push({
        id: adapter.id,
        state: "legacy",
        expectedCurrentContentSha256: snapshot.contentSha256,
      });
      preservedIds.push(adapter.id);
      continue;
    }
    const installedHash = manifestHash(snapshot.result.value);
    const acceptedHashes = new Set([
      manifestHash(adapter.current.manifest),
      ...adapter.upgradeFrom.map((baseline) =>
        manifestHash(baseline.manifest)
      ),
    ]);
    if (acceptedHashes.has(installedHash)) {
      selections.push({
        id: adapter.id,
        state: "present",
        manifest: adapter.current.manifest,
        sourceContentSha256: adapter.current.sourceContentSha256,
        expectedCurrentContentSha256: snapshot.contentSha256,
      });
      installed += 1;
      continue;
    }
    if (snapshot.contentSha256 === null) {
      throw new Error(`installed adapter ${adapter.id} omitted its content hash`);
    }
    selections.push({
      id: adapter.id,
      state: "present",
      manifest: snapshot.result.value,
      sourceContentSha256: snapshot.contentSha256,
      expectedCurrentContentSha256: snapshot.contentSha256,
    });
    preservedIds.push(adapter.id);
  }
  const generation = (
    installGeneration
    ?? ((value, targetEnvironment) =>
      installBundledAdapterGeneration(
        value,
        targetEnvironment,
        { registry },
      ))
  )(selections, environment);
  for (const adapter of bundledAdapters) {
    if (preservedIds.includes(adapter.id)) continue;
    output.stdout(
      `Installed ${adapter.id} at ${adapterManifestPath(adapter.id, environment)}.\n`,
    );
  }
  for (const id of preservedIds) {
    output.stderr(
      `wrench installer: preserved the installed ${id} adapter because it differs from the bundled version; inspect it or reinstall with --force\n`,
    );
  }
  return Object.freeze({
    installed,
    preserved: preservedIds.length,
    commitId: generation.commitId,
  });
}

export async function syncBundledAdapters(
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly output?: SyncOutput;
    readonly wrenchMain?: WrenchMain;
    readonly installGeneration?: GenerationInstaller;
    readonly assetsDirectory?: string;
    readonly registry?: ProviderPluginRegistry;
  } = {},
): Promise<{
  readonly installed: number;
  readonly preserved: number;
  readonly commitId: string;
}> {
  const environment = options.environment ?? process.env;
  const output = options.output ?? defaultOutput;
  const wrenchMain = options.wrenchMain ?? defaultWrenchMain;
  const registry = options.registry ?? providerPluginRegistry;
  const bundledAdapters = discoverBundledAdapters(
    options.assetsDirectory ?? defaultAssetsDirectory,
    registry,
  );

  const stagingDirectory = mkdtempSync(
    join(tmpdir(), "wrench-bundled-adapters-"),
  );
  chmodSync(stagingDirectory, 0o700);
  try {
    for (const [index, adapter] of bundledAdapters.entries()) {
      const stagedPath = join(
        stagingDirectory,
        `${String(index).padStart(4, "0")}-${basename(adapter.current.path)}`,
      );
      writeFileSync(stagedPath, adapter.current.bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const storeRoot = portableProviderPluginStoreRoot(environment);
    const initialCatalog = withPortableProviderPluginCatalogLock(
      storeRoot,
      new Date(),
      () => createPortableProviderPluginCatalog(registry, environment),
    );
    const initialCatalogFingerprint =
      portableCatalogFingerprint(initialCatalog);
    for (const [index, adapter] of bundledAdapters.entries()) {
      const stagedPath = join(
        stagingDirectory,
        `${String(index).padStart(4, "0")}-${basename(adapter.current.path)}`,
      );
      await validateSnapshotWithCli(
        adapter,
        stagedPath,
        environment,
        wrenchMain,
        initialCatalog.registry,
      );
    }

    return withPortableProviderPluginCatalogLock(
      storeRoot,
      new Date(),
      () => {
        const currentCatalog =
          createPortableProviderPluginCatalog(registry, environment);
        if (
          portableCatalogFingerprint(currentCatalog)
          !== initialCatalogFingerprint
        ) {
          throw new Error(
            "portable provider plugin catalog changed during bundled adapter validation; retry installation",
          );
        }
        return publishBundledAdapterGeneration(
          bundledAdapters,
          environment,
          output,
          currentCatalog.registry,
          options.installGeneration,
        );
      },
    );
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await syncBundledAdapters();
  } catch (error) {
    process.stderr.write(
      `wrench installer: ${error instanceof Error ? error.message : "unknown bundled adapter sync failure"}\n`,
    );
    process.exitCode = 1;
  }
}
