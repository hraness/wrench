import { createHash, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";

import {
  reviewedBuiltInContractIdentity,
} from "./provider-plugin-contract-identity";
import {
  MAX_PROVIDER_PLUGIN_BINDINGS,
  MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES,
  MAX_PROVIDER_PLUGIN_OPERATIONS,
  MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING,
  PROVIDER_PLUGIN_API_VERSION,
  bindProviderPluginRuntimeLoadIdentity,
  classifyProviderPluginPhysicalPath,
  defineProviderPlugin,
  isValidatedProviderPlugin,
  portableProviderPluginAdapter,
  portableProviderPluginArtifactSha256,
  portableProviderPluginOperationIdentity,
  providerPluginDurableInstalledPackageMode,
  providerPluginEvaluationInstalledPackageSha256,
  providerPluginEvaluationSourceSha256,
  providerPluginPackageRoot,
  providerPluginRepositoryRoot,
  type ProviderPluginBindingV1,
  type ProviderPluginDefinitionV1,
  type ProviderPluginOperationV1,
  type ProviderPluginTransport,
  type ProviderPluginV1,
  type ProviderPluginRuntimeLoadIdentityPhase,
} from "./provider-plugin";
import type { WrenchManifest } from "./model";
import type {
  PortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";

export type ProviderPluginOperationResolutionV1 = {
  readonly plugin: ProviderPluginV1;
  readonly binding: ProviderPluginBindingV1;
  readonly operation: ProviderPluginOperationV1;
  /** Exact durable route version used for this lookup. */
  readonly contractVersion: number;
  /** Exact immutable package identity for portable operations only. */
  readonly portableIdentity: PortableOperationIdentityV1 | null;
};

export type ProviderPluginRegistry = {
  readonly list: () => readonly ProviderPluginV1[];
  readonly get: (pluginId: string) => ProviderPluginV1 | undefined;
  readonly resolveRoute: (
    transport: ProviderPluginTransport,
    surfaceId: string,
  ) => ProviderPluginBindingV1 | undefined;
  readonly requireRoute: (
    transport: ProviderPluginTransport,
    surfaceId: string,
  ) => ProviderPluginBindingV1;
  readonly resolveSessionRoute: (surfaceId: string) => ProviderPluginBindingV1 | undefined;
  readonly requireSessionRoute: (surfaceId: string) => ProviderPluginBindingV1;
  readonly resolveOperation: (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ) => ProviderPluginBindingV1 | undefined;
  readonly requireOperation: (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ) => ProviderPluginBindingV1;
  readonly resolveOperationDefinition: (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ) => ProviderPluginOperationResolutionV1 | undefined;
  readonly requireOperationDefinition: (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ) => ProviderPluginOperationResolutionV1;
  /** Current exact source/dependency/execution closure used for runtime loading. */
  readonly implementationHash: (binding: ProviderPluginBindingV1) => Buffer;
  /** Stable predecessor-compatible identity used by new durable contract writers. */
  readonly contractImplementationHash: (binding: ProviderPluginBindingV1) => Buffer;
  /** Bounded predecessor common-mode identities accepted only by durable readers. */
  readonly legacyContractImplementationHashes: (
    binding: ProviderPluginBindingV1,
    operation: string,
    contractVersion: number,
  ) => readonly Buffer[];
  /** Environment-independent exact current source/dependency closure identity. */
  readonly implementationClosureHash: (
    binding: ProviderPluginBindingV1,
  ) => string;
  readonly artifactSha256: (binding: ProviderPluginBindingV1) => string | null;
  readonly listOwnedManifests: () => readonly WrenchManifest[];
  readonly resolveOwnedManifest: (adapterId: string) => WrenchManifest | undefined;
};

function routeKey(transport: ProviderPluginTransport, surfaceId: string): string {
  return `${transport}:${surfaceId}`;
}

function operationKey(
  transport: ProviderPluginTransport,
  surfaceId: string,
  operation: string,
  contractVersion: number,
): string {
  return `${routeKey(transport, surfaceId)}/${operation}@${contractVersion}`;
}

const MAX_PROVIDER_DEPENDENCY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_INSTALLED_PACKAGE_FILES = 4_096;
const MAX_INSTALLED_PACKAGE_DIRECTORIES = 1_024;
const MAX_INSTALLED_PACKAGE_DEPTH = 32;
const MAX_INSTALLED_PACKAGE_PATH_BYTES = 1_024;
const MAX_INSTALLED_PACKAGE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_INSTALLED_PACKAGES = 128;
const MAX_INSTALLED_PACKAGE_GRAPH_DEPTH = 32;
const MAX_INSTALLED_CLOSURE_FILES = 16_384;
const MAX_INSTALLED_CLOSURE_DIRECTORIES = 4_096;
const MAX_INSTALLED_EXECUTABLE_MODULES = 4_096;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_REGISTRY_INSTALLED_PACKAGES = 256;
const MAX_REGISTRY_INSTALLED_FILES = 32_768;
const MAX_REGISTRY_INSTALLED_DIRECTORIES = 8_192;
const MAX_REGISTRY_INSTALLED_BYTES = 256 * 1024 * 1024;
const MAX_REGISTRY_SOURCE_PLUGINS = 256;
export const MAX_PROVIDER_PLUGIN_REGISTRY_ROUTES = 4_096;
export const MAX_PROVIDER_PLUGIN_REGISTRY_OPERATION_CONTRACTS = 65_536;
const MAX_REGISTRY_IMPLEMENTATION_SOURCE_READS = 8_192;
const MAX_REGISTRY_IMPLEMENTATION_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_REGISTRY_DEPENDENCY_RECORDS = 65_536;
const MAX_REGISTRY_DEPENDENCY_RECORD_BYTES = 256 * 1024 * 1024;
const MAX_PLUGIN_DEPENDENCY_RECORDS = 32_768;
const MAX_PLUGIN_DEPENDENCY_RECORD_BYTES = 128 * 1024 * 1024;
const MAX_PROVIDER_EXECUTABLE_MODULE_BYTES = 512 * 1024;
const MAX_PROVIDER_MODULE_IMPORTS = 4_096;
const MAX_REGISTRY_ANALYZED_IMPORTS = 65_536;
const strictSemverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function compareIdentityText(left: string, right: string): number {
  return Buffer.compare(
    Buffer.from(left, "utf8"),
    Buffer.from(right, "utf8"),
  );
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function ownedByCurrentUser(stats: BigIntStats): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined || stats.uid === BigInt(uid);
}

function readStableDependencyFile(
  path: string,
  maximumBytes: number,
  label: string,
): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
    );
  } catch {
    throw new Error(`${label} is unreadable`);
  }
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || !ownedByCurrentUser(before)
      || before.size < 0n
      || before.size > BigInt(maximumBytes)
    ) {
      throw new Error(`${label} is not an owned bounded regular file`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    let current: BigIntStats;
    try {
      current = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(`${label} changed while it was read`);
    }
    if (
      offset !== bytes.byteLength
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameFileSnapshot(before, after)
      || !sameFileSnapshot(after, current)
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readImplementationSource(
  pluginId: string,
  source: ProviderPluginV1["implementationSources"][number],
): Buffer {
  return readStableDependencyFile(
    source.path,
    MAX_PROVIDER_DEPENDENCY_FILE_BYTES,
    `provider plugin ${pluginId} implementation source ${source.label}`,
  );
}

type ProviderPluginImplementationSourceSnapshot = ReadonlyMap<string, Buffer>;
type ProviderPluginPackageDependencySnapshot = readonly {
  readonly label: string;
  readonly bytes: Buffer;
}[];

type InstalledPackageFileSnapshot = {
  readonly path: string;
  readonly bytes: Buffer;
  readonly mode: number;
};

type InstalledPackageDirectorySnapshot = {
  readonly path: string;
  readonly mode: number;
};

type InstalledPackageDependencyKind =
  | "dependency"
  | "optional-dependency"
  | "peer-dependency"
  | "optional-peer-dependency";

type InstalledPackageDependency = {
  readonly kind: InstalledPackageDependencyKind;
  readonly name: string;
};

type InstalledPackageSnapshot = {
  readonly root: string;
  readonly id: string;
  readonly installName: string;
  readonly name: string;
  readonly version: string;
  readonly treeSha256: string;
  readonly files: readonly InstalledPackageFileSnapshot[];
  readonly directories: readonly InstalledPackageDirectorySnapshot[];
  readonly dependencies: readonly InstalledPackageDependency[];
  readonly totalBytes: number;
  readonly verificationWalk: InstalledPackageTreeWalk;
};

type InstalledModuleAnalysis = {
  readonly imports: readonly {
    readonly kind: string;
    readonly path: string;
  }[];
  readonly nonLiteralModuleLoad: boolean;
};

type ProviderModuleAnalysisCache = {
  readonly values: Map<string, InstalledModuleAnalysis>;
  imports: number;
};

export type ProviderPluginRegistryDependencies = {
  /**
   * Test seam for proving canonical implementation sources are read once.
   * Production callers must use the inode-bound default reader.
   */
  readonly readImplementationSource?: typeof readImplementationSource;
  /**
   * Test seam for dependency snapshot timing. Production callers must use
   * the same inode-bound reader used for implementation sources.
   */
  readonly readDependencySource?: (path: string) => Buffer;
  /** Deterministic test seam immediately before an uncached runtime identity check. */
  readonly beforeRuntimeLoadIdentityCheck?: (
    pluginId: string,
    phase: ProviderPluginRuntimeLoadIdentityPhase,
  ) => void | Promise<void>;
};

function snapshotProviderPluginImplementationSources(
  plugin: ProviderPluginV1,
  readSource: typeof readImplementationSource,
  registrySnapshots: Map<string, Buffer>,
): ProviderPluginImplementationSourceSnapshot {
  const snapshots = new Map<string, Buffer>();
  for (const source of plugin.implementationSources) {
    if (snapshots.has(source.path)) continue;
    let bytes = registrySnapshots.get(source.path);
    if (bytes === undefined) {
      bytes = Buffer.from(readSource(plugin.id, source));
      registrySnapshots.set(source.path, bytes);
    }
    snapshots.set(source.path, bytes);
  }
  return snapshots;
}

function implementationSourceBytes(
  plugin: ProviderPluginV1,
  source: ProviderPluginV1["implementationSources"][number],
  snapshots: ProviderPluginImplementationSourceSnapshot,
): Buffer {
  const bytes = snapshots.get(source.path);
  if (bytes === undefined) {
    throw new Error(
      `provider plugin ${plugin.id} implementation source ${source.label} was not snapshotted`,
    );
  }
  return bytes;
}

function updateLengthFramedHash(
  hash: ReturnType<typeof createHash>,
  label: string,
  bytes: Buffer,
): void {
  const labelBytes = Buffer.from(label, "utf8");
  const lengths = Buffer.alloc(12);
  lengths.writeUInt32BE(labelBytes.byteLength, 0);
  lengths.writeBigUInt64BE(BigInt(bytes.byteLength), 4);
  hash.update(lengths).update(labelBytes).update(bytes);
}

function computeProviderPluginImplementationHash(
  plugin: ProviderPluginV1,
  snapshots: ProviderPluginImplementationSourceSnapshot,
  packageDependencies: ProviderPluginPackageDependencySnapshot,
): Buffer {
  const artifactSha256 = portableProviderPluginArtifactSha256(plugin);
  if (artifactSha256 !== null) return Buffer.from(artifactSha256, "hex");
  const hash = createHash("sha256");
  hash.update(
    `provider-plugin-implementation-identity@4/api@${PROVIDER_PLUGIN_API_VERSION}\0`,
  );
  updateLengthFramedHash(
    hash,
    "evaluated-plugin-semantics",
    providerPluginSemanticIdentity(plugin),
  );
  for (
    const source of [...plugin.implementationSources]
      .sort((left, right) => compareIdentityText(left.label, right.label))
  ) {
    updateLengthFramedHash(
      hash,
      `implementation-source/${source.label}`,
      implementationSourceBytes(plugin, source, snapshots),
    );
  }
  for (const dependency of packageDependencies) {
    updateLengthFramedHash(hash, dependency.label, dependency.bytes);
  }
  return hash.digest();
}

function computeProviderPluginClosureHash(
  plugin: ProviderPluginV1,
  snapshots: ProviderPluginImplementationSourceSnapshot,
  packageDependencies: ProviderPluginPackageDependencySnapshot,
): string {
  const artifactSha256 = portableProviderPluginArtifactSha256(plugin);
  if (artifactSha256 !== null) return artifactSha256;
  const hash = createHash("sha256");
  hash.update(
    `provider-plugin-reviewed-closure@1/api@${PROVIDER_PLUGIN_API_VERSION}\0`,
  );
  updateLengthFramedHash(
    hash,
    "evaluated-plugin-semantics",
    providerPluginSemanticIdentity(plugin),
  );
  for (
    const source of [...plugin.implementationSources]
      .sort((left, right) => compareIdentityText(left.label, right.label))
  ) {
    updateLengthFramedHash(
      hash,
      `implementation-source/${source.label}`,
      implementationSourceBytes(plugin, source, snapshots),
    );
  }
  for (const dependency of packageDependencies) {
    if (dependency.label.startsWith("execution-")) continue;
    updateLengthFramedHash(hash, dependency.label, dependency.bytes);
  }
  return hash.digest("hex");
}

function providerPluginSemanticValue(
  value: unknown,
  ancestors: Set<object>,
): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "function") return "@provider-plugin-function";
  if (typeof value !== "object") {
    throw new Error("provider plugin semantic identity is not JSON-compatible");
  }
  if (ancestors.has(value)) {
    throw new Error("provider plugin semantic identity contains a cycle");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) =>
        providerPluginSemanticValue(entry, ancestors));
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareIdentityText)) {
      const entry = (value as Readonly<Record<string, unknown>>)[key];
      if (entry === undefined) continue;
      result[key] = providerPluginSemanticValue(entry, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function providerPluginSemanticIdentity(plugin: ProviderPluginV1): Buffer {
  const encoded = JSON.stringify(providerPluginSemanticValue({
    apiVersion: plugin.apiVersion,
    bindings: plugin.bindings,
    displayName: plugin.displayName,
    id: plugin.id,
    sourceKind: plugin.sourceKind,
    version: plugin.version,
  }, new Set()));
  return Buffer.from(encoded, "utf8");
}

function readDependencySourceFromDisk(path: string): Buffer {
  return readImplementationSource(
    "registry-dependency",
    { label: relative(repositoryRoot, path), path },
  );
}

const providerPluginImportScanners = Object.freeze({
  js: new Bun.Transpiler({ loader: "js" }),
  ts: new Bun.Transpiler({ loader: "ts" }),
});
const providerPluginModuleExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const runtimeBuiltins = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith("node:") ? [name, name.slice("node:".length)] : [name]),
);
const repositoryRoot = providerPluginRepositoryRoot;
const repositoryPackagePath = realpathSync(
  resolve(repositoryRoot, "package.json"),
);
const repositoryTsconfigPath = realpathSync(
  resolve(repositoryRoot, "tsconfig.json"),
);
const repositoryBunfigPath = realpathSync(
  resolve(repositoryRoot, "bunfig.toml"),
);
const packageManifestPath = realpathSync(
  resolve(providerPluginPackageRoot, "package.json"),
);
const packageTsconfigPath = realpathSync(
  resolve(providerPluginPackageRoot, "tsconfig.json"),
);
const providerPluginsApiPath = realpathSync(
  resolve(import.meta.dir, "provider-plugins.ts"),
);
const providerPluginAbsoluteImportTargets = new Set([
  realpathSync(resolve(import.meta.dir, "provider-plugin.ts")),
]);
const reviewedMetaDynamicInstalledModuleIdentities = Object.freeze([
  "source-map-support@0.5.21\u0000source-map-support.js\u0000da6f90928140ff29ca0b72f4bf8299deb986ba45f055fc5eb51d50dea2e5364d",
  "typescript@6.0.3\u0000lib/typescript.js\u0000569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39",
]);
const reviewedKbDynamicInstalledPackage = Object.freeze({
  name: "@hraness/kb",
  version: "0.15.2",
  sha256:
    "90dabe25235d6f9c64d963a7817580cf36bd96c1fe71d8adae748ab7ff0d138b",
});
const reviewedKbDynamicResolutionPolicy =
  "createRequire(parentUrl).resolve(`$" +
  "{packageName}/package.json`) is reached only by resolvePackageDirectory(\"agent-browser\") at module initialization";
