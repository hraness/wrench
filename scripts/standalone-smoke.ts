import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { providerPluginRepositoryRoot } from "../src/provider-plugin";
import { adapterManifestPath } from "../src/storage";
import { packedPrivateSourceClientRuntimeProgram } from "./private-source-client-runtime-smoke";
import { runWhatsAppMessageLikeMeConsumerAcceptance } from "./whatsapp-message-like-me-consumer-acceptance";

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type InstalledClosurePackage = {
  readonly keyFile: string;
  readonly name: string;
  readonly root: string;
  readonly sha256: string;
  readonly version: string;
};

const expectedClosureRuntimeDependencies = Object.freeze({
  "@hraness/kb": "0.17.1",
  "@hraness/message-like-me": "github:hraness/message-like-me#v0.7.0",
  "buffer-from": "1.1.2",
  "source-map": "0.6.1",
  "source-map-support": "0.5.21",
  typescript: "6.0.3",
});
const reviewedKbDynamicModuleKeyFile = "dist/index-qry4vhxk.js";
const reviewedKbDynamicModuleSha256 =
  "da69a90f9cf1edbfe82443c5f73226fe9960103522e37a106ff4ec04e3325e97";
const archivedAdapterNamePattern =
  /^wrench(?:-web)?-adapter\.v([0-9]+\.[0-9]+\.[0-9]+)\.json$/u;
const MAX_PACKED_ARCHIVED_UPGRADE_FAMILIES = 32;
const PACKED_ARCHIVED_UPGRADE_COMMAND_TIMEOUT_MS = 30_000;

const packageRoot = resolve(import.meta.dir, "..");
const cli = join(packageRoot, "src", "cli.ts");
const work = await mkdtemp(join(tmpdir(), "wrench-standalone-smoke-"));
const home = join(work, "home");
const state = join(work, "state");
const temporary = join(work, "tmp");

await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(state, { recursive: true }),
  mkdir(temporary, { recursive: true }),
]);

const environment: Record<string, string> = {
  HOME: home,
  LANG: "C",
  LC_ALL: "C",
  NO_COLOR: "1",
  PATH: process.env.PATH ?? "",
  TMPDIR: temporary,
  TZ: "UTC",
  WRENCH_MEDIA_HOME: join(state, "media"),
  WRENCH_STATE_HOME: state,
};

const inheritedProcessBudget = process.env.GOMAXPROCS;
if (
  inheritedProcessBudget !== undefined
  && /^[1-9][0-9]*$/u.test(inheritedProcessBudget)
  && Number.isSafeInteger(Number(inheritedProcessBudget))
) {
  environment.GOMAXPROCS = inheritedProcessBudget;
}

for (const name of ["COMSPEC", "PATHEXT", "SystemRoot", "SYSTEMROOT"]) {
  const value = process.env[name];
  if (value !== undefined) environment[name] = value;
}

async function runCommand(
  label: string,
  command: readonly string[],
  cwd: string,
  expectedExitCodes: readonly number[] = [0],
  timeoutMs = 180_000,
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  if (timedOut) {
    throw new Error(`${label} exceeded its ${String(timeoutMs)} ms smoke deadline`);
  }
  if (!expectedExitCodes.includes(exitCode)) {
    throw new Error(
      `${label} failed (${String(exitCode)}): ${stderr.trim() || stdout.trim() || "no output"}`,
    );
  }
  return { exitCode, stdout, stderr };
}

function runCli(
  target: Readonly<{ cliPath: string; cwd: string; label: string }>,
  label: string,
  arguments_: readonly string[],
  expectedExitCodes: readonly number[] = [0],
  timeoutMs = 180_000,
): Promise<CommandResult> {
  return runCommand(
    `${target.label} ${label}`,
    [process.execPath, target.cliPath, ...arguments_],
    target.cwd,
    expectedExitCodes,
    timeoutMs,
  );
}

