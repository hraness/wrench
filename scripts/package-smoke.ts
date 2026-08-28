import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const packageName = "@hraness/wrench";
const importSpecifiers = [
  "@hraness/wrench",
  "@hraness/wrench/client",
  "@hraness/wrench/beeper",
  "@hraness/wrench/omni",
  "@hraness/wrench/messaging",
];
const binNames = ["wrench"];
const MAX_PACKED_BYTES = 2_000_000;
const MAX_PACKED_FILES = 425;
const MAX_UNPACKED_BYTES = 11_000_000;
const NPM_REGISTRY = "https://registry.npmjs.org";
const sweetCookieVerificationUrl = "https://codeload.github.com/hraness/sweet-cookie/tar.gz/refs/tags/v0.4.2";
const sweetCookieVerificationIntegrity = "sha512-HddZketABRWbHiLYqMbGlYuqEaWdtqAjES28eKHr2cPDdPvrXiF4JQxD4pl9WzSOre6p/B3zA4Z3uIsCHo/+uQ==";
const verificationPackages = [`@steipete/sweet-cookie@${sweetCookieVerificationUrl}`,"@types/bun@^1.3.14","fast-check@^4.8.0"];
const inertRootImportProgram = `
  import fs from "node:fs";
  import fsPromises from "node:fs/promises";
  import http from "node:http";
  import https from "node:https";
  import net from "node:net";
  import dns from "node:dns";
  import { syncBuiltinESMExports } from "node:module";
  const forbidden = (name) => () => { throw new Error("package root import attempted " + name); };
  const loaderOnly = (name, implementation) => function (...args) {
    const stack = new Error().stack ?? "";
    const immediateCaller = stack.split("\\n")[2] ?? "";
    if (
      !immediateCaller.includes("node:internal/modules/")
      && !immediateCaller.includes("(node:fs:")
    ) {
      throw new Error("package root import attempted filesystem access via " + name);
    }
    return Reflect.apply(implementation, fs, args);
  };
  for (const name of ["accessSync", "existsSync", "lstatSync", "openSync", "readFileSync", "realpathSync", "statSync"]) {
    Object.defineProperty(fs, name, {
      configurable: true,
      value: loaderOnly(name, fs[name]),
    });
  }
  for (const name of ["access", "lstat", "open", "readFile", "realpath", "stat"]) {
    Object.defineProperty(fsPromises, name, {
      configurable: true,
      value: forbidden("filesystem access via promises." + name),
    });
  }
  Object.defineProperty(http, "request", { configurable: true, value: forbidden("HTTP access") });
  Object.defineProperty(http, "get", { configurable: true, value: forbidden("HTTP access") });
  Object.defineProperty(https, "request", { configurable: true, value: forbidden("HTTPS access") });
  Object.defineProperty(https, "get", { configurable: true, value: forbidden("HTTPS access") });
  Object.defineProperty(net, "connect", { configurable: true, value: forbidden("network access") });
  Object.defineProperty(net, "createConnection", { configurable: true, value: forbidden("network access") });
  Object.defineProperty(dns, "lookup", { configurable: true, value: forbidden("DNS access") });
  globalThis.fetch = forbidden("fetch access");
  syncBuiltinESMExports();
  for (const probe of [
    () => fs.readFileSync(process.execPath),
    () => http.request("http://127.0.0.1"),
  ]) {
    let blocked = false;
    try {
      probe();
    } catch (error) {
      blocked = error instanceof Error
        && error.message.startsWith("package root import attempted");
      if (!blocked) throw error;
    }
    if (!blocked) throw new Error("package root inertness guard is ineffective");
  }
  await import(${JSON.stringify(packageName)});
`;

async function assertSweetCookieLock(lockPath: string, label: string): Promise<void> {
  const record = (await Bun.file(lockPath).text())
    .split(/\r?\n/u)
    .find((line) => line.includes(`@steipete/sweet-cookie@${sweetCookieVerificationUrl}`));
  if (record === undefined || !record.includes(sweetCookieVerificationIntegrity)) {
    throw new Error(`${label} does not bind the immutable Sweet Cookie v0.4.2 codeload integrity`);
  }
}