const reviewedDormantDynamicLoaderPolicy =
  "reviewed dependency parser API is not called by the owning Wrench composition";
const reviewedDynamicInstalledModuleIdentities =
  reviewedMetaDynamicInstalledModuleIdentities;
const reviewedKbDynamicInstalledPluginIds = new Set([
  "beeper-linked-device",
  "bluesky-web",
  "github-web",
  "hacker-news-web",
  "linkedin-web",
  "meta-web",
  "reddit-web",
  "substack-web",
  "tiktok-web",
  "twitch-web",
  "whatsapp-linked-device",
  "x-web",
  "youtube-web",
]);
const reviewedBuiltInDynamicInstalledModules = new Set(
  ["meta-web"].flatMap((pluginId) =>
    reviewedMetaDynamicInstalledModuleIdentities.map(
      (identity) => `${pluginId}\u0000${identity}`,
    )),
);

function discoverReviewedKbDynamicInstalledModuleIdentity(
  snapshot: InstalledPackageSnapshot,
): string {
  if (
    snapshot.name !== reviewedKbDynamicInstalledPackage.name
    || snapshot.version !== reviewedKbDynamicInstalledPackage.version
  ) {
    throw new Error(
      `installed KB dynamic-resolution review requires ${reviewedKbDynamicInstalledPackage.name}@${reviewedKbDynamicInstalledPackage.version}, got ${snapshot.id}`,
    );
  }
  const candidates: InstalledPackageFileSnapshot[] = [];
  for (const file of snapshot.files) {
    if (extname(file.path) !== ".js") continue;
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    } catch {
      continue;
    }
    if (
      source.match(
        /createRequire\(parentUrl\)\.resolve\(`\$\{packageName\}\/package\.json`\)/gu,
      )?.length !== 1
      || source.match(/resolvePackageDirectory\("agent-browser"\)/gu)?.length !== 1
    ) continue;
    candidates.push(file);
  }
  if (candidates.length !== 1) {
    throw new Error(
      `installed ${snapshot.id} exposes ${String(candidates.length)} dynamic-resolution modules, expected exactly one`,
    );
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new Error(`installed ${snapshot.id} dynamic-resolution module disappeared`);
  }
  const sha256 = createHash("sha256").update(candidate.bytes).digest("hex");
  if (sha256 !== reviewedKbDynamicInstalledPackage.sha256) {
    throw new Error(
      `installed ${snapshot.id} dynamic-resolution module ${candidate.path} has sha256 ${sha256}, expected ${reviewedKbDynamicInstalledPackage.sha256}`,
    );
  }
  return `${snapshot.id}\u0000${candidate.path}\u0000${sha256}`;
}
const reviewedBuiltInDynamicRepositoryModules = new Set(
  [
    "bluesky-web",
    "hacker-news-web",
    "linkedin-web",
    "meta-web",
    "reddit-web",
    "substack-web",
    "tiktok-web",
    "twitch-web",
    "whatsapp-linked-device",
    "x-web",
    "youtube-web",
  ].map(
    (pluginId) =>
      `${pluginId}\u0000packages/kb/src/clip/package-root.ts\u0000fede9141e7d8a9a900acfae25fd8954e4d09c7d4bdd7e3fa9187ab9722b8b199`,
  ),
);

function valueImports(source: string, path: string): readonly {
  readonly kind: string;
  readonly path: string;
}[] {
  const moduleSource = source.replace(/^#![^\r\n]*(?:\r?\n|$)/u, "");
  const extension = extname(path);
  if (extension === ".jsx" || extension === ".tsx") {
    throw new Error(
      `provider plugin implementation module ${path} uses configuration-dependent JSX or TSX; publish deterministic JavaScript or TypeScript instead`,
    );
  }
  const scanner =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? providerPluginImportScanners.ts
      : providerPluginImportScanners.js;
  return scanner.scanImports(moduleSource);
}

const opaqueModuleLoaderNames = new Set([
  "createRequire",
  "eval",
  "getBuiltinModule",
]);

function hasOneLiteralModuleArgument(node: ts.CallExpression): boolean {
  const [argument] = node.arguments;
  return node.arguments.length === 1
    && argument !== undefined
    && ts.isStringLiteralLike(argument);
}

function propertyLoaderName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument !== undefined && ts.isStringLiteralLike(argument)
    ? argument.text
    : undefined;
}

function propertyLoaderReference(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  const name = propertyLoaderName(node);
  if (name === undefined) return false;
  if (opaqueModuleLoaderNames.has(name)) return true;
  if (name !== "require") return false;
  const owner = node.expression;
  return ts.isIdentifier(owner)
    && (
      owner.text === "global"
      || owner.text === "globalThis"
      || owner.text === "mod"
      || owner.text === "module"
    );
}

function isPropertyNameIdentifier(
  node: ts.Identifier,
  parent: ts.Node | undefined,
): boolean {
  if (parent === undefined) return false;
  return (
    ts.isPropertyAccessExpression(parent)
    && parent.name === node
  ) || (
    (
      ts.isPropertyAssignment(parent)
      || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent)
      || ts.isMethodSignature(parent)
    )
    && parent.name === node
  );
}

function providerPluginScriptKind(path: string): ts.ScriptKind {
  const extension = extname(path);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

/**
 * Conservatively rejects runtime loading that Bun's literal import scanner
 * cannot bind to an exact dependency edge. Source plugins remain trusted code;
 * this AST policy prevents accidental identity omissions and common aliases,
 * rather than attempting to sandbox deliberately obfuscated JavaScript.
 */
function hasNonLiteralModuleLoad(source: string, path: string): boolean {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ESNext,
    false,
    providerPluginScriptKind(path),
  );
  let found = false;
  const visit = (node: ts.Node, parent?: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        found = !hasOneLiteralModuleArgument(node);
        return;
      }
      if (
        ts.isIdentifier(node.expression)
        && node.expression.text === "require"
      ) {
        found = !hasOneLiteralModuleArgument(node);
        return;
      }
      if (
        ts.isIdentifier(node.expression)
        && (
          opaqueModuleLoaderNames.has(node.expression.text)
          || node.expression.text === "Function"
        )
      ) {
        found = true;
        return;
      }
      if (
        (
          ts.isPropertyAccessExpression(node.expression)
          || ts.isElementAccessExpression(node.expression)
        )
        && (
          propertyLoaderName(node.expression) === "require"
          || opaqueModuleLoaderNames.has(
            propertyLoaderName(node.expression) ?? "",
          )
        )
      ) {
        found = true;
        return;
      }
    }
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "Function"
    ) {
      found = true;
      return;
    }
    if (
      (
        ts.isPropertyAccessExpression(node)
        || ts.isElementAccessExpression(node)
      )
      && propertyLoaderReference(node)
    ) {
      found = true;
      return;
    }
    if (
      ts.isIdentifier(node)
      && !isPropertyNameIdentifier(node, parent)
      && (
        node.text === "require"
        || opaqueModuleLoaderNames.has(node.text)
      )
    ) {
      found = true;
      return;
    }
    node.forEachChild((child) => visit(child, node));
  };
  visit(sourceFile);
  return found;
}

function analyzeProviderModule(
  bytes: Buffer,
  path: string,
  cache: ProviderModuleAnalysisCache,
  options: {
    readonly contentSha256?: string;
    readonly reviewedLargeDynamicModule?: boolean;
  } = {},
): InstalledModuleAnalysis {
  const contentSha256 = options.contentSha256
    ?? createHash("sha256").update(bytes).digest("hex");
  const reviewedLargeDynamicModule =
    options.reviewedLargeDynamicModule === true;
  if (
    bytes.byteLength > MAX_PROVIDER_EXECUTABLE_MODULE_BYTES
    && !reviewedLargeDynamicModule
  ) {
    throw new Error(
      `provider plugin executable module ${path} exceeds its static-analysis byte bound`,
    );
  }
  const analysisKey =
    `${providerPluginScriptKind(path)}\0${contentSha256}\0${reviewedLargeDynamicModule ? "reviewed-dynamic" : "ordinary"}`;
  const cached = cache.values.get(analysisKey);
  if (cached !== undefined) return cached;

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `provider plugin executable module ${path} must be valid UTF-8`,
    );
  }
  const imports = Object.freeze([...valueImports(source, path)]);
  if (imports.length > MAX_PROVIDER_MODULE_IMPORTS) {
    throw new Error(
      `provider plugin executable module ${path} has too many static imports`,
    );
  }
  if (cache.imports + imports.length > MAX_REGISTRY_ANALYZED_IMPORTS) {
    throw new Error(
      "provider plugin registry analyzed import closure exceeds its bound",
    );
  }
  const analysis = Object.freeze({
    imports,
    nonLiteralModuleLoad: reviewedLargeDynamicModule
      || hasNonLiteralModuleLoad(source, path),
  });
  cache.imports += imports.length;
  cache.values.set(analysisKey, analysis);
  return analysis;
}

