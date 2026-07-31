import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { providerPluginRepositoryRoot } from "../src/provider-plugin";

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
  "@hraness/kb":
    "github:hraness/kb#a4989df0e81d504651dbb20c3a4ef36c8846d0cb",
  "buffer-from": "1.1.2",
  "source-map": "0.6.1",
  "source-map-support": "0.5.21",
  typescript: "6.0.3",
});

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
): Promise<CommandResult> {
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
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
): Promise<CommandResult> {
  return runCommand(
    `${target.label} ${label}`,
    [process.execPath, target.cliPath, ...arguments_],
    target.cwd,
    expectedExitCodes,
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

function requireJsonObject(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
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
  if (capture.schemaVersion !== 1) {
    throw new Error(`${label}.capture.schemaVersion is not 1`);
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
  const doctor = await runCli(target, "doctor", ["doctor", "--json"], [0, 3]);
  assertDoctorSchema(`${target.label} doctor`, doctor.stdout);

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
    const installedSourceMapSupportRoot = resolveInstalledDependencyRoot(
      "source-map-support",
      installedPackageRoot,
    );
    await Promise.all([
      assertInstalledClosurePackage({
        keyFile: "dist/index-1fa66nh9.js",
        name: "@hraness/kb",
        root: installedKbRoot,
        sha256:
          "a6ae0af7add039e07af47da3ce24d4a5fdc4bc184398a57d4ec955e8d4c7fc97",
        version: "0.10.0",
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
        root: resolveInstalledDependencyRoot("typescript", installedPackageRoot),
        sha256:
          "569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39",
        version: "6.0.3",
      }),
    ]);
    await exerciseCli({
      cliPath: join(consumer, "node_modules", ".bin", "wrench"),
      cwd: consumer,
      label: "packed",
    }, "packed");
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