function parseJsonObject(label: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} did not return one JSON value`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function collectArchivedAdapterFiles(
  root: string,
  prefix = "",
): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectArchivedAdapterFiles(root, relativePath));
    } else if (entry.isFile() && archivedAdapterNamePattern.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function packedArchivedAdapterInventory(
  installedPackageRoot: string,
): Promise<readonly string[]> {
  const sourceRoot = join(packageRoot, "src", "assets", "adapters");
  const packedRoot = join(installedPackageRoot, "src", "assets", "adapters");
  const expected = await collectArchivedAdapterFiles(sourceRoot);
  const actual = await collectArchivedAdapterFiles(packedRoot);
  if (
    expected.length !== actual.length
    || expected.some((path, index) => path !== actual[index])
  ) {
    throw new Error(
      `packed archived adapter inventory differs from source (expected ${expected.join(", ")}; got ${actual.join(", ")})`,
    );
  }
  const requiredSubstackBaseline = join(
    "substack",
    "wrench-web-adapter.v1.1.0.json",
  );
  if (!actual.includes(requiredSubstackBaseline)) {
    throw new Error("packed Wrench omitted the Substack 1.1.0 upgrade baseline");
  }
  for (const relativePath of expected) {
    const sourceBytes = Buffer.from(
      await Bun.file(join(sourceRoot, relativePath)).arrayBuffer(),
    );
    const packedBytes = Buffer.from(
      await Bun.file(join(packedRoot, relativePath)).arrayBuffer(),
    );
    if (!sourceBytes.equals(packedBytes)) {
      throw new Error(`packed archived adapter bytes drifted: ${relativePath}`);
    }
  }
  return expected;
}

async function exercisePackedArchivedAdapterUpgrades(
  target: Readonly<{ cliPath: string; cwd: string; label: string }>,
  installedPackageRoot: string,
): Promise<void> {
  const packedRoot = join(installedPackageRoot, "src", "assets", "adapters");
  const archivedFiles = await packedArchivedAdapterInventory(installedPackageRoot);
  const byCurrentManifest = new Map<string, string[]>();
  for (const relativePath of archivedFiles) {
    const currentRelativePath = relativePath.replace(
      /\.v[0-9]+\.[0-9]+\.[0-9]+\.json$/u,
      ".json",
    );
    const candidates = byCurrentManifest.get(currentRelativePath) ?? [];
    candidates.push(relativePath);
    byCurrentManifest.set(currentRelativePath, candidates);
  }
  const representatives: string[] = [];
  for (const [currentRelativePath, candidates] of [...byCurrentManifest]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const current = requireJsonObject(
      `packed current adapter ${currentRelativePath}`,
      await Bun.file(join(packedRoot, currentRelativePath)).json(),
    );
    const requiredVersion = current.id === "youtube-web" || current.id === "substack-web"
      ? "1.1.0"
      : null;
    const selected = requiredVersion === null
      ? candidates[0]
      : candidates.find((path) =>
          path.endsWith(`.v${requiredVersion}.json`));
    if (selected === undefined) {
      throw new Error(
        `packed archived adapter family ${String(current.id)} omitted required representative ${requiredVersion ?? "baseline"}`,
      );
    }
    representatives.push(selected);
  }
  if (
    representatives.length < 1
    || representatives.length > MAX_PACKED_ARCHIVED_UPGRADE_FAMILIES
  ) {
    throw new Error(
      `packed archived adapter representative count ${String(representatives.length)} exceeded its smoke bound`,
    );
  }
  for (const required of [
    join("youtube", "wrench-web-adapter.v1.1.0.json"),
    join("substack", "wrench-web-adapter.v1.1.0.json"),
  ]) {
    if (!representatives.includes(required)) {
      throw new Error(`packed upgrade representatives omitted ${required}`);
    }
  }
  const upgradeState = join(work, "packed-upgrade-state");
  environment.WRENCH_STATE_HOME = upgradeState;
  environment.WRENCH_MEDIA_HOME = join(upgradeState, "media");
  await mkdir(upgradeState, { recursive: true, mode: 0o700 });
  const expectedUpgrades: Array<Readonly<{
    archivedId: string;
    archivedVersion: string;
    currentVersion: string;
  }>> = [];
  for (const relativePath of representatives) {
    const archivedMatch = archivedAdapterNamePattern.exec(
      relativePath.split(/[\\/]/u).at(-1) ?? "",
    );
    if (archivedMatch === null) {
      throw new Error(`packed archived adapter name changed: ${relativePath}`);
    }
    const currentRelativePath = relativePath.replace(
      /\.v[0-9]+\.[0-9]+\.[0-9]+\.json$/u,
      ".json",
    );
    const archivedBytes = await Bun.file(join(packedRoot, relativePath)).text();
    const archived = requireJsonObject(
      `packed archived adapter ${relativePath}`,
      JSON.parse(archivedBytes) as unknown,
    );
    const current = requireJsonObject(
      `packed current adapter ${currentRelativePath}`,
      await Bun.file(join(packedRoot, currentRelativePath)).json(),
    );
    if (
      typeof archived.id !== "string"
      || archived.id !== current.id
      || archived.version !== archivedMatch[1]
      || typeof current.version !== "string"
    ) {
      throw new Error(`packed archived adapter identity changed: ${relativePath}`);
    }
    const legacyPath = adapterManifestPath(archived.id, environment);
    await mkdir(dirname(legacyPath), { recursive: true, mode: 0o700 });
    await writeFile(legacyPath, archivedBytes, { mode: 0o600 });
    expectedUpgrades.push({
      archivedId: archived.id,
      archivedVersion: archived.version,
      currentVersion: current.version,
    });
  }
  await runCli(
    target,
    "sync representative archived adapter families",
    ["adapter", "sync-bundled", "--json"],
    [0],
    PACKED_ARCHIVED_UPGRADE_COMMAND_TIMEOUT_MS,
  );
  for (const expected of expectedUpgrades) {
    const upgraded = await runCli(
      target,
      `read upgraded adapter ${expected.archivedId}@${expected.archivedVersion}`,
      ["capabilities", expected.archivedId, "--json"],
      [0],
      PACKED_ARCHIVED_UPGRADE_COMMAND_TIMEOUT_MS,
    );
    assertCapabilityAdapterVersion(
      `packed upgraded adapter ${expected.archivedId}@${expected.archivedVersion}`,
      upgraded.stdout,
      expected.archivedId,
      expected.currentVersion,
    );
  }
}

function requireJsonObject(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function resolveReviewedKbDynamicKeyFile(root: string): Promise<string> {
  const manifest = requireJsonObject(
    "clean consumer @hraness/kb manifest",
    await Bun.file(join(root, "package.json")).json(),
  );
  if (manifest.version !== "0.17.1") {
    throw new Error(
      `clean consumer resolved @hraness/kb@${String(manifest.version)}, expected 0.17.1`,
    );
  }
  const candidates: Readonly<{ keyFile: string; sha256: string }>[] = [];
  const dist = join(root, "dist");
  for (
    const entry of (await readdir(dist, { withFileTypes: true }))
      .toSorted((left, right) => left.name.localeCompare(right.name, "en"))
  ) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const keyFile = `dist/${entry.name}`;
    const bytes = Buffer.from(await Bun.file(join(root, keyFile)).arrayBuffer());
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    if (
      source.match(
        /createRequire\(parentUrl\)\.resolve\(`\$\{packageName\}\/package\.json`\)/gu,
      )?.length !== 1
      || source.match(/resolvePackageDirectory\("agent-browser"\)/gu)?.length !== 1
    ) continue;
    candidates.push({
      keyFile,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (candidates.length !== 1) {
    throw new Error(
      `clean consumer @hraness/kb@0.17.1 exposes ${String(candidates.length)} dynamic-resolution modules, expected exactly one`,
    );
  }
  const candidate = candidates[0];
  if (
    candidate === undefined
    || candidate.keyFile !== reviewedKbDynamicModuleKeyFile
    || candidate.sha256 !== reviewedKbDynamicModuleSha256
  ) {
    throw new Error(
      `clean consumer @hraness/kb@0.17.1 dynamic-resolution module ${candidate?.keyFile ?? "missing"} has sha256 ${candidate?.sha256 ?? "missing"}, expected ${reviewedKbDynamicModuleKeyFile} with sha256 ${reviewedKbDynamicModuleSha256}`,
    );
  }
  return candidate.keyFile;
}

function requireKeys(
  label: string,
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
): void {
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing required keys: ${missing.join(", ")}`,
    );
  }
}