function resolveLocalImport(
  importerPath: string,
  specifier: string,
  importKind = "import-statement",
): string | undefined {
  return resolveBareDependencyIfPresent(
    importerPath,
    specifier,
    importKind,
  );
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`));
}

function isRuntimeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:")
    || specifier.startsWith("bun:")
    || runtimeBuiltins.has(specifier);
}

function isMissingModuleResolutionError(error: unknown): boolean {
  if (!recordValue(error)) return false;
  const code = error.code;
  const message = error.message;
  return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
    && typeof message === "string"
    && /^Cannot find (?:module|package) /u.test(message);
}

function resolveBareDependencyIfPresent(
  importerPath: string,
  specifier: string,
  importKind = "import-statement",
): string | undefined {
  if (isAbsolute(specifier)) {
    let directPath: string;
    try {
      directPath = realpathSync(specifier);
    } catch (error) {
      throw new Error(
        `provider plugin implementation absolute dependency ${specifier} is unreadable`,
        { cause: error },
      );
    }
    if (providerPluginAbsoluteImportTargets.has(directPath)) return directPath;
    throw new Error(
      `provider plugin implementation imports unsupported absolute or URL dependency ${specifier}`,
    );
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) {
    throw new Error(
      `provider plugin implementation imports unsupported absolute or URL dependency ${specifier}`,
    );
  }
  let resolvedPath: string;
  try {
    resolvedPath = importKind === "require-call"
      ? createRequire(importerPath).resolve(specifier)
      : Bun.resolveSync(specifier, dirname(importerPath));
  } catch (error) {
    if (isMissingModuleResolutionError(error)) return undefined;
    throw new Error(
      `provider plugin implementation dependency ${specifier} could not be resolved safely`,
      { cause: error },
    );
  }
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(resolvedPath)
    || !isAbsolute(resolvedPath)
  ) {
    throw new Error(
      `provider plugin implementation dependency ${specifier} did not resolve to a local file`,
    );
  }
  let path: string;
  try {
    path = realpathSync(resolvedPath);
  } catch (error) {
    throw new Error(
      `provider plugin implementation dependency ${specifier} resolved to an unreadable path`,
      { cause: error },
    );
  }
  classifyProviderPluginPhysicalPath(path);
  return path;
}

function resolvedBareDependency(
  importerPath: string,
  specifier: string,
  importKind = "import-statement",
): string {
  const path = resolveBareDependencyIfPresent(
    importerPath,
    specifier,
    importKind,
  );
  if (path === undefined) {
    throw new Error(
      `provider plugin implementation imports unresolved dependency ${specifier}`,
    );
  }
  return path;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope !== undefined && name !== undefined
      ? `${scope}/${name}`
      : undefined;
  }
  const [name] = specifier.split("/");
  return name === undefined || name === "" || name.startsWith("#")
    ? undefined
    : name;
}

function installedPackageRoot(
  entryPath: string,
): string {
  const physicalPath = classifyProviderPluginPhysicalPath(entryPath);
  if (physicalPath.kind === "installed-package") return physicalPath.root;
  throw new Error(
    "installed package entry has no physical node_modules owner",
  );
}

function packageDependencyNames(
  value: unknown,
  label: string,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!recordValue(value)) {
    throw new Error(`installed package ${label} must be an object`);
  }
  const names = Object.keys(value).sort();
  for (const name of names) {
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)
      || name.length > 214
      || typeof value[name] !== "string"
      || value[name].length < 1
      || value[name].length > 512
    ) {
      throw new Error(`installed package ${label} is invalid`);
    }
  }
  return Object.freeze(names);
}

function parseInstalledPackageManifest(
  bytes: Buffer,
  root: string,
): {
  readonly name: string;
  readonly version: string;
  readonly dependencies: readonly InstalledPackageDependency[];
} {
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error(`installed package manifest ${root} is invalid`);
  }
  if (!recordValue(value)) {
    throw new Error(`installed package manifest ${root} must be an object`);
  }
  const name = value.name;
  const version = value.version;
  if (
    typeof name !== "string"
    || name.length > 214
    || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(name)
    || typeof version !== "string"
    || version.length > 128
    || !strictSemverPattern.test(version)
  ) {
    throw new Error(`installed package manifest ${root} has invalid identity`);
  }
  const optional = new Set(
    packageDependencyNames(
      value.optionalDependencies,
      `${name} optionalDependencies`,
    ),
  );
  const dependencies: InstalledPackageDependency[] = [];
  for (
    const dependency of packageDependencyNames(
      value.dependencies,
      `${name} dependencies`,
    )
  ) {
    if (optional.has(dependency)) continue;
    dependencies.push({ kind: "dependency", name: dependency });
  }
  for (const dependency of [...optional].sort()) {
    dependencies.push({ kind: "optional-dependency", name: dependency });
  }
  for (
    const dependency of packageDependencyNames(
      value.peerDependencies,
      `${name} peerDependencies`,
    )
  ) {
    let optionalPeer = false;
    if (value.peerDependenciesMeta !== undefined) {
      if (!recordValue(value.peerDependenciesMeta)) {
        throw new Error(
          `installed package ${name} peerDependenciesMeta must be an object`,
        );
      }
      const metadata = value.peerDependenciesMeta[dependency];
      if (metadata !== undefined) {
        if (
          !recordValue(metadata)
          || (
            metadata.optional !== undefined
            && typeof metadata.optional !== "boolean"
          )
        ) {
          throw new Error(
            `installed package ${name} peerDependenciesMeta is invalid`,
          );
        }
        optionalPeer = metadata.optional === true;
      }
    }
    dependencies.push({
      kind: optionalPeer ? "optional-peer-dependency" : "peer-dependency",
      name: dependency,
    });
  }
  dependencies.sort((left, right) =>
    compareIdentityText(left.kind, right.kind)
      || compareIdentityText(left.name, right.name));
  return {
    name,
    version,
    dependencies: Object.freeze(dependencies),
  };
}

type InstalledPackageTreeEntry = {
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly stats: BigIntStats;
};

type InstalledPackageTreeWalk = {
  readonly entries: readonly InstalledPackageTreeEntry[];
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly totalBytes: number;
};

function walkInstalledPackageTree(root: string): InstalledPackageTreeWalk {
  const entries: InstalledPackageTreeEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  const visit = (
    directoryPath: string,
    relativeDirectory: string,
    depth: number,
  ): void => {
    if (depth > MAX_INSTALLED_PACKAGE_DEPTH) {
      throw new Error("installed package tree exceeds its depth bound");
    }
    let before: BigIntStats;
    try {
      before = lstatSync(directoryPath, { bigint: true });
    } catch {
      throw new Error(
        `installed package directory ${relativeDirectory || "."} changed while it was walked`,
      );
    }
    if (
      before.isSymbolicLink()
      || !before.isDirectory()
      || !ownedByCurrentUser(before)
      || (before.mode & 0o022n) !== 0n
    ) {
      throw new Error(
        `installed package directory ${relativeDirectory || "."} is unsafe`,
      );
    }
    directoryCount += 1;
    if (directoryCount > MAX_INSTALLED_PACKAGE_DIRECTORIES) {
      throw new Error("installed package tree exceeds its directory bound");
    }
    entries.push(Object.freeze({
      path: relativeDirectory === "" ? "." : relativeDirectory,
      kind: "directory",
      stats: before,
    }));
    const descriptor = openSync(
      directoryPath,
      constants.O_RDONLY
        | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
        | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
    );
    try {
      const bound = fstatSync(descriptor, { bigint: true });
      if (!bound.isDirectory() || !sameFileSnapshot(before, bound)) {
        throw new Error(
          `installed package directory ${relativeDirectory || "."} changed while it was bound`,
        );
      }
      const names: string[] = [];
      const directory = opendirSync(directoryPath);
      try {
        for (;;) {
          const entry = directory.readSync();
          if (entry === null) break;
          names.push(entry.name);
          if (
            names.length
              > MAX_INSTALLED_PACKAGE_FILES
                + MAX_INSTALLED_PACKAGE_DIRECTORIES
            || entries.length + names.length
              > MAX_INSTALLED_PACKAGE_FILES
                + MAX_INSTALLED_PACKAGE_DIRECTORIES
          ) {
            throw new Error("installed package tree exceeds its entry bound");
          }
        }
      } finally {
        directory.closeSync();
      }
      names.sort(compareIdentityText);
      for (const name of names) {
        const relativePath = relativeDirectory === ""
          ? name
          : `${relativeDirectory}/${name}`;
        if (
          name === "."
          || name === ".."
          || name.includes("/")
          || relativePath.includes("\\")
          || relativePath.includes("\u0000")
          || Buffer.byteLength(relativePath, "utf8")
            > MAX_INSTALLED_PACKAGE_PATH_BYTES
        ) {
          throw new Error("installed package tree contains an unsafe path");
        }
        const path = resolve(directoryPath, name);
        let stats: BigIntStats;
        try {
          stats = lstatSync(path, { bigint: true });
        } catch {
          throw new Error(
            `installed package entry ${relativePath} changed while it was walked`,
          );
        }
        if (stats.isSymbolicLink()) {
          throw new Error(
            `installed package tree contains symlink ${relativePath}`,
          );
        }
        if (stats.isDirectory()) {
          visit(path, relativePath, depth + 1);
          continue;
        }
        if (
          !stats.isFile()
          || !ownedByCurrentUser(stats)
        ) {
          throw new Error(
            `installed package tree contains unsupported entry ${relativePath}`,
          );
        }
        fileCount += 1;
        if (fileCount > MAX_INSTALLED_PACKAGE_FILES) {
          throw new Error("installed package tree exceeds its file bound");
        }
        if (
          stats.size < 0n
          || stats.size > BigInt(MAX_PROVIDER_DEPENDENCY_FILE_BYTES)
        ) {
          throw new Error(
            `installed package file ${relativePath} exceeds its byte bound`,
          );
        }
        totalBytes += Number(stats.size);
        if (totalBytes > MAX_INSTALLED_PACKAGE_TOTAL_BYTES) {
          throw new Error("installed package tree exceeds its total byte bound");
        }
        entries.push(Object.freeze({
          path: relativePath,
          kind: "file",
          stats,
        }));
      }
      const after = fstatSync(descriptor, { bigint: true });
      let current: BigIntStats;
      try {
        current = lstatSync(directoryPath, { bigint: true });
      } catch {
        throw new Error(
          `installed package directory ${relativeDirectory || "."} changed while it was walked`,
        );
      }
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !sameFileSnapshot(before, after)
        || !sameFileSnapshot(after, current)
      ) {
        throw new Error(
          `installed package directory ${relativeDirectory || "."} changed while it was walked`,
        );
      }
    } finally {
      closeSync(descriptor);
    }
  };
  visit(root, "", 0);
  entries.sort((left, right) =>
    compareIdentityText(left.path, right.path)
      || compareIdentityText(left.kind, right.kind));
  return Object.freeze({
    entries: Object.freeze(entries),
    fileCount,
    directoryCount,
    totalBytes,
  });
}

function sameInstalledPackageTree(
  before: InstalledPackageTreeWalk,
  after: InstalledPackageTreeWalk,
): boolean {
  if (
    before.entries.length !== after.entries.length
    || before.fileCount !== after.fileCount
    || before.directoryCount !== after.directoryCount
    || before.totalBytes !== after.totalBytes
  ) return false;
  return before.entries.every((entry, index) => {
    const current = after.entries[index];
    return current !== undefined
      && entry.path === current.path
      && entry.kind === current.kind
      && sameFileSnapshot(entry.stats, current.stats);
  });
}

function assertInstalledPackageRegistryCacheBounds(
  snapshots: ReadonlyMap<string, InstalledPackageSnapshot>,
): void {
  if (snapshots.size > MAX_REGISTRY_INSTALLED_PACKAGES) {
    throw new Error("provider plugin registry installed package cache is too large");
  }
  let files = 0;
  let directories = 0;
  let bytes = 0;
  for (const snapshot of snapshots.values()) {
    files += snapshot.files.length;
    directories += snapshot.directories.length;
    bytes += snapshot.totalBytes;
  }
  if (
    files > MAX_REGISTRY_INSTALLED_FILES
    || directories > MAX_REGISTRY_INSTALLED_DIRECTORIES
  ) {
    throw new Error(
      "provider plugin registry installed package cache exceeds its entry bound",
    );
  }
  if (bytes > MAX_REGISTRY_INSTALLED_BYTES) {
    throw new Error(
      "provider plugin registry installed package cache exceeds its byte bound",
    );
  }
}

function snapshotInstalledPackage(
  entryPath: string,
  expectedPackageName: string,
  snapshotDependencySource: (path: string) => Buffer,
): InstalledPackageSnapshot {
  const root = installedPackageRoot(entryPath);
  const before = walkInstalledPackageTree(root);
  const files: InstalledPackageFileSnapshot[] = [];
  const directories: InstalledPackageDirectorySnapshot[] = [];
  for (const entry of before.entries) {
    if (entry.kind === "directory") {
      directories.push(Object.freeze({
        path: entry.path,
        mode: Number(entry.stats.mode & 0o777n),
      }));
      continue;
    }
    const path = resolve(root, entry.path);
    const bytes = Buffer.from(snapshotDependencySource(path));
    let current: BigIntStats;
    try {
      current = lstatSync(path, { bigint: true });
    } catch {
      throw new Error(
        `installed package file ${entry.path} changed while it was snapshotted`,
      );
    }
    if (
      bytes.byteLength !== Number(entry.stats.size)
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameFileSnapshot(entry.stats, current)
    ) {
      throw new Error(
        `installed package file ${entry.path} changed while it was snapshotted`,
      );
    }
    files.push(Object.freeze({
      path: entry.path,
      bytes,
      mode: Number(entry.stats.mode & 0o777n),
    }));
  }
  const after = walkInstalledPackageTree(root);
  if (!sameInstalledPackageTree(before, after)) {
    throw new Error("installed package tree changed while it was snapshotted");
  }
  const manifest = files.find((file) => file.path === "package.json");
  if (
    manifest === undefined
    || manifest.bytes.byteLength < 1
    || manifest.bytes.byteLength > MAX_PACKAGE_MANIFEST_BYTES
  ) {
    throw new Error("installed package tree has no bounded package.json");
  }
  const parsed = parseInstalledPackageManifest(manifest.bytes, root);
  const treeHash = createHash("sha256");
  treeHash.update("provider-plugin-installed-package-tree@1\0");
  updateLengthFramedHash(
    treeHash,
    "identity",
    Buffer.from(`${parsed.name}@${parsed.version}`, "utf8"),
  );
  for (const directory of directories) {
    const durableMode = providerPluginDurableInstalledPackageMode(
      "directory",
      directory.mode,
    );
    updateLengthFramedHash(
      treeHash,
      `directory/${directory.path}`,
      Buffer.from(`mode:${durableMode.toString(8)}`, "utf8"),
    );
  }
  for (const file of files) {
    const durableMode = providerPluginDurableInstalledPackageMode(
      "file",
      file.mode,
    );
    updateLengthFramedHash(
      treeHash,
      `file-mode/${file.path}`,
      Buffer.from(`mode:${durableMode.toString(8)}`, "utf8"),
    );
    updateLengthFramedHash(treeHash, `file/${file.path}`, file.bytes);
  }
  return Object.freeze({
    root,
    id: `${parsed.name}@${parsed.version}`,
    installName: expectedPackageName,
    name: parsed.name,
    version: parsed.version,
    treeSha256: treeHash.digest("hex"),
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    dependencies: parsed.dependencies,
    totalBytes: before.totalBytes,
    verificationWalk: after,
  });
}

/**
 * Bind package imports to an exact, relocation-stable runtime closure.
 * Repository workspace modules contribute only their recursively imported
 * source bytes. Installed packages contribute bounded atomic package trees
 * plus exact resolution edges for required, optional, and peer dependencies.
 */
function providerPluginPackageDependencyIdentity(
  plugin: ProviderPluginV1,
  implementationSources: ProviderPluginImplementationSourceSnapshot,
  snapshotDependencySource: (path: string) => Buffer,
  installedPackageSnapshots: Map<string, InstalledPackageSnapshot> = new Map(),
  moduleAnalyses: ProviderModuleAnalysisCache = {
    values: new Map(),
    imports: 0,
  },
  snapshotExecutionConfigSource: (path: string) => Buffer =
    snapshotDependencySource,
): ProviderPluginPackageDependencySnapshot {
  const records = new Map<string, Buffer>();
  let recordBytes = 0;
  const addRecord = (label: string, value: Buffer | string): void => {
    const bytes = typeof value === "string"
      ? Buffer.from(value, "utf8")
      : value;
    const existing = records.get(label);
    if (existing !== undefined) {
      if (!existing.equals(bytes)) {
        throw new Error(
          `provider plugin ${plugin.id} dependency identity is ambiguous at ${label}`,
        );
      }
      return;
    }
    if (
      records.size >= MAX_PLUGIN_DEPENDENCY_RECORDS
      || recordBytes + bytes.byteLength > MAX_PLUGIN_DEPENDENCY_RECORD_BYTES
    ) {
      throw new Error(
        `provider plugin ${plugin.id} dependency identity exceeds its record bound`,
      );
    }
    records.set(label, Buffer.from(bytes));
    recordBytes += bytes.byteLength;
  };
  const addResolutionEdge = (
    importer: string,
    specifier: string,
    target: string,
    importKind: string,
  ): void => {
    const coordinate = JSON.stringify([importer, specifier, importKind]);
    addRecord(
      `dependency-edge/${Buffer.from(coordinate, "utf8").toString("base64url")}`,
      JSON.stringify({ importer, importKind, specifier, target }),
    );
  };
  const bindExecutionConfigFile = (
    label: string,
    path: string,
  ): Buffer => {
    const bytes = snapshotExecutionConfigSource(path);
    addRecord(`execution-config/${label}`, bytes);
    return bytes;
  };
  const stableExecutionConfigJson = (value: unknown): string => {
    if (
      value === null
      || typeof value === "boolean"
      || typeof value === "string"
    ) return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(stableExecutionConfigJson).join(",")}]`;
    }
    if (typeof value === "object") {
      const record = value as Readonly<Record<string, unknown>>;
      return `{${Object.keys(record).sort(compareIdentityText).map((key) =>
        `${JSON.stringify(key)}:${stableExecutionConfigJson(record[key])}`)
        .join(",")}}`;
    }
    throw new Error(
      `provider plugin ${plugin.id} execution configuration is not JSON-compatible`,
    );
  };
  const bindPackageExecutionConfig = (
    label: string,
    path: string,
  ): void => {
    const bytes = snapshotExecutionConfigSource(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new Error(
        `provider plugin ${plugin.id} execution package.json is invalid`,
      );
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      throw new Error(
        `provider plugin ${plugin.id} execution package.json must be an object`,
      );
    }
    const manifest = parsed as Readonly<Record<string, unknown>>;
    addRecord(
      `execution-config/${label}`,
      stableExecutionConfigJson({
        exports: manifest.exports ?? null,
        imports: manifest.imports ?? null,
        name: manifest.name ?? null,
        type: manifest.type ?? "commonjs",
      }),
    );
  };
  const requireSafeBunfig = (
    bytes: Buffer,
    label: string,
  ): void => {
    let parsed: unknown;
    try {
      parsed = Bun.TOML.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`provider plugin ${plugin.id} ${label} is invalid TOML`);
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) {
      throw new Error(`provider plugin ${plugin.id} ${label} must be a table`);
    }
    const unsupported = Object.keys(parsed).filter((key) => key !== "install");
    if (unsupported.length > 0) {
      throw new Error(
        `provider plugin ${plugin.id} ${label} contains unsupported runtime configuration: ${unsupported.sort(compareIdentityText).join(", ")}`,
      );
    }
  };
  const resolveExtendedTsconfig = (
    configPath: string,
    specifier: string,
  ): string => {
    let candidate: string;
    if (specifier.startsWith(".") || isAbsolute(specifier)) {
      const base = resolve(dirname(configPath), specifier);
      const candidates = [
        base,
        ...(base.endsWith(".json") ? [] : [`${base}.json`]),
      ];
      const matched = candidates.find((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
      if (matched === undefined) {
        throw new Error(
          `provider plugin ${plugin.id} tsconfig extends unresolved ${specifier}`,
        );
      }
      candidate = matched;
    } else {
      try {
        candidate = createRequire(configPath).resolve(specifier);
      } catch {
        throw new Error(
          `provider plugin ${plugin.id} tsconfig extends unresolved ${specifier}`,
        );
      }
    }
    const canonical = realpathSync(candidate);
    if (!isWithin(repositoryRoot, canonical)) {
      throw new Error(
        `provider plugin ${plugin.id} tsconfig extends outside the repository`,
      );
    }
    return canonical;
  };
  const bindTsconfigClosure = (
    entryPath: string,
  ): void => {
    const pendingConfigs = [entryPath];
    const visited = new Set<string>();
    while (pendingConfigs.length > 0) {
      if (visited.size >= 32) {
        throw new Error(
          `provider plugin ${plugin.id} tsconfig extends chain is too deep`,
        );
      }
      const configPath = pendingConfigs.pop();
      if (configPath === undefined || visited.has(configPath)) continue;
      visited.add(configPath);
      const relativePath = relative(repositoryRoot, configPath)
        .split(sep).join("/");
      const bytes = bindExecutionConfigFile(
        `typescript/${relativePath}`,
        configPath,
      );
      const parsed = ts.parseConfigFileTextToJson(
        configPath,
        bytes.toString("utf8"),
      );
      if (parsed.error !== undefined || parsed.config === undefined) {
        throw new Error(
          `provider plugin ${plugin.id} execution tsconfig ${relativePath} is invalid`,
        );
      }
      const rawExtends: unknown = (
        parsed.config as Readonly<Record<string, unknown>>
      ).extends;
      const specifiers =
        typeof rawExtends === "string"
          ? [rawExtends]
          : Array.isArray(rawExtends)
            ? rawExtends
            : [];
      if (
        specifiers.some((specifier) => typeof specifier !== "string")
      ) {
        throw new Error(
          `provider plugin ${plugin.id} execution tsconfig ${relativePath} has invalid extends`,
        );
      }
      for (const specifier of specifiers as string[]) {
        const extendedPath = resolveExtendedTsconfig(configPath, specifier);
        addRecord(
          `execution-config/typescript-extends/${Buffer.from(
            JSON.stringify([relativePath, specifier]),
            "utf8",
          ).toString("base64url")}`,
          JSON.stringify({
            from: relativePath,
            specifier,
            target: relative(repositoryRoot, extendedPath)
              .split(sep).join("/"),
          }),
        );
        pendingConfigs.push(extendedPath);
      }
    }
  };
  const assertNoAmbientRuntimeOverrides = (): void => {
    if (
      process.env.BUN_CONFIG_FILE !== undefined
      || process.env.BUN_OPTIONS !== undefined
    ) {
      throw new Error(
        `provider plugin ${plugin.id} refuses ambient Bun configuration overrides`,
      );
    }
    const semanticOption =
      /^(?:(?:--config|--conditions|--cwd|--define|--drop|--extension-order|--feature|--hot|--ignore-dce-annotations|--import|--install|--jsx-factory|--jsx-fragment|--jsx-import-source|--jsx-runtime|--jsx-side-effects|--loader|--main-fields|--no-addons|--no-macros|--prefer-latest|--preload|--preserve-symlinks|--preserve-symlinks-main|--require|--tsconfig-override|--watch)(?:=|$)|-[cdilr](?:=|.|$))/u;
    if (process.execArgv.some((argument) => semanticOption.test(argument))) {
      throw new Error(
        `provider plugin ${plugin.id} refuses Bun loader, define, preload, condition, or tsconfig CLI overrides`,
      );
    }
    if (
      process.env.NODE_OPTIONS !== undefined
      && /(?:--conditions|--experimental-loader|--import|--loader|--require|-r)(?:=|\s|$)/u
        .test(process.env.NODE_OPTIONS)
    ) {
      throw new Error(
        `provider plugin ${plugin.id} refuses semantic NODE_OPTIONS overrides`,
      );
    }
  };
  const bindProviderPluginExecutionConfig = (): void => {
    let invocationRoot: string;
    try {
      invocationRoot = realpathSync(process.cwd());
    } catch {
      throw new Error(
        `provider plugin ${plugin.id} cannot resolve its invocation root`,
      );
    }
    const standalonePackage = repositoryRoot === providerPluginPackageRoot;
    if (
      !standalonePackage
      && invocationRoot !== repositoryRoot
      && invocationRoot !== providerPluginPackageRoot
    ) {
      throw new Error(
        `provider plugin ${plugin.id} must start from the checked Wrench package or repository root`,
      );
    }
    assertNoAmbientRuntimeOverrides();
    addRecord("execution-runtime/bun-version", Bun.version);
    addRecord(
      "execution-runtime/node-env",
      process.env.NODE_ENV ?? "",
    );
    bindPackageExecutionConfig(
      "repository-package.json",
      repositoryPackagePath,
    );
    if (packageManifestPath !== repositoryPackagePath) {
      bindPackageExecutionConfig(
        "wrench-package.json",
        packageManifestPath,
      );
    }
    const bunfig = bindExecutionConfigFile(
      "repository-bunfig.toml",
      repositoryBunfigPath,
    );
    requireSafeBunfig(bunfig, "repository bunfig.toml");
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const globalBunfigPath =
      xdgConfigHome === undefined || xdgConfigHome === ""
        ? resolve(homedir(), ".bunfig.toml")
        : resolve(xdgConfigHome, ".bunfig.toml");
    if (existsSync(globalBunfigPath)) {
      const bytes = readStableDependencyFile(
        globalBunfigPath,
        MAX_PROVIDER_DEPENDENCY_FILE_BYTES,
        `provider plugin ${plugin.id} global bunfig`,
      );
      requireSafeBunfig(bytes, "global bunfig.toml");
    }
    bindTsconfigClosure(repositoryTsconfigPath);
    if (packageTsconfigPath !== repositoryTsconfigPath) {
      bindTsconfigClosure(packageTsconfigPath);
    }
  };
  const bindRepositoryPackageScope = (path: string): void => {
    if (extname(path) !== ".js") return;
    let directory = dirname(path);
    for (;;) {
      const manifestPath = resolve(directory, "package.json");
      if (existsSync(manifestPath)) {
        const canonical = realpathSync(manifestPath);
        if (!isWithin(repositoryRoot, canonical)) {
          throw new Error(
            `provider plugin ${plugin.id} JavaScript package scope escapes the repository`,
          );
        }
        bindPackageExecutionConfig(
          `javascript-package-scope/${relative(repositoryRoot, canonical)
            .split(sep).join("/")}`,
          canonical,
        );
        return;
      }
      if (directory === repositoryRoot) break;
      const parent = dirname(directory);
      if (parent === directory || !isWithin(repositoryRoot, parent)) break;
      directory = parent;
    }
    throw new Error(
      `provider plugin ${plugin.id} JavaScript module has no governing package.json`,
    );
  };
  bindProviderPluginExecutionConfig();
  type PendingRepositoryDependency = {
    readonly discoveredBy: string;
    readonly path: string;
    readonly logicalLabel: string;
    readonly packageDepth: number;
  };
  type InstalledPackageOccurrence = {
    readonly nodeId: string;
    readonly snapshot: InstalledPackageSnapshot;
  };
  type PendingInstalledModule = {
    readonly occurrence: InstalledPackageOccurrence;
    readonly path: string;
    readonly packageDepth: number;
  };
  const pending: PendingRepositoryDependency[] = [];
  const pendingInstalledModules: PendingInstalledModule[] = [];
  const visitedRepositorySources = new Set<string>();
  const installedPackageFiles =
    new Map<string, ReadonlyMap<string, InstalledPackageFileSnapshot>>();
  const installedOccurrences = new Map<string, InstalledPackageOccurrence>();
  const reviewedKbDynamicInstalledModuleIdentities = new Map<string, string>();
  const usedInstalledPackageRoots = new Set<string>();
  const visitedInstalledModules = new Set<string>();
  let installedFiles = 0;
  let installedDirectories = 0;
  let installedBytes = 0;
  let repositoryBytes = 0;
  const implementationLabelsByPath = new Map(
    plugin.implementationSources.map((source) => [source.path, source.label]),
  );

  const packageSnapshot = (
    entryPath: string,
    expectedPackageName: string,
  ): InstalledPackageSnapshot => {
    const root = installedPackageRoot(entryPath);
    let snapshot = installedPackageSnapshots.get(root);
    if (snapshot === undefined) {
      snapshot = snapshotInstalledPackage(
        entryPath,
        expectedPackageName,
        snapshotDependencySource,
      );
      installedPackageSnapshots.set(root, snapshot);
    } else if (snapshot.installName !== expectedPackageName) {
      throw new Error(
        `provider plugin ${plugin.id} dependency expected install key ${expectedPackageName} but reused ${snapshot.installName}`,
      );
    }
    usedInstalledPackageRoots.add(snapshot.root);
    return snapshot;
  };

  const packageFile = (
    snapshot: InstalledPackageSnapshot,
    path: string,
  ): InstalledPackageFileSnapshot | undefined => {
    let files = installedPackageFiles.get(snapshot.root);
    if (files === undefined) {
      files = new Map(snapshot.files.map((file) => [file.path, file]));
      installedPackageFiles.set(snapshot.root, files);
    }
    return files.get(path);
  };

  const scheduleInstalledModule = (
    occurrence: InstalledPackageOccurrence,
    entryRelativePath: string,
    packageDepth: number,
  ): void => {
    const extension = extname(entryRelativePath);
    if (
      extension !== ".json"
      && !providerPluginModuleExtensions.has(extension)
    ) {
      throw new Error(
        `provider plugin ${plugin.id} installed package ${occurrence.snapshot.id} resolves to unsupported executable ${entryRelativePath}`,
      );
    }
    if (providerPluginModuleExtensions.has(extension)) {
      pendingInstalledModules.push({
        occurrence,
        path: entryRelativePath,
        packageDepth,
      });
    }
  };

  const resolveInstalledLocalImport = (
    snapshot: InstalledPackageSnapshot,
    importerRelativePath: string,
    specifier: string,
    importKind: string,
  ): InstalledPackageFileSnapshot | undefined => {
    const importerPath = resolve(snapshot.root, importerRelativePath);
    const resolvedPath = resolveBareDependencyIfPresent(
      importerPath,
      specifier,
      importKind,
    );
    if (resolvedPath === undefined) return undefined;
    if (!isWithin(snapshot.root, resolvedPath)) {
      throw new Error(
        `provider plugin ${plugin.id} installed package ${snapshot.id} import ${specifier} escapes its package root`,
      );
    }
    const relativePath = relative(snapshot.root, resolvedPath)
      .split(sep).join("/");
    return packageFile(snapshot, relativePath);
  };

  const inferredInstalledPackageName = (
    entryPath: string,
  ): string | undefined => {
    const physicalPath = classifyProviderPluginPhysicalPath(entryPath);
    if (physicalPath.kind !== "installed-package") return undefined;
    const name = basename(physicalPath.root);
    const parent = basename(dirname(physicalPath.root));
    return parent.startsWith("@") ? `${parent}/${name}` : name;
  };

  const bindResolvedTarget = (
    importerLabel: string,
    specifier: string,
    path: string,
    expectedPackageName: string | undefined,
    packageDepth: number,
    importKind: string,
  ): void => {
    const physicalPath = classifyProviderPluginPhysicalPath(path);
    if (
      path === providerPluginsApiPath
    ) {
      throw new Error(
        `provider plugin ${plugin.id} imports the private process-wide provider catalog`,
      );
    }
    if (providerPluginAbsoluteImportTargets.has(path)) {
      addResolutionEdge(
        importerLabel,
        specifier,
        `kernel/provider-plugin-api@${PROVIDER_PLUGIN_API_VERSION}`,
        importKind,
      );
      return;
    }
    if (physicalPath.kind === "repository") {
      const extension = extname(path);
      if (
        extension !== ".json"
        && extension !== ".toml"
        && !providerPluginModuleExtensions.has(extension)
      ) {
        throw new Error(
          `provider plugin ${plugin.id} repository dependency ${specifier} resolves to unsupported module extension ${extension || "<none>"}`,
        );
      }
      const relativePath = relative(repositoryRoot, path).split(sep).join("/");
      addResolutionEdge(
        importerLabel,
        specifier,
        `repository/${relativePath}`,
        importKind,
      );
      pending.push({
        discoveredBy: importerLabel,
        path,
        logicalLabel: `repository/${relativePath}`,
        packageDepth,
      });
      return;
    }
    if (packageDepth > MAX_INSTALLED_PACKAGE_GRAPH_DEPTH) {
      throw new Error(
        `provider plugin ${plugin.id} installed package graph exceeds its depth bound`,
      );
    }
    const packageName =
      inferredInstalledPackageName(path) ?? expectedPackageName;
    if (packageName === undefined) {
      throw new Error(
        `provider plugin ${plugin.id} dependency ${specifier} has no exact installed package owner`,
      );
    }
    const snapshot = packageSnapshot(path, packageName);
    const entryRelativePath = relative(snapshot.root, path)
      .split(sep).join("/");
    if (
      entryRelativePath === ""
      || entryRelativePath === ".."
      || entryRelativePath.startsWith("../")
    ) {
      throw new Error(
        `provider plugin ${plugin.id} dependency entry escapes ${snapshot.id}`,
      );
    }
    if (packageFile(snapshot, entryRelativePath) === undefined) {
      throw new Error(
        `provider plugin ${plugin.id} dependency entry ${entryRelativePath} is absent from captured package ${snapshot.id}`,
      );
    }
    let occurrence = installedOccurrences.get(snapshot.root);
    if (occurrence === undefined) {
      if (installedOccurrences.size >= MAX_INSTALLED_PACKAGES) {
        throw new Error(
          `provider plugin ${plugin.id} installed package closure is too large`,
        );
      }
      const discoveryCoordinate =
        JSON.stringify([importerLabel, specifier, importKind]);
      const nodeId = createHash("sha256")
        .update("provider-plugin-installed-package-node@1\0")
        .update(discoveryCoordinate)
        .digest("base64url");
      occurrence = Object.freeze({ nodeId, snapshot });
      installedOccurrences.set(snapshot.root, occurrence);
      installedFiles += snapshot.files.length;
      installedDirectories += snapshot.directories.length;
      installedBytes += snapshot.totalBytes;
      if (
        installedFiles > MAX_INSTALLED_CLOSURE_FILES
        || installedDirectories > MAX_INSTALLED_CLOSURE_DIRECTORIES
      ) {
        throw new Error(
          `provider plugin ${plugin.id} installed package closure exceeds its entry bound`,
        );
      }
      if (installedBytes > MAX_INSTALLED_PACKAGE_TOTAL_BYTES) {
        throw new Error(
          `provider plugin ${plugin.id} installed package closure exceeds its byte bound`,
        );
      }
      addRecord(
        `dependency-package-node/${nodeId}`,
        JSON.stringify({
          installName: snapshot.installName,
          name: snapshot.name,
          treeSha256: snapshot.treeSha256,
          version: snapshot.version,
        }),
      );
    }
    addResolutionEdge(
      importerLabel,
      specifier,
      `package-node/${occurrence.nodeId}/${entryRelativePath}`,
      importKind,
    );
    scheduleInstalledModule(occurrence, entryRelativePath, packageDepth);
    // The package tree already binds its manifest, including every declared
    // dependency. Traverse only modules that its executable static imports
    // can reach. This keeps dormant optional/tooling graphs out of the runtime
    // identity while preserving exact resolution edges for code that can run.
  };

  for (
    const source of [...plugin.implementationSources]
      .sort((left, right) => compareIdentityText(left.label, right.label))
  ) {
    bindRepositoryPackageScope(source.path);
    if (!providerPluginModuleExtensions.has(extname(source.path))) continue;
    const sourceBytes = implementationSourceBytes(
      plugin,
      source,
      implementationSources,
    );
    const analysis = analyzeProviderModule(
      sourceBytes,
      source.path,
      moduleAnalyses,
    );
    for (
      const dependency of [...analysis.imports]
        .sort((left, right) => compareIdentityText(left.path, right.path))
    ) {
      const specifier = dependency.path;
      if (isRuntimeBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        const child = resolveLocalImport(
          source.path,
          specifier,
          dependency.kind,
        );
        if (child === undefined) {
          throw new Error(
            `provider plugin ${plugin.id} implementation source ${source.label} imports unresolved local value dependency ${specifier}`,
          );
        }
        const declaredLabel = implementationLabelsByPath.get(child);
        if (declaredLabel !== undefined) {
          addResolutionEdge(
            `implementation/${source.label}`,
            specifier,
            `implementation/${declaredLabel}`,
            dependency.kind,
          );
          continue;
        }
        bindResolvedTarget(
          `implementation/${source.label}`,
          specifier,
          child,
          undefined,
          0,
          dependency.kind,
        );
        continue;
      }
      const path = resolvedBareDependency(
        source.path,
        specifier,
        dependency.kind,
      );
      bindResolvedTarget(
        `implementation/${source.label}`,
        specifier,
        path,
        barePackageName(specifier),
        0,
        dependency.kind,
      );
    }
  }
  for (;;) {
    while (pending.length > 0) {
      pending.sort((left, right) =>
        compareIdentityText(left.logicalLabel, right.logicalLabel)
        || compareIdentityText(left.path, right.path));
      const dependencySource = pending.pop();
      if (
        dependencySource === undefined
        || visitedRepositorySources.has(dependencySource.path)
      ) continue;
      if (visitedRepositorySources.size >= 2_000) {
        throw new Error(
          `provider plugin ${plugin.id} package dependency closure is too large`,
        );
      }
      visitedRepositorySources.add(dependencySource.path);
      bindRepositoryPackageScope(dependencySource.path);
      const relativePath = relative(repositoryRoot, dependencySource.path)
        .split(sep).join("/");
      const bytes =
        implementationSources.get(dependencySource.path)
        ?? snapshotDependencySource(dependencySource.path);
      repositoryBytes += bytes.byteLength;
      if (repositoryBytes > MAX_INSTALLED_PACKAGE_TOTAL_BYTES) {
        throw new Error(
          `provider plugin ${plugin.id} repository dependency closure exceeds its byte bound`,
        );
      }
      addRecord(`dependency-source/${relativePath}`, bytes);
      if (
        !providerPluginModuleExtensions.has(extname(dependencySource.path))
      ) continue;
      const analysis = analyzeProviderModule(
        bytes,
        dependencySource.path,
        moduleAnalyses,
      );
      if (analysis.nonLiteralModuleLoad) {
        const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
        const reviewedDynamicModule =
          `${plugin.id}\0${relativePath}\0${sourceSha256}`;
        if (
          plugin.sourceKind !== "built-in"
          || !reviewedBuiltInDynamicRepositoryModules.has(reviewedDynamicModule)
        ) {
          throw new Error(
            `provider plugin ${plugin.id} package dependency ${relativePath} discovered by ${dependencySource.discoveredBy} contains a non-literal module load`,
          );
        }
        addRecord(
          `dependency-repository-dynamic-load-policy/${relativePath}`,
          `${reviewedDynamicModule}\0${reviewedKbDynamicResolutionPolicy}`,
        );
      }
      for (
        const dependency of [...analysis.imports]
          .sort((left, right) => compareIdentityText(left.path, right.path))
      ) {
        if (isRuntimeBuiltin(dependency.path)) continue;
        const child = dependency.path.startsWith(".")
          ? resolveLocalImport(
              dependencySource.path,
              dependency.path,
              dependency.kind,
            )
          : resolvedBareDependency(
              dependencySource.path,
              dependency.path,
              dependency.kind,
            );
        if (child === undefined) {
          throw new Error(
            `provider plugin ${plugin.id} package dependency ${relativePath} imports unresolved local value dependency ${dependency.path}`,
          );
        }
        bindResolvedTarget(
          dependencySource.logicalLabel,
          dependency.path,
          child,
          barePackageName(dependency.path),
          dependencySource.packageDepth,
          dependency.kind,
        );
      }
    }
    while (pendingInstalledModules.length > 0) {
    pendingInstalledModules.sort((left, right) =>
      compareIdentityText(left.occurrence.nodeId, right.occurrence.nodeId)
      || compareIdentityText(left.path, right.path));
    const pendingModule = pendingInstalledModules.pop();
    if (pendingModule === undefined) continue;
    const moduleKey =
      `${pendingModule.occurrence.nodeId}\0${pendingModule.path}`;
    if (visitedInstalledModules.has(moduleKey)) continue;
    if (
      visitedInstalledModules.size >= MAX_INSTALLED_EXECUTABLE_MODULES
    ) {
      throw new Error(
        `provider plugin ${plugin.id} installed executable closure is too large`,
      );
    }
    visitedInstalledModules.add(moduleKey);
    const file = packageFile(
      pendingModule.occurrence.snapshot,
      pendingModule.path,
    );
    if (file === undefined) {
      throw new Error(
        `provider plugin ${plugin.id} installed executable ${pendingModule.path} disappeared from its captured tree`,
      );
    }
    const moduleSha256 = createHash("sha256")
      .update(file.bytes)
      .digest("hex");
    const dynamicModuleIdentity =
      `${pendingModule.occurrence.snapshot.id}\0${pendingModule.path}\0${moduleSha256}`;
    let reviewedKbDynamicInstalledModuleIdentity: string | undefined;
    if (
      pendingModule.occurrence.snapshot.name
        === reviewedKbDynamicInstalledPackage.name
    ) {
      reviewedKbDynamicInstalledModuleIdentity =
        reviewedKbDynamicInstalledModuleIdentities.get(
          pendingModule.occurrence.snapshot.root,
        );
      if (reviewedKbDynamicInstalledModuleIdentity === undefined) {
        reviewedKbDynamicInstalledModuleIdentity =
          discoverReviewedKbDynamicInstalledModuleIdentity(
            pendingModule.occurrence.snapshot,
          );
        reviewedKbDynamicInstalledModuleIdentities.set(
          pendingModule.occurrence.snapshot.root,
          reviewedKbDynamicInstalledModuleIdentity,
        );
      }
    }
    const analysis = analyzeProviderModule(
      file.bytes,
      pendingModule.path,
      moduleAnalyses,
      {
        contentSha256: moduleSha256,
        reviewedLargeDynamicModule:
          reviewedDynamicInstalledModuleIdentities.includes(
            dynamicModuleIdentity,
          ),
      },
    );
    if (analysis.nonLiteralModuleLoad) {
      const reviewedDynamicModule =
        `${plugin.id}\0${dynamicModuleIdentity}`;
      const reviewedKbDynamicModule =
        dynamicModuleIdentity === reviewedKbDynamicInstalledModuleIdentity
        && reviewedKbDynamicInstalledPluginIds.has(plugin.id);
      if (
        plugin.sourceKind !== "built-in"
        || (
          !reviewedBuiltInDynamicInstalledModules.has(reviewedDynamicModule)
          && !reviewedKbDynamicModule
        )
      ) {
        throw new Error(
          `provider plugin ${plugin.id} installed executable ${pendingModule.path} contains a non-literal module load`,
        );
      }
      // KB executes one exact, reviewed package-manifest resolution from the
      // literal agent-browser call site. The Meta parser dependencies only
      // expose dormant dynamic loader APIs. Bind either narrow policy and the
      // exact module identity into the closure. A new call site or changed
      // module must receive a new byte-level review.
      addRecord(
        `dependency-package-dynamic-load-policy/${pendingModule.occurrence.nodeId}/${pendingModule.path}`,
        `${reviewedDynamicModule}\0${
          reviewedKbDynamicModule
            ? reviewedKbDynamicResolutionPolicy
            : reviewedDormantDynamicLoaderPolicy
        }`,
      );
    }
    const importerLabel =
      `package-node/${pendingModule.occurrence.nodeId}/module/${pendingModule.path}`;
    for (
      const dependency of [...analysis.imports]
        .sort((left, right) => compareIdentityText(left.path, right.path))
    ) {
      const specifier = dependency.path;
      if (isRuntimeBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        const child = resolveInstalledLocalImport(
          pendingModule.occurrence.snapshot,
          pendingModule.path,
          specifier,
          dependency.kind,
        );
        if (child === undefined) {
          throw new Error(
            `provider plugin ${plugin.id} installed executable ${pendingModule.path} imports unresolved local dependency ${specifier}`,
          );
        }
        addResolutionEdge(
          importerLabel,
          specifier,
          `package-node/${pendingModule.occurrence.nodeId}/${child.path}`,
          dependency.kind,
        );
        scheduleInstalledModule(
          pendingModule.occurrence,
          child.path,
          pendingModule.packageDepth,
        );
        continue;
      }
      if (
        specifier.startsWith("/")
        || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)
      ) {
        throw new Error(
          `provider plugin ${plugin.id} installed executable ${pendingModule.path} imports unsupported absolute or URL dependency ${specifier}`,
        );
      }
      const importerPath = resolve(
        pendingModule.occurrence.snapshot.root,
        pendingModule.path,
      );
      const dependencyPath = resolveBareDependencyIfPresent(
        importerPath,
        specifier,
        dependency.kind,
      );
      if (dependencyPath === undefined) {
        if (
          dependency.kind === "import-statement"
          || dependency.kind === "export-from"
        ) {
          throw new Error(
            `provider plugin ${plugin.id} installed executable ${pendingModule.path} imports unresolved static dependency ${specifier}`,
          );
        }
        addResolutionEdge(
          importerLabel,
          specifier,
          "absent",
          dependency.kind,
        );
        continue;
      }
      if (
        specifier.startsWith("#")
        && isWithin(
          pendingModule.occurrence.snapshot.root,
          dependencyPath,
        )
      ) {
        const relativePath = relative(
          pendingModule.occurrence.snapshot.root,
          dependencyPath,
        ).split(sep).join("/");
        const child = packageFile(
          pendingModule.occurrence.snapshot,
          relativePath,
        );
        if (child === undefined) {
          throw new Error(
            `provider plugin ${plugin.id} installed package import ${specifier} is absent from its captured tree`,
          );
        }
        addResolutionEdge(
          importerLabel,
          specifier,
          `package-node/${pendingModule.occurrence.nodeId}/${child.path}`,
          dependency.kind,
        );
        scheduleInstalledModule(
          pendingModule.occurrence,
          child.path,
          pendingModule.packageDepth,
        );
        continue;
      }
      bindResolvedTarget(
        importerLabel,
        specifier,
        dependencyPath,
        barePackageName(specifier),
        pendingModule.packageDepth + 1,
        dependency.kind,
      );
    }
    }
    if (pending.length === 0 && pendingInstalledModules.length === 0) break;
  }
  for (const root of usedInstalledPackageRoots) {
    const snapshot = installedPackageSnapshots.get(root);
    if (
      snapshot === undefined
      || !sameInstalledPackageTree(
        snapshot.verificationWalk,
        walkInstalledPackageTree(root),
      )
    ) {
      throw new Error(
        `provider plugin ${plugin.id} installed package closure changed while its identity was built`,
      );
    }
  }
  return Object.freeze(
    [...records.entries()]
      .sort(([left], [right]) => compareIdentityText(left, right))
      .map(([label, bytes]) => Object.freeze({ label, bytes })),
  );
}