async function run(
  command: string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Promise<void> {
  const process = Bun.spawn(command, env === undefined
    ? { cwd, stdout: "inherit", stderr: "inherit" }
    : {
        cwd,
        env: { ...globalThis.process.env, ...env },
        stdout: "inherit",
        stderr: "inherit",
      });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

type ExactNpmArtifact = Readonly<{
  archive: string;
  packJson: string;
}>;

type PackageMeasure = Readonly<{
  fileCount: number;
  packedBytes: number;
  unpackedBytes: number;
}>;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return field;
}

function requireNonNegativeInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): number {
  const field = value[key];
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    throw new Error(`${label}.${key} must be a non-negative safe integer.`);
  }
  return field as number;
}

function parseExactNpmArtifact(args: readonly string[], repository: string): ExactNpmArtifact | null {
  if (args.length === 0) return null;
  if (args.length !== 4) {
    throw new Error(
      "Usage: bun run scripts/package-smoke.ts [--archive <package.tgz> --pack-json <npm-pack.json>]",
    );
  }

  let archive: string | null = null;
  let packJson: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.length === 0) {
      throw new Error(`Missing value for ${flag ?? "package-smoke argument"}.`);
    }
    if (flag === "--archive" && archive === null) archive = value;
    else if (flag === "--pack-json" && packJson === null) packJson = value;
    else throw new Error(`Unknown or duplicate package-smoke argument: ${flag ?? "missing"}.`);
  }
  if (archive === null || packJson === null) {
    throw new Error("Exact npm artifact verification requires --archive and --pack-json together.");
  }
  return Object.freeze({
    archive: isAbsolute(archive) ? archive : resolve(repository, archive),
    packJson: isAbsolute(packJson) ? packJson : resolve(repository, packJson),
  });
}

function verifyPackageBounds(measure: PackageMeasure): void {
  if (measure.packedBytes > MAX_PACKED_BYTES) {
    throw new Error(
      `Packed Wrench archive is ${String(measure.packedBytes)} bytes; limit is ${String(MAX_PACKED_BYTES)}.`,
    );
  }
  if (measure.fileCount > MAX_PACKED_FILES) {
    throw new Error(
      `Packed Wrench has ${String(measure.fileCount)} files; limit is ${String(MAX_PACKED_FILES)}.`,
    );
  }
  if (measure.unpackedBytes > MAX_UNPACKED_BYTES) {
    throw new Error(
      `Packed Wrench is ${String(measure.unpackedBytes)} unpacked bytes; limit is ${String(MAX_UNPACKED_BYTES)}.`,
    );
  }
}