function assertCapabilityAdapterVersion(
  label: string,
  text: string,
  adapterId: string,
  expectedVersion: string,
): void {
  const response = parseJsonObject(label, text);
  if (!Array.isArray(response.adapters) || response.adapters.length !== 1) {
    throw new Error(`${label} did not return one exact adapter`);
  }
  const adapter = requireJsonObject(`${label}.adapters[0]`, response.adapters[0]);
  if (adapter.id !== adapterId || adapter.version !== expectedVersion) {
    throw new Error(
      `${label} returned ${String(adapter.id)}@${String(adapter.version)}, expected ${adapterId}@${expectedVersion}`,
    );
  }
}

function resolveInstalledDependencyRoot(
  dependencyName: string,
  fromPackageRoot: string,
): string {
  const dependencyPath = dependencyName.split("/");
  let directory = fromPackageRoot;
  while (true) {
    const candidate = join(directory, "node_modules", ...dependencyPath);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(
    `clean consumer cannot resolve closure package ${dependencyName} from ${fromPackageRoot}`,
  );
}

async function assertInstalledClosurePackage(
  expected: InstalledClosurePackage,
): Promise<void> {
  const manifest = requireJsonObject(
    `clean consumer ${expected.name} manifest`,
    await Bun.file(join(expected.root, "package.json")).json(),
  );
  if (manifest.version !== expected.version) {
    throw new Error(
      `clean consumer resolved closure package ${expected.name}@${String(manifest.version)}, expected ${expected.version}`,
    );
  }
  const bytes = Buffer.from(
    await Bun.file(join(expected.root, expected.keyFile)).arrayBuffer(),
  );
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expected.sha256) {
    throw new Error(
      `clean consumer closure package ${expected.name}@${expected.version} ${expected.keyFile} has sha256 ${actualSha256}, expected ${expected.sha256}`,
    );
  }
}