/**
 * Require every implementation root to have a statically discoverable,
 * repository-contained module graph. The identity builder recursively binds
 * undeclared local dependencies while treating the provider API as a kernel
 * boundary.
 */
export function assertProviderPluginImplementationSourceClosure(
  plugin: ProviderPluginV1,
  snapshots: ProviderPluginImplementationSourceSnapshot =
    snapshotProviderPluginImplementationSources(
      plugin,
      readImplementationSource,
      new Map(),
    ),
  moduleAnalyses: ProviderModuleAnalysisCache = {
    values: new Map(),
    imports: 0,
  },
): void {
  const pluginEntry = plugin.implementationSources.find(
    (source) => source.label === "plugin.ts",
  );
  if (pluginEntry === undefined) {
    throw new Error(`provider plugin ${plugin.id} has no plugin.ts implementation source`);
  }
  for (const source of plugin.implementationSources) {
    if (!providerPluginModuleExtensions.has(extname(source.path))) continue;
    const sourceBytes = implementationSourceBytes(plugin, source, snapshots);
    const analysis = analyzeProviderModule(
      sourceBytes,
      source.path,
      moduleAnalyses,
    );
    if (analysis.nonLiteralModuleLoad) {
      throw new Error(
        `provider plugin ${plugin.id} implementation source ${source.label} contains a non-literal module load`,
      );
    }
    for (const dependency of analysis.imports) {
      const specifier = dependency.path;
      if (!specifier.startsWith(".")) {
        if (isRuntimeBuiltin(specifier)) continue;
        if (
          specifier.startsWith("/")
          || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)
        ) {
          throw new Error(
            `provider plugin ${plugin.id} implementation source ${source.label} imports unsupported absolute or URL dependency ${specifier}`,
          );
        }
        // Resolve now so a missing package or a package outside the checked
        // repository cannot hide behind a lazy runtime import.
        resolvedBareDependency(source.path, specifier, dependency.kind);
        continue;
      }
      const candidate = resolveLocalImport(
        source.path,
        specifier,
        dependency.kind,
      );
      if (candidate === undefined) {
        throw new Error(
          `provider plugin ${plugin.id} implementation source ${source.label} imports unresolved local value dependency ${specifier}`,
        );
      }
      if (!isWithin(repositoryRoot, candidate)) {
        throw new Error(
          `provider plugin ${plugin.id} implementation source ${source.label} imports local dependency outside the repository`,
        );
      }
    }
  }
}