async function verifyExactNpmPackResult(
  artifact: ExactNpmArtifact,
  expectedVersion: string,
): Promise<PackageMeasure> {
  const parsed: unknown = JSON.parse(await readFile(artifact.packJson, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm-pack.json must contain exactly one package result.");
  }
  const result = requireRecord(parsed[0], "npm pack result");
  const name = requireString(result, "name", "npm pack result");
  const version = requireString(result, "version", "npm pack result");
  const filename = requireString(result, "filename", "npm pack result");
  const integrity = requireString(result, "integrity", "npm pack result");
  const shasum = requireString(result, "shasum", "npm pack result");
  if (name !== packageName || version !== expectedVersion) {
    throw new Error(
      `npm pack reported ${name}@${version}, expected ${packageName}@${expectedVersion}.`,
    );
  }
  const expectedFilename = `hraness-wrench-${expectedVersion}.tgz`;
  if (
    filename !== basename(filename)
    || filename !== basename(artifact.archive)
    || filename !== expectedFilename
  ) {
    throw new Error(`npm pack returned unsafe or unexpected filename ${filename}.`);
  }

  const measure = Object.freeze({
    fileCount: requireNonNegativeInteger(result, "entryCount", "npm pack result"),
    packedBytes: requireNonNegativeInteger(result, "size", "npm pack result"),
    unpackedBytes: requireNonNegativeInteger(result, "unpackedSize", "npm pack result"),
  });
  const files = result.files;
  if (!Array.isArray(files) || files.length !== measure.fileCount) {
    throw new Error("npm pack file inventory does not match entryCount.");
  }
  const seen = new Set<string>();
  let reportedUnpackedBytes = 0;
  for (const [index, value] of files.entries()) {
    const file = requireRecord(value, `npm pack result.files[${String(index)}]`);
    const path = requireString(file, "path", `npm pack result.files[${String(index)}]`);
    const size = requireNonNegativeInteger(file, "size", `npm pack result.files[${String(index)}]`);
    if (seen.has(path)) throw new Error(`npm pack reported duplicate package path ${path}.`);
    seen.add(path);
    reportedUnpackedBytes += size;
    if (!Number.isSafeInteger(reportedUnpackedBytes)) {
      throw new Error("npm pack file inventory exceeds the safe integer range.");
    }
  }
  if (reportedUnpackedBytes !== measure.unpackedBytes) {
    throw new Error("npm pack file inventory does not match unpackedSize.");
  }

  const bytes = await readFile(artifact.archive);
  if (bytes.byteLength !== measure.packedBytes) {
    throw new Error("Exact npm tarball byte length does not match npm-pack.json.");
  }
  const actualIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const actualShasum = createHash("sha1").update(bytes).digest("hex");
  if (integrity !== actualIntegrity || shasum !== actualShasum) {
    throw new Error("Exact npm tarball digest does not match npm-pack.json.");
  }
  verifyPackageBounds(measure);
  return measure;
}

async function runExpectingFailure(
  command: string[],
  cwd: string,
  expectedExitCode: number,
  expectedDiagnostic: string,
): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (
    exitCode !== expectedExitCode
    || stdout.length !== 0
    || !stderr.includes(expectedDiagnostic)
  ) {
    throw new Error(
      `Installed CLI failure contract drifted for: ${command.join(" ")}; exit=${String(exitCode)}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
    );
  }
}

async function collectMarkdownFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

async function measurePackageFiles(root: string): Promise<Readonly<{
  fileCount: number;
  unpackedBytes: number;
}>> {
  let fileCount = 0;
  let unpackedBytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await measurePackageFiles(path);
      fileCount += nested.fileCount;
      unpackedBytes += nested.unpackedBytes;
    } else if (entry.isFile()) {
      fileCount += 1;
      unpackedBytes += (await stat(path)).size;
    } else {
      throw new Error(`Packed Wrench contains an unsupported entry: ${path}`);
    }
  }
  return { fileCount, unpackedBytes };
}

async function collectArchivedAdapterFiles(
  root: string,
  prefix = "",
): Promise<readonly string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectArchivedAdapterFiles(root, relativePath));
    } else if (
      entry.isFile()
      && /^wrench(?:-web)?-adapter\.v[0-9]+\.[0-9]+\.[0-9]+\.json$/u.test(entry.name)
    ) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function verifyPackedArchivedAdapterInventory(
  repository: string,
  packageRoot: string,
): Promise<void> {
  const sourceRoot = join(repository, "src", "assets", "adapters");
  const packedRoot = join(packageRoot, "src", "assets", "adapters");
  const expected = await collectArchivedAdapterFiles(sourceRoot);
  const actual = await collectArchivedAdapterFiles(packedRoot);
  if (
    expected.length !== actual.length
    || expected.some((path, index) => path !== actual[index])
  ) {
    throw new Error(
      `Packed archived adapter inventory differs from source (expected ${expected.join(", ")}; got ${actual.join(", ")}).`,
    );
  }
  const requiredSubstackBaseline = join(
    "substack",
    "wrench-web-adapter.v1.1.0.json",
  );
  if (!actual.includes(requiredSubstackBaseline)) {
    throw new Error("Packed Wrench omitted the Substack 1.1.0 upgrade baseline.");
  }
  for (const relativePath of expected) {
    const sourceBytes = await readFile(join(sourceRoot, relativePath));
    const packedBytes = await readFile(join(packedRoot, relativePath));
    if (!Buffer.from(sourceBytes).equals(Buffer.from(packedBytes))) {
      throw new Error(`Packed archived adapter bytes drifted: ${relativePath}`);
    }
  }
}

async function verifyLocalMarkdownLinks(skillRoot: string): Promise<void> {
  for (const markdownPath of await collectMarkdownFiles(skillRoot)) {
    const markdown = await readFile(markdownPath, "utf8");
    for (const match of markdown.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
      const targetText = match[1];
      if (targetText === undefined || /^[a-z][a-z0-9+.-]*:/iu.test(targetText)) continue;
      const target = resolve(dirname(markdownPath), targetText);
      const skillRelative = relative(skillRoot, target);
      if (skillRelative.startsWith("..") || isAbsolute(skillRelative)) {
        throw new Error(`Packed Wrench skill link escapes its bundle: ${targetText}`);
      }
      await access(target);
    }
  }
}

async function verifyPackagedSkill(
  repository: string,
  consumer: string,
  expectedVersion: string,
): Promise<void> {
  const packageRoot = join(consumer, "node_modules", "@hraness", "wrench");
  const skillRoot = join(packageRoot, "skills", "wrench");
  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const metadata = await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly contentPolicy?: unknown;
    readonly engines?: unknown;
    readonly publishConfig?: unknown;
  };

  if (!skill.startsWith("---\nname: wrench\ndescription:")) {
    throw new Error("Packed Wrench skill is missing valid discovery metadata.");
  }
  if (!metadata.includes("$wrench")) {
    throw new Error("Packed Wrench skill metadata must invoke $wrench explicitly.");
  }

  const publicSkills = (await readdir(join(packageRoot, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (publicSkills.length !== 1 || publicSkills[0] !== "wrench") {
    throw new Error(`Packed Wrench package must expose only skills/wrench; found ${publicSkills.join(", ")}.`);
  }

  const references = [...skill.matchAll(/\]\((references\/[^)#]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1])
    .filter((path): path is string => path !== undefined);
  if (!references.includes("references/install.md")) {
    throw new Error("Packed Wrench skill must route missing-CLI work to references/install.md.");
  }
  if (!references.includes("references/x-ai-disclosure.md")) {
    throw new Error("Packed Wrench skill must route X AI disclosure to references/x-ai-disclosure.md.");
  }
  const disclosure = await readFile(join(skillRoot, "references", "x-ai-disclosure.md"), "utf8");
  for (const required of [
    "Made with AI",
    "Content disclosure",
    "live permalink",
    "the publish failed",
    "Do not delete or repost unless the user asks",
    "pixels-only",
    "caBX",
    "locked",
  ] as const) {
    if (!disclosure.includes(required)) {
      throw new Error(
        `Packed Wrench skill must fail closed on X AI disclosure; missing ${JSON.stringify(required)}.`,
      );
    }
  }
  for (const reference of references) await access(join(skillRoot, reference));
  await verifyLocalMarkdownLinks(skillRoot);

  if (manifest.name !== packageName || manifest.version !== expectedVersion) {
    throw new Error(
      `Packed Wrench identity is ${String(manifest.name)}@${String(manifest.version)}, expected ${packageName}@${expectedVersion}.`,
    );
  }
  if (
    typeof manifest.contentPolicy !== "object"
    || manifest.contentPolicy === null
    || !("class" in manifest.contentPolicy)
    || manifest.contentPolicy.class !== "dual-use"
  ) {
    throw new Error("Packed Wrench must retain npm dual-use metadata.");
  }
  if (
    typeof manifest.engines !== "object"
    || manifest.engines === null
    || !("bun" in manifest.engines)
    || manifest.engines.bun !== ">=1.3.14"
  ) {
    throw new Error("Packed Wrench must declare its Bun runtime floor.");
  }
  if (
    typeof manifest.publishConfig !== "object"
    || manifest.publishConfig === null
    || !("access" in manifest.publishConfig)
    || manifest.publishConfig.access !== "public"
    || !("registry" in manifest.publishConfig)
    || manifest.publishConfig.registry !== NPM_REGISTRY
  ) {
    throw new Error("Packed Wrench must pin public publication to the canonical npm registry.");
  }
  const npmDisclosure = await readFile(join(packageRoot, "DISCLOSURE"), "utf8");
  for (const required of ["dual-use", "browser profile", "explicit confirmation", "authorized"] as const) {
    if (!npmDisclosure.includes(required)) {
      throw new Error(`Packed Wrench dual-use disclosure is missing ${JSON.stringify(required)}.`);
    }
  }
  const install = await readFile(join(skillRoot, "references", "install.md"), "utf8");
  if (!install.includes(`@hraness/wrench@${expectedVersion}`)) {
    throw new Error("Packed Wrench skill install pin does not match the package version.");
  }
  const readme = await readFile(join(packageRoot, "README.md"), "utf8");
  if (
    readme.includes("not currently published on npm")
    || readme.includes("registries are not supported install paths")
    || !readme.includes(`@hraness/wrench@${expectedVersion}`)
  ) {
    throw new Error("Packed Wrench README does not describe the current npm install path.");
  }

  await verifyPackedArchivedAdapterInventory(repository, packageRoot);
}

const repository = process.cwd();
const sourceManifest = requireRecord(
  JSON.parse(await readFile(join(repository, "package.json"), "utf8")) as unknown,
  "package.json",
);
const packageVersion = requireString(sourceManifest, "version", "package.json");
if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(packageVersion)) {
  throw new Error(`package.json version is not stable semantic version: ${packageVersion}.`);
}
const exactNpmArtifact = parseExactNpmArtifact(process.argv.slice(2), repository);
const work = await mkdtemp(join(tmpdir(), "hraness-package-smoke-"));
try {
  await assertSweetCookieLock(join(repository, "bun.lock"), "repository lock");
  const archive = exactNpmArtifact?.archive ?? join(work, "package.tgz");
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  let exactNpmMeasure: PackageMeasure | null = null;
  if (exactNpmArtifact === null) {
    await run([
      process.execPath,
      "pm",
      "pack",
      "--filename",
      archive,
      "--ignore-scripts",
      "--quiet",
    ], repository);
  } else {
    exactNpmMeasure = await verifyExactNpmPackResult(exactNpmArtifact, packageVersion);
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  if (exactNpmArtifact === null) {
    await run([process.execPath, "add", archive, "--ignore-scripts"], consumer);
  } else {
    await run([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      `--registry=${NPM_REGISTRY}`,
      archive,
    ], consumer, {
      NPM_CONFIG_CACHE: join(work, "npm-cache"),
      NPM_CONFIG_UPDATE_NOTIFIER: "false",
    });
  }
  await verifyPackagedSkill(repository, consumer, packageVersion);
  const packageRoot = join(consumer, "node_modules", "@hraness", "wrench");
  const packageMeasure = await measurePackageFiles(packageRoot);
  const measuredArchive = Object.freeze({
    fileCount: packageMeasure.fileCount,
    packedBytes: (await stat(archive)).size,
    unpackedBytes: packageMeasure.unpackedBytes,
  });
  verifyPackageBounds(measuredArchive);
  if (
    exactNpmMeasure !== null
    && (
      measuredArchive.fileCount !== exactNpmMeasure.fileCount
      || measuredArchive.packedBytes !== exactNpmMeasure.packedBytes
      || measuredArchive.unpackedBytes !== exactNpmMeasure.unpackedBytes
    )
  ) {
    throw new Error("Clean npm install does not match the exact npm pack metrics.");
  }
  await run(["node", "--input-type=module", "-e", inertRootImportProgram], consumer);
  for (const binName of binNames) {
    await run([join(consumer, "node_modules", ".bin", binName), "--help"], consumer);
  }
  await runExpectingFailure([
    join(consumer, "node_modules", ".bin", "wrench"),
    "imessage",
    "transport",
    "install",
    "--binary",
    "relative-imsg",
    "--json",
  ], consumer, 2, "normalized-absolute-reviewed-imsg-file");
  await access(join(
    consumer,
    "node_modules",
    "@hraness",
    "wrench",
    "src",
    "fixtures",
    "beeper-message-like-me-v1",
    "manifest.json",
  ));
  await run([
    process.execPath,
    "-e",
    "await import('./node_modules/@hraness/wrench/src/beeper-message-like-me-cli.ts')",
  ], consumer);
  await runExpectingFailure([
    join(consumer, "node_modules", ".bin", "wrench"),
    "beeper",
    "export-message-like-me",
    "--auth",
    "beeper-main",
    "--output",
    "relative",
  ], consumer, 2, "normalized-absolute-directory");
  if (verificationPackages.length > 0) {
    await run([process.execPath, "add", ...verificationPackages, "--ignore-scripts"], consumer);
  }
  await assertSweetCookieLock(join(consumer, "bun.lock"), "clean consumer lock");
  await run([
    "node",
    "--input-type=module",
    "-e",
    `await Promise.all(${JSON.stringify(importSpecifiers)}.map((specifier) => import(specifier)))`,
  ], consumer);
  await writeFile(join(consumer, "index.ts"), "import * as surface0 from \"@hraness/wrench\";\nimport * as surface1 from \"@hraness/wrench/client\";\nimport * as surface2 from \"@hraness/wrench/omni\";\nimport * as surface3 from \"@hraness/wrench/beeper\";\nimport * as surface4 from \"@hraness/wrench/messaging\";\nvoid [surface0, surface1, surface2, surface3, surface4];\n");
  await writeFile(join(consumer, "tsconfig.bundler.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"Preserve\",\n    \"moduleResolution\": \"Bundler\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);

} finally {
  await rm(work, { recursive: true, force: true });
}