function assertDoctorSchema(label: string, text: string): void {
  const report = parseJsonObject(label, text);
  requireKeys(label, report, ["capture", "media", "oh", "ok", "wrench"]);
  if (typeof report.ok !== "boolean") {
    throw new Error(`${label}.ok is not a boolean`);
  }

  const capture = requireJsonObject(`${label}.capture`, report.capture);
  requireKeys(`${label}.capture`, capture, [
    "dependencies",
    "schemaVersion",
    "warnings",
  ]);
  if (capture.schemaVersion !== 2) {
    throw new Error(`${label}.capture.schemaVersion is not 2`);
  }

  const media = requireJsonObject(`${label}.media`, report.media);
  requireKeys(`${label}.media`, media, [
    "checks",
    "errors",
    "ok",
  ]);

  const wrench = requireJsonObject(`${label}.wrench`, report.wrench);
  requireKeys(`${label}.wrench`, wrench, [
    "home",
    "mediaArchiveReady",
    "mutationPolicy",
    "portablePlugins",
  ]);
  const predecessor = requireJsonObject(`${label}.oh`, report.oh);
  if (!isDeepStrictEqual(predecessor, wrench)) {
    throw new Error(`${label}.oh diverged from the canonical wrench envelope`);
  }
}

async function exerciseCli(
  target: Readonly<{ cliPath: string; cwd: string; label: string }>,
  artifactLabel: string,
): Promise<void> {
  const urlMetadataHelp = await runCli(
    target,
    "url-metadata help",
    ["url-metadata", "--help"],
  );
  if (
    urlMetadataHelp.stderr !== ""
    || !urlMetadataHelp.stdout.includes("kb url-metadata")
    || !urlMetadataHelp.stdout.includes("metadata-search-engine-rs")
  ) {
    throw new Error(`${target.label} url-metadata help is malformed`);
  }

  const doctor = await runCli(target, "doctor", ["doctor", "--json"], [0, 3]);
  assertDoctorSchema(`${target.label} doctor`, doctor.stdout);

  const adapterSync = await runCli(
    target,
    "adapter sync-bundled",
    ["adapter", "sync-bundled", "--json"],
  );
  const adapterSyncResult = parseJsonObject(
    `${target.label} adapter sync-bundled`,
    adapterSync.stdout,
  );
  requireKeys(`${target.label} adapter sync-bundled`, adapterSyncResult, [
    "commitId",
    "installed",
    "ok",
    "preserved",
  ]);
  if (adapterSyncResult.ok !== true) {
    throw new Error(`${target.label} adapter sync-bundled did not succeed`);
  }

  const capabilities = await runCli(target, "capabilities", ["capabilities", "--json"]);
  parseJsonObject(`${target.label} capabilities`, capabilities.stdout);

  const plugins = await runCli(target, "plugin list", ["plugin", "list", "--json"]);
  parseJsonObject(`${target.label} plugin list`, plugins.stdout);

  const authoringDirectory = join(work, `${artifactLabel}-example-web`);
  const packageDirectory = join(work, `${artifactLabel}-example-web.wrenchplugin`);
  const init = await runCli(target, "plugin init", [
    "plugin",
    "init",
    "example-web",
    "--display-name",
    "Example",
    "--surface",
    "example",
    "--origin",
    "https://www.example.com",
    "--operation",
    "feeds.read",
    "--output",
    authoringDirectory,
    "--json",
  ]);
  parseJsonObject(`${target.label} plugin init`, init.stdout);

  const check = await runCli(target, "plugin check", [
    "plugin",
    "check",
    authoringDirectory,
    "--json",
  ]);
  parseJsonObject(`${target.label} plugin check`, check.stdout);

  const test = await runCli(target, "plugin test", [
    "plugin",
    "test",
    authoringDirectory,
    "--trust-code",
    "--json",
  ]);
  parseJsonObject(`${target.label} plugin test`, test.stdout);

  const pack = await runCli(target, "plugin pack", [
    "plugin",
    "pack",
    authoringDirectory,
    "--output",
    packageDirectory,
    "--json",
  ]);
  parseJsonObject(`${target.label} plugin pack`, pack.stdout);

  const packedCheck = await runCli(target, "packed plugin check", [
    "plugin",
    "check",
    packageDirectory,
    "--json",
  ]);
  parseJsonObject(`${target.label} packed plugin check`, packedCheck.stdout);
}