function createProviderPluginRegistryInternal(
  definitions: readonly (ProviderPluginDefinitionV1 | ProviderPluginV1)[],
  dependencies: ProviderPluginRegistryDependencies,
  allowPortableProjections: boolean,
): ProviderPluginRegistry {
  if (definitions.length > MAX_REGISTRY_SOURCE_PLUGINS) {
    throw new Error("provider plugin registry exceeds its plugin bound");
  }
  const plugins = definitions.map((definition) => {
    const firstBinding = definition.bindings[0];
    if (firstBinding === undefined) {
      throw new Error(`provider plugin ${definition.id} must own at least one binding`);
    }
    if ("runtime" in firstBinding) {
      return defineProviderPlugin(definition as ProviderPluginDefinitionV1);
    }
    if (!isValidatedProviderPlugin(definition)) {
      throw new Error(`provider plugin ${definition.id} is not a validated definition`);
    }
    if (
      definition.sourceKind === "portable"
      && !allowPortableProjections
    ) {
      throw new Error(
        `portable provider plugin ${definition.id} requires the kernel-owned catalog extension boundary`,
      );
    }
    return definition;
  });
  plugins.sort((left, right) => compareIdentityText(left.id, right.id));
  for (let index = 1; index < plugins.length; index += 1) {
    if (plugins[index - 1]?.id === plugins[index]?.id) {
      throw new Error(`duplicate provider plugin ID: ${plugins[index]?.id}`);
    }
  }
  let registryRouteCount = 0;
  let registryOperationContractCount = 0;
  for (const plugin of plugins) {
    if (plugin.bindings.length > MAX_PROVIDER_PLUGIN_BINDINGS) {
      throw new Error(
        `provider plugin ${plugin.id} exceeds its binding bound`,
      );
    }
    let pluginOperationCount = 0;
    for (const binding of plugin.bindings) {
      if (
        binding.operations.length
          > MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING
      ) {
        throw new Error(
          `provider plugin ${plugin.id} surface ${binding.surfaceId} exceeds its operation bound`,
        );
      }
      pluginOperationCount += binding.operations.length;
      for (const operation of binding.operations) {
        registryOperationContractCount += operation.contractVersions.length;
        if (
          registryOperationContractCount
            > MAX_PROVIDER_PLUGIN_REGISTRY_OPERATION_CONTRACTS
        ) {
          throw new Error(
            "provider plugin registry exceeds its exact operation contract bound",
          );
        }
      }
    }
    if (pluginOperationCount > MAX_PROVIDER_PLUGIN_OPERATIONS) {
      throw new Error(
        `provider plugin ${plugin.id} exceeds its aggregate operation bound`,
      );
    }
    registryRouteCount += plugin.bindings.length;
    if (registryRouteCount > MAX_PROVIDER_PLUGIN_REGISTRY_ROUTES) {
      throw new Error("provider plugin registry exceeds its route bound");
    }
  }

  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const routes = new Map<string, ProviderPluginBindingV1>();
  const sessionRoutes = new Map<string, ProviderPluginBindingV1>();
  const operations = new Map<string, ProviderPluginOperationResolutionV1>();
  const ownerByBinding = new Map<ProviderPluginBindingV1, ProviderPluginV1>();
  const implementationSourceSnapshots =
    new Map<ProviderPluginV1, ProviderPluginImplementationSourceSnapshot>();
  const packageDependencySnapshots =
    new Map<ProviderPluginV1, ProviderPluginPackageDependencySnapshot>();
  const registryInstalledPackageSnapshots =
    new Map<string, InstalledPackageSnapshot>();
  const registryModuleAnalyses: ProviderModuleAnalysisCache = {
    values: new Map(),
    imports: 0,
  };
  const readSource =
    dependencies.readImplementationSource ?? readImplementationSource;
  const readDependencySource =
    dependencies.readDependencySource
    ?? readDependencySourceFromDisk;
  const registryRepositorySourceSnapshots = new Map<string, Buffer>();
  const registryRepositorySourceReaders = new Map<string, {
    readonly label: string;
    readonly read: () => Buffer;
  }>();
  const snapshotRepositorySource = (
    path: string,
    label: string,
    read: () => Buffer,
  ): Buffer => {
    const existing = registryRepositorySourceSnapshots.get(path);
    if (existing !== undefined) return existing;
    const bytes = Buffer.from(read());
    registryRepositorySourceSnapshots.set(path, bytes);
    registryRepositorySourceReaders.set(path, { label, read });
    return bytes;
  };
  const readCoherentImplementationSource: typeof readImplementationSource = (
    pluginId,
    source,
  ) => snapshotRepositorySource(
    source.path,
    `provider plugin ${pluginId} implementation source ${source.label}`,
    () => readSource(pluginId, source),
  );
  const readCoherentDependencySource = (path: string): Buffer =>
    classifyProviderPluginPhysicalPath(path).kind === "installed-package"
      ? readDependencySource(path)
      : snapshotRepositorySource(
          path,
          `provider plugin repository dependency ${relative(repositoryRoot, path)}`,
          () => readDependencySource(path),
        );
  // Execution configuration is a single semantic closure even when an
  // extended tsconfig lives in node_modules. Capture those exact files in the
  // registry-wide snapshot so the final byte revalidation cannot return a
  // mixed catalog during an install or package update.
  const readCoherentExecutionConfigSource = (path: string): Buffer =>
    snapshotRepositorySource(
      path,
      `provider plugin execution configuration ${relative(repositoryRoot, path)}`,
      () => readDependencySource(path),
    );
  let registryImplementationSourceReads = 0;
  let registryImplementationSourceBytes = 0;
  let registryDependencyRecords = 0;
  let registryDependencyRecordBytes = 0;

  for (const plugin of plugins) {
    if (plugin.sourceKind !== "portable") {
      if (
        plugin.implementationSources.length
          > MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES
      ) {
        throw new Error(
          `provider plugin ${plugin.id} exceeds its implementation source bound`,
        );
      }
      const snapshots = snapshotProviderPluginImplementationSources(
        plugin,
        readCoherentImplementationSource,
        new Map(),
      );
      const evaluationSourceSha256 =
        providerPluginEvaluationSourceSha256(plugin);
      if (evaluationSourceSha256 === undefined) {
        throw new Error(
          `provider plugin ${plugin.id} has no evaluation-time source identity`,
        );
      }
      const evaluationInstalledPackageSha256 =
        providerPluginEvaluationInstalledPackageSha256(plugin);
      if (evaluationInstalledPackageSha256 === undefined) {
        throw new Error(
          `provider plugin ${plugin.id} has no evaluation-time installed package identity`,
        );
      }
      for (const [path, bytes] of snapshots) {
        const evaluated = evaluationSourceSha256.get(path);
        const current = createHash("sha256").update(bytes).digest("hex");
        if (evaluated === undefined || evaluated !== current) {
          throw new Error(
            `provider plugin ${plugin.id} implementation changed after its definition was evaluated`,
          );
        }
      }
      registryImplementationSourceReads += snapshots.size;
      for (const bytes of snapshots.values()) {
        registryImplementationSourceBytes += bytes.byteLength;
      }
      if (
        registryImplementationSourceReads
          > MAX_REGISTRY_IMPLEMENTATION_SOURCE_READS
        || registryImplementationSourceBytes
          > MAX_REGISTRY_IMPLEMENTATION_SOURCE_BYTES
      ) {
        throw new Error(
          "provider plugin registry implementation source closure exceeds its bound",
        );
      }
      implementationSourceSnapshots.set(plugin, snapshots);
      assertProviderPluginImplementationSourceClosure(
        plugin,
        snapshots,
        registryModuleAnalyses,
      );
      const dependencySnapshot = providerPluginPackageDependencyIdentity(
        plugin,
        snapshots,
        readCoherentDependencySource,
        registryInstalledPackageSnapshots,
        registryModuleAnalyses,
        readCoherentExecutionConfigSource,
      );
      // A custom dependency reader is an explicit test-only virtual filesystem
      // seam. Production always compares the evaluation closure to the same
      // inode-bound bytes used for the registry identity.
      if (dependencies.readDependencySource === undefined) {
        for (const [path, evaluated] of evaluationSourceSha256) {
          const bytes = registryRepositorySourceSnapshots.get(path);
          if (
            bytes === undefined
            || createHash("sha256").update(bytes).digest("hex") !== evaluated
          ) {
            throw new Error(
              `provider plugin ${plugin.id} implementation changed after its definition was evaluated`,
            );
          }
        }
        for (
          const [root, evaluated] of evaluationInstalledPackageSha256
        ) {
          const current = registryInstalledPackageSnapshots.get(root);
          if (
            current === undefined
            || current.treeSha256 !== evaluated
          ) {
            throw new Error(
              `provider plugin ${plugin.id} installed dependency changed after its definition was evaluated`,
            );
          }
        }
      }
      registryDependencyRecords += dependencySnapshot.length;
      for (const record of dependencySnapshot) {
        registryDependencyRecordBytes += record.bytes.byteLength;
      }
      if (
        registryDependencyRecords > MAX_REGISTRY_DEPENDENCY_RECORDS
        || registryDependencyRecordBytes
          > MAX_REGISTRY_DEPENDENCY_RECORD_BYTES
      ) {
        throw new Error(
          "provider plugin registry dependency closure exceeds its aggregate bound",
        );
      }
      packageDependencySnapshots.set(plugin, dependencySnapshot);
      assertInstalledPackageRegistryCacheBounds(
        registryInstalledPackageSnapshots,
      );
    }
    for (const binding of plugin.bindings) {
      const key = routeKey(binding.transport, binding.surfaceId);
      const existing = routes.get(key);
      if (existing !== undefined) {
        const existingOwner = ownerByBinding.get(existing);
        throw new Error(
          `duplicate provider plugin route ${key}: ${existingOwner?.id ?? "unknown"} and ${plugin.id}`,
        );
      }
      if (binding.transport !== "provider-api") {
        const existingSession = sessionRoutes.get(binding.surfaceId);
        if (existingSession !== undefined) {
          const existingOwner = ownerByBinding.get(existingSession);
          throw new Error(
            `duplicate provider plugin session route ${binding.surfaceId}: ${existingOwner?.id ?? "unknown"} and ${plugin.id}`,
          );
        }
        sessionRoutes.set(binding.surfaceId, binding);
      }
      routes.set(key, binding);
      ownerByBinding.set(binding, plugin);
      for (const operation of binding.operations) {
        for (const contractVersion of operation.contractVersions) {
          const exactKey = operationKey(
            binding.transport,
            binding.surfaceId,
            operation.name,
            contractVersion,
          );
          if (operations.has(exactKey)) {
            throw new Error(`duplicate provider plugin exact contract ${exactKey}`);
          }
          const portableIdentity = portableProviderPluginOperationIdentity(
            binding,
            operation,
            contractVersion,
          );
          if (
            (plugin.sourceKind === "portable") !== (portableIdentity !== null)
          ) {
            throw new Error(
              `provider plugin ${plugin.id} portable operation identity is inconsistent`,
            );
          }
          operations.set(exactKey, Object.freeze({
            plugin,
            binding,
            operation,
            contractVersion,
            portableIdentity,
          }));
        }
      }
    }
  }

  for (
    const [path, snapshot] of [...registryRepositorySourceSnapshots.entries()]
      .sort(([left], [right]) => compareIdentityText(left, right))
  ) {
    const reader = registryRepositorySourceReaders.get(path);
    if (reader === undefined) {
      throw new Error(
        `provider plugin registry source ${relative(repositoryRoot, path)} has no revalidation reader`,
      );
    }
    const current = Buffer.from(reader.read());
    if (
      current.byteLength !== snapshot.byteLength
      || !timingSafeEqual(current, snapshot)
    ) {
      throw new Error(`${reader.label} changed before registry startup completed`);
    }
  }

  for (const snapshot of registryInstalledPackageSnapshots.values()) {
    if (
      !sameInstalledPackageTree(
        snapshot.verificationWalk,
        walkInstalledPackageTree(snapshot.root),
      )
    ) {
      throw new Error(
        `installed package ${snapshot.id} changed before registry startup completed`,
      );
    }
  }

  const implementationHashes = new Map<ProviderPluginV1, Buffer>();
  const implementationClosureHashes = new Map<ProviderPluginV1, string>();
  for (const plugin of plugins) {
    if (plugin.sourceKind === "portable") {
      implementationHashes.set(
        plugin,
        computeProviderPluginImplementationHash(plugin, new Map(), []),
      );
      implementationClosureHashes.set(
        plugin,
        computeProviderPluginClosureHash(plugin, new Map(), []),
      );
      continue;
    }
    const sourceSnapshots = implementationSourceSnapshots.get(plugin);
    const dependencySnapshots = packageDependencySnapshots.get(plugin);
    if (sourceSnapshots === undefined || dependencySnapshots === undefined) {
      throw new Error(
        `provider plugin ${plugin.id} implementation snapshot is incomplete`,
      );
    }
    const expected = computeProviderPluginImplementationHash(
      plugin,
      sourceSnapshots,
      dependencySnapshots,
    );
    implementationHashes.set(plugin, expected);
    const implementationClosureHash = computeProviderPluginClosureHash(
      plugin,
      sourceSnapshots,
      dependencySnapshots,
    );
    implementationClosureHashes.set(plugin, implementationClosureHash);
    const verifyRuntimeIdentity = async (
      phase: ProviderPluginRuntimeLoadIdentityPhase,
    ): Promise<void> => {
      await dependencies.beforeRuntimeLoadIdentityCheck?.(plugin.id, phase);
      // This is a cooperative source-drift boundary, not a same-account
      // hostile-code sandbox. The pre-check prevents ordinary post-startup
      // replacement from loading; the post-check prevents a concurrently
      // changed module from reaching an operation. A writer that races inside
      // the module loader can still trigger top-level module side effects
      // before the post-check rejects, which is why source plugins remain
      // trusted in-process code.
      // These maps are intentionally new for every phase. A registry startup
      // cache must never make a live pre/post import identity check look clean.
      const currentSources = snapshotProviderPluginImplementationSources(
        plugin,
        readImplementationSource,
        new Map(),
      );
      assertProviderPluginImplementationSourceClosure(
        plugin,
        currentSources,
      );
      const currentDependencies = providerPluginPackageDependencyIdentity(
        plugin,
        currentSources,
        readDependencySourceFromDisk,
      );
      const current = computeProviderPluginImplementationHash(
        plugin,
        currentSources,
        currentDependencies,
      );
      if (
        current.byteLength !== expected.byteLength
        || !timingSafeEqual(current, expected)
      ) {
        throw new Error(
          `provider plugin ${plugin.id} implementation changed after registry startup; restart before loading its runtime`,
        );
      }
    };
    const token = `${plugin.id}@${plugin.version}:${expected.toString("hex")}`;
    for (const binding of plugin.bindings) {
      bindProviderPluginRuntimeLoadIdentity(
        binding.loadRuntime,
        Object.freeze({
          token,
          verify: verifyRuntimeIdentity,
        }),
      );
    }
  }

  const frozenPlugins = Object.freeze(plugins);
  const implementationHash = (binding: ProviderPluginBindingV1): Buffer => {
    const plugin = ownerByBinding.get(binding);
    if (plugin === undefined) throw new Error("provider plugin binding is not registered");
    const existing = implementationHashes.get(plugin);
    if (existing === undefined) {
      throw new Error(
        `provider plugin ${plugin.id} implementation hash is unavailable`,
      );
    }
    return Buffer.from(existing);
  };
  const contractImplementationHash = (
    binding: ProviderPluginBindingV1,
  ): Buffer => {
    const plugin = ownerByBinding.get(binding);
    if (plugin === undefined) {
      throw new Error("provider plugin binding is not registered");
    }
    if (plugin.sourceKind !== "built-in") return implementationHash(binding);
    return Buffer.from(
      reviewedBuiltInContractIdentity(plugin.id, plugin.version)
        .implementationSha256,
      "hex",
    );
  };
  const legacyContractImplementationHashes = (
    binding: ProviderPluginBindingV1,
    operation: string,
    contractVersion: number,
  ): readonly Buffer[] => {
    const plugin = ownerByBinding.get(binding);
    if (plugin === undefined) {
      throw new Error("provider plugin binding is not registered");
    }
    if (!binding.operations.some((candidate) =>
      candidate.name === operation && candidate.contractVersions.includes(contractVersion)
    )) {
      throw new Error(
        `provider plugin ${plugin.id} does not own operation ${operation}@${contractVersion}`,
      );
    }
    if (plugin.sourceKind !== "built-in") return Object.freeze([]);
    const identity = reviewedBuiltInContractIdentity(plugin.id, plugin.version);
    const legacy = identity.legacyReadImplementationSha256;
    const e71Legacy = identity.legacyE71ReadImplementationSha256;
    const currentLegacy = identity.legacyCurrentReadImplementationSha256;
    const routeLegacy = identity.legacyRouteReadImplementationSha256?.[
      `${operation}@${contractVersion}`
    ] ?? [];
    if (
      legacy === null
      && e71Legacy === null
      && currentLegacy.length === 0
      && routeLegacy.length === 0
    ) {
      return Object.freeze([]);
    }
    if (legacy === null || e71Legacy === null) {
      if (legacy !== null || e71Legacy !== null) {
        throw new Error(
          `built-in provider plugin ${plugin.id}@${plugin.version} has an incomplete legacy contract identity`,
        );
      }
      return Object.freeze([...currentLegacy, ...routeLegacy]
        .map((value) => Buffer.from(value, "hex")));
    }
    return Object.freeze([
      Buffer.from(legacy.test, "hex"),
      Buffer.from(legacy.production, "hex"),
      Buffer.from(legacy.development, "hex"),
      Buffer.from(e71Legacy.default, "hex"),
      Buffer.from(e71Legacy.test, "hex"),
      Buffer.from(e71Legacy.production, "hex"),
      Buffer.from(e71Legacy.development, "hex"),
      ...currentLegacy.map((value) => Buffer.from(value, "hex")),
      ...routeLegacy.map((value) => Buffer.from(value, "hex")),
    ]);
  };
  const implementationClosureHash = (
    binding: ProviderPluginBindingV1,
  ): string => {
    const plugin = ownerByBinding.get(binding);
    if (plugin === undefined) {
      throw new Error("provider plugin binding is not registered");
    }
    const hash = implementationClosureHashes.get(plugin);
    if (hash === undefined) {
      throw new Error(
        `provider plugin ${plugin.id} reviewed implementation closure is unavailable`,
      );
    }
    return hash;
  };
  const artifactSha256 = (
    binding: ProviderPluginBindingV1,
  ): string | null => {
    const plugin = ownerByBinding.get(binding);
    if (plugin === undefined) {
      throw new Error("provider plugin binding is not registered");
    }
    return portableProviderPluginArtifactSha256(plugin);
  };
  const ownedManifests = new Map<string, WrenchManifest>();
  for (const plugin of plugins) {
    for (const binding of plugin.bindings) {
      const portable = portableProviderPluginAdapter(binding);
      if (portable === null) continue;
      if (ownedManifests.has(portable.adapterId)) {
        throw new Error(
          `duplicate portable provider plugin adapter ID: ${portable.adapterId}`,
        );
      }
      ownedManifests.set(portable.adapterId, portable.manifest);
    }
  }
  const frozenOwnedManifests = Object.freeze(
    [...ownedManifests.values()].sort((left, right) =>
      compareIdentityText(left.id, right.id)),
  );

  const resolveRoute = (
    transport: ProviderPluginTransport,
    surfaceId: string,
  ): ProviderPluginBindingV1 | undefined => routes.get(routeKey(transport, surfaceId));
  const requireRoute = (
    transport: ProviderPluginTransport,
    surfaceId: string,
  ): ProviderPluginBindingV1 => {
    const binding = resolveRoute(transport, surfaceId);
    if (binding === undefined) throw new Error(`provider plugin route ${routeKey(transport, surfaceId)} is not installed`);
    return binding;
  };
  const resolveSessionRoute = (surfaceId: string): ProviderPluginBindingV1 | undefined =>
    sessionRoutes.get(surfaceId);
  const requireSessionRoute = (surfaceId: string): ProviderPluginBindingV1 => {
    const binding = resolveSessionRoute(surfaceId);
    if (binding === undefined) throw new Error(`provider plugin session route ${surfaceId} is not installed`);
    return binding;
  };
  const resolveOperation = (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ): ProviderPluginBindingV1 | undefined =>
    operations.get(operationKey(transport, surfaceId, operation, contractVersion))?.binding;
  const requireOperation = (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ): ProviderPluginBindingV1 => {
    const binding = resolveOperation(transport, surfaceId, operation, contractVersion);
    if (binding === undefined) {
      throw new Error(
        `provider plugin operation ${operationKey(transport, surfaceId, operation, contractVersion)} is not installed`,
      );
    }
    return binding;
  };
  const resolveOperationDefinition = (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ): ProviderPluginOperationResolutionV1 | undefined =>
    operations.get(operationKey(transport, surfaceId, operation, contractVersion));
  const requireOperationDefinition = (
    transport: ProviderPluginTransport,
    surfaceId: string,
    operation: string,
    contractVersion: number,
  ): ProviderPluginOperationResolutionV1 => {
    const resolution = resolveOperationDefinition(
      transport,
      surfaceId,
      operation,
      contractVersion,
    );
    if (resolution === undefined) {
      throw new Error(
        `provider plugin operation ${operationKey(transport, surfaceId, operation, contractVersion)} is not installed`,
      );
    }
    return resolution;
  };

  return Object.freeze({
    list: () => frozenPlugins,
    get: (pluginId: string) => pluginsById.get(pluginId),
    resolveRoute,
    requireRoute,
    resolveSessionRoute,
    requireSessionRoute,
    resolveOperation,
    requireOperation,
    resolveOperationDefinition,
    requireOperationDefinition,
    implementationHash,
    contractImplementationHash,
    legacyContractImplementationHashes,
    implementationClosureHash,
    artifactSha256,
    listOwnedManifests: () => frozenOwnedManifests,
    resolveOwnedManifest: (adapterId) => ownedManifests.get(adapterId),
  });
}

/** Build a registry from reviewed built-in/source definitions only. */
export function createProviderPluginRegistry(
  definitions: readonly (ProviderPluginDefinitionV1 | ProviderPluginV1)[],
  dependencies: ProviderPluginRegistryDependencies = {},
): ProviderPluginRegistry {
  return createProviderPluginRegistryInternal(
    definitions,
    dependencies,
    false,
  );
}

/**
 * Extend one already validated source registry with kernel-authorized portable
 * projections. Generic source-registry construction never admits portable
 * objects, so a source plugin cannot masquerade as installed child-host code.
 */
export function extendProviderPluginRegistryWithPortablePlugins(
  sourceRegistry: ProviderPluginRegistry,
  portablePlugins: readonly ProviderPluginV1[],
): ProviderPluginRegistry {
  const sourcePlugins = sourceRegistry.list();
  if (sourcePlugins.some((plugin) => plugin.sourceKind === "portable")) {
    throw new Error(
      "portable provider plugin catalog extension requires a source-only registry",
    );
  }
  if (portablePlugins.some((plugin) => plugin.sourceKind !== "portable")) {
    throw new Error(
      "portable provider plugin catalog extension accepts only portable projections",
    );
  }
  return createProviderPluginRegistryInternal(
    [...sourcePlugins, ...portablePlugins],
    {},
    true,
  );
}