function isPublicArtifact(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "name" in value
    && value.name === "@hraness/wrench"
    && (!("private" in value) || value.private === false);
}

try {
  await runWhatsAppMessageLikeMeConsumerAcceptance();
  await exerciseCli({
    cliPath: cli,
    cwd: providerPluginRepositoryRoot,
    label: "source",
  }, "source");

  const manifest: unknown = await Bun.file(join(packageRoot, "package.json")).json();
  if (isPublicArtifact(manifest)) {
    const archive = join(work, "wrench.tgz");
    const consumer = join(work, "consumer");
    await mkdir(consumer, { recursive: true });
    await runCommand("pack public package", [
      process.execPath,
      "pm",
      "pack",
      "--filename",
      archive,
      "--ignore-scripts",
      "--quiet",
    ], packageRoot);
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    if (existsSync(join(consumer, "bun.lock"))) {
      throw new Error("clean consumer unexpectedly has a lockfile before install");
    }
    await runCommand(
      "install packed public package without its repository lock",
      [process.execPath, "add", archive, "--ignore-scripts"],
      consumer,
    );
    const installedPackageRoot = join(
      consumer,
      "node_modules",
      "@hraness",
      "wrench",
    );
    if (existsSync(join(installedPackageRoot, "bun.lock"))) {
      throw new Error("packed Wrench unexpectedly contains its repository lock");
    }
    const installedManifest = requireJsonObject(
      "packed Wrench manifest",
      await Bun.file(join(installedPackageRoot, "package.json")).json(),
    );
    const installedDependencies = requireJsonObject(
      "packed Wrench runtime dependencies",
      installedManifest.dependencies,
    );
    const installedDependencyNames = Object.keys(installedDependencies).sort();
    const expectedDependencyNames = Object.keys(
      expectedClosureRuntimeDependencies,
    ).sort();
    if (!isDeepStrictEqual(installedDependencyNames, expectedDependencyNames)) {
      throw new Error(
        `packed Wrench runtime dependency names differ from the reviewed closure: ${JSON.stringify(installedDependencyNames)}`,
      );
    }
    for (
      const [name, spec] of Object.entries(
        expectedClosureRuntimeDependencies,
      )
    ) {
      if (installedDependencies[name] !== spec) {
        throw new Error(
          `packed Wrench must project closure dependency ${name}@${spec}, got ${String(installedDependencies[name])}`,
        );
      }
    }
    const installedKbRoot = resolveInstalledDependencyRoot(
      "@hraness/kb",
      installedPackageRoot,
    );
    const installedMessageLikeMeRoot = resolveInstalledDependencyRoot(
      "@hraness/message-like-me",
      installedPackageRoot,
    );
    const installedSourceMapSupportRoot = resolveInstalledDependencyRoot(
      "source-map-support",
      installedPackageRoot,
    );
    const installedTypeScriptRoot = resolveInstalledDependencyRoot(
      "typescript",
      installedPackageRoot,
    );
    const installedKbDynamicKeyFile = await resolveReviewedKbDynamicKeyFile(
      installedKbRoot,
    );
    await Promise.all([
      assertInstalledClosurePackage({
        keyFile: installedKbDynamicKeyFile,
        name: "@hraness/kb",
        root: installedKbRoot,
        sha256: reviewedKbDynamicModuleSha256,
        version: "0.17.1",
      }),
      assertInstalledClosurePackage({
        keyFile: "dist/message-bundle-v1.js",
        name: "@hraness/message-like-me",
        root: installedMessageLikeMeRoot,
        sha256:
          "b4dbac79a20b83d72656fd363b8e9a651da1fb3e9a51d72a79cae3c30eafe93a",
        version: "0.7.0",
      }),
      assertInstalledClosurePackage({
        keyFile: "dist/message-bundle-v2.js",
        name: "@hraness/message-like-me",
        root: installedMessageLikeMeRoot,
        sha256:
          "aeab7249da34df33c4620b27b105fafdd19e9bfe74c92317ae61bf4d0291da21",
        version: "0.7.0",
      }),
      assertInstalledClosurePackage({
        keyFile: "index.js",
        name: "buffer-from",
        root: resolveInstalledDependencyRoot(
          "buffer-from",
          installedSourceMapSupportRoot,
        ),
        sha256:
          "2c069ba678c6db9acd475bcc8c5be20eb5077ea26c67514dea9429bc1ad4ff2f",
        version: "1.1.2",
      }),
      assertInstalledClosurePackage({
        keyFile: "source-map.js",
        name: "source-map",
        root: resolveInstalledDependencyRoot(
          "source-map",
          installedSourceMapSupportRoot,
        ),
        sha256:
          "dc098456c2d9ab90a4c0a17cca9be16665b9813df20906553a98b0088a157be7",
        version: "0.6.1",
      }),
      assertInstalledClosurePackage({
        keyFile: "source-map-support.js",
        name: "source-map-support",
        root: installedSourceMapSupportRoot,
        sha256:
          "da6f90928140ff29ca0b72f4bf8299deb986ba45f055fc5eb51d50dea2e5364d",
        version: "0.5.21",
      }),
      assertInstalledClosurePackage({
        keyFile: "lib/typescript.js",
        name: "typescript",
        root: installedTypeScriptRoot,
        sha256:
          "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39",
        version: "6.0.3",
      }),
    ]);
    await runCommand(
      "import packed KB URL intelligence",
      [
        process.execPath,
        "-e",
        "import { ARCHIVE_TODAY_HOSTS, normalizeSourceUrlIdentity } from '@hraness/kb/url-intelligence'; if (!Array.isArray(ARCHIVE_TODAY_HOSTS) || ARCHIVE_TODAY_HOSTS.length === 0 || normalizeSourceUrlIdentity('https://example.com') !== 'https://example.com/') process.exit(1);",
      ],
      consumer,
    );
    await runCommand(
      "import packed read client",
      [
        process.execPath,
        "-e",
        "import { invokeCapability, invokeCapabilitySync, readCachedCapability, revalidateCapability, staleWhileRevalidateCapability } from '@hraness/wrench/client'; if (![invokeCapability, invokeCapabilitySync, readCachedCapability, revalidateCapability, staleWhileRevalidateCapability].every((value) => typeof value === 'function')) process.exit(1);",
      ],
      consumer,
    );
    await runCommand(
      "import packed body-free Beeper client",
      [
        process.execPath,
        "-e",
        "import { exportBeeperContactInteractionsSync, parseBeeperContactInteractionExportResult } from '@hraness/wrench/beeper'; if (![exportBeeperContactInteractionsSync, parseBeeperContactInteractionExportResult].every((value) => typeof value === 'function')) process.exit(1);",
      ],
      consumer,
    );
    await runCommand(
      "import packed Apple Photos contact-evidence client",
      [
        process.execPath,
        "-e",
        "import { exportApplePhotosContactEvidenceSync, parseApplePhotosContactEvidenceExportResult } from '@hraness/wrench/apple-photos'; if (![exportApplePhotosContactEvidenceSync, parseApplePhotosContactEvidenceExportResult].every((value) => typeof value === 'function')) process.exit(1);",
      ],
      consumer,
    );
    await runCommand(
      "import packed WhatsApp Message Like Me client",
      [
        process.execPath,
        "-e",
        "import { exportWhatsAppMessageLikeMeSync, parseWhatsAppMessageLikeMeExportReceipt } from '@hraness/wrench/whatsapp'; if (![exportWhatsAppMessageLikeMeSync, parseWhatsAppMessageLikeMeExportReceipt].every((value) => typeof value === 'function')) process.exit(1);",
      ],
      consumer,
    );
    await runCommand(
      "exercise packed private-source client runtime contracts",
      [process.execPath, "--eval", packedPrivateSourceClientRuntimeProgram],
      consumer,
    );
    await runCommand(
      "import packed omni client",
      [
        process.execPath,
        "-e",
        "import { readCachedOmniView, revalidateOmniView, staleWhileRevalidateOmniView } from '@hraness/wrench/omni'; if (![readCachedOmniView, revalidateOmniView, staleWhileRevalidateOmniView].every((value) => typeof value === 'function')) process.exit(1);",
      ],
      consumer,
    );
    await writeFile(
      join(consumer, "client-typecheck.ts"),
      [
        "import {",
        "  readCachedCapability,",
        "  invokeCapability,",
        "  invokeCapabilitySync,",
        "  revalidateCapability,",
        "  staleWhileRevalidateCapability,",
        "  type CapabilityReadRequest,",
        "  type ReadProjectionCacheResult,",
        "  type RevalidatedCapability,",
        "  type WrenchClientInvocationResult,",
        "  type WrenchClientReadFailure,",
        "} from '@hraness/wrench/client';",
        "const request: CapabilityReadRequest = { adapterId: 'x', operationId: 'messaging.list' };",
        "const cachedReader: (request: CapabilityReadRequest) => ReadProjectionCacheResult = readCachedCapability;",
        "const revalidator: (request: CapabilityReadRequest) => Promise<RevalidatedCapability> = revalidateCapability;",
        "function consumeInvocation(result: WrenchClientInvocationResult): void {",
        "  if (result.status === 'failed') {",
        "    const failure: WrenchClientReadFailure = result.readFailure;",
        "    const output: null = result.output;",
        "    const receiptStatus: 'failed' = result.receipt.status;",
        "    void [failure, output, receiptStatus];",
        "    return;",
        "  }",
        "  const output: unknown = result.output;",
        "  const readFailure: undefined = result.readFailure;",
        "  const receiptStatus: 'succeeded' = result.receipt.status;",
        "  void [output, readFailure, receiptStatus];",
        "}",
        "consumeInvocation(invokeCapabilitySync(request));",
        "void invokeCapability(request).then(consumeInvocation);",
        "void [request, cachedReader, revalidator, staleWhileRevalidateCapability];",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(consumer, "beeper-typecheck.ts"),
      [
        "import {",
        "  exportBeeperContactInteractionsSync,",
        "  parseBeeperContactInteractionExportResult,",
        "  type BeeperContactInteractionExportResult,",
        "} from '@hraness/wrench/beeper';",
        "const result: BeeperContactInteractionExportResult | undefined = undefined;",
        "void [result, exportBeeperContactInteractionsSync, parseBeeperContactInteractionExportResult];",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(consumer, "apple-photos-typecheck.ts"),
      [
        "import {",
        "  exportApplePhotosContactEvidenceSync,",
        "  parseApplePhotosContactEvidenceExportResult,",
        "  type ApplePhotosContactEvidenceExportResult,",
        "} from '@hraness/wrench/apple-photos';",
        "const result: ApplePhotosContactEvidenceExportResult | undefined = undefined;",
        "void [result, exportApplePhotosContactEvidenceSync, parseApplePhotosContactEvidenceExportResult];",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(consumer, "whatsapp-typecheck.ts"),
      [
        "import {",
        "  exportWhatsAppMessageLikeMeSync,",
        "  parseWhatsAppMessageLikeMeExportReceipt,",
        "  type WhatsAppMessageLikeMeExportReceipt,",
        "} from '@hraness/wrench/whatsapp';",
        "const result: WhatsAppMessageLikeMeExportReceipt | undefined = undefined;",
        "void [result, exportWhatsAppMessageLikeMeSync, parseWhatsAppMessageLikeMeExportReceipt];",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(consumer, "omni-typecheck.ts"),
      [
        "import {",
        "  readCachedOmniView,",
        "  revalidateOmniView,",
        "  staleWhileRevalidateOmniView,",
        "  type OmniViewCacheResult,",
        "  type OmniViewRequest,",
        "  type RevalidatedOmniView,",
        "} from '@hraness/wrench/omni';",
        "const request: OmniViewRequest = {",
        "  schemaVersion: 1,",
        "  sources: [{",
        "    adapterId: 'reddit-web',",
        "    operationId: 'messaging.list',",
        "    authId: 'reddit-main',",
        "    input: { folder: 'inbox', limit: 25 },",
        "  }],",
        "};",
        "const cachedReader: (request: OmniViewRequest) => OmniViewCacheResult = readCachedOmniView;",
        "const revalidator: (request: OmniViewRequest) => Promise<RevalidatedOmniView> = revalidateOmniView;",
        "const swr = staleWhileRevalidateOmniView(request);",
        "void [request, cachedReader, revalidator, swr.cached, swr.revalidation];",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(consumer, "tsconfig.client.json"),
      `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM"],
          module: "Preserve",
          moduleResolution: "Bundler",
          moduleDetection: "force",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: [],
        },
        include: [
          "client-typecheck.ts",
          "beeper-typecheck.ts",
          "apple-photos-typecheck.ts",
          "whatsapp-typecheck.ts",
          "omni-typecheck.ts",
        ],
      }, null, 2)}\n`,
    );
    await runCommand(
      "typecheck packed read client without Bun ambient types",
      [
        process.execPath,
        join(installedTypeScriptRoot, "bin", "tsc"),
        "-p",
        "tsconfig.client.json",
      ],
      consumer,
    );
    const packedCli = {
      cliPath: join(consumer, "node_modules", ".bin", "wrench"),
      cwd: consumer,
      label: "packed",
    } as const;
    await exercisePackedArchivedAdapterUpgrades(packedCli, installedPackageRoot);
    const packedState = join(work, "packed-state");
    environment.WRENCH_STATE_HOME = packedState;
    environment.WRENCH_MEDIA_HOME = join(packedState, "media");
    await mkdir(packedState, { recursive: true, mode: 0o700 });
    await runCli(packedCli, "install isolated omni adapter", [
      "adapter",
      "install",
      join(
        installedPackageRoot,
        "src",
        "assets",
        "adapters",
        "reddit",
        "wrench-web-adapter.json",
      ),
    ]);
    await runCli(packedCli, "create isolated omni auth locator", [
      "auth",
      "add",
      "reddit-main",
      "--cookie-source",
      "chrome",
      "--subject",
      "reddit:t2_account",
    ]);
    await runCommand(
      "read deterministic empty omni cache through packed SDK",
      [
        process.execPath,
        "-e",
        [
          "import { readCachedOmniView } from '@hraness/wrench/omni';",
          "const result = readCachedOmniView({ schemaVersion: 1, sources: [{ adapterId: 'reddit-web', operationId: 'messaging.list', authId: 'reddit-main', input: { folder: 'inbox', limit: 25 } }] });",
          "if (result.schemaVersion !== 1 || result.source !== 'omni-cache') throw new Error('packed omni cache result envelope is malformed');",
          "if (!/^[a-f0-9]{64}$/.test(result.identity.invocationDigest) || !/^[a-f0-9]{64}$/.test(result.identity.requestDigest) || !/^[a-f0-9]{64}$/.test(result.identity.sourceSetDigest)) throw new Error('packed omni cache identity is malformed');",
          "if (result.view.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(result.view.viewRevision)) throw new Error('packed omni cache view identity is malformed');",
          "if (result.view.entities.length !== 0 || result.view.nextCursor !== null) throw new Error('packed omni cache was not empty');",
          "if (result.view.sources.length !== 1) throw new Error('packed omni cache omitted its requested source');",
          "const source = result.view.sources[0];",
          "if (source.adapterId !== 'reddit-web' || source.operationId !== 'messaging.list' || source.authId !== 'reddit-main' || source.surfaceId !== 'reddit') throw new Error('packed omni cache source identity is malformed');",
          "if (source.exact.state !== 'miss' || source.normalization.state !== 'missing') throw new Error('packed omni empty-cache states are malformed');",
        ].join(" "),
      ],
      consumer,
    );
    await exerciseCli(packedCli, "packed");
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
