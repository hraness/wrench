import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const packageName = "@hraness/wrench";
const importSpecifiers = ["@hraness/wrench","@hraness/wrench/client","@hraness/wrench/omni"];
const binNames = ["wrench"];
const sweetCookieVerificationUrl = "https://codeload.github.com/hraness/sweet-cookie/tar.gz/refs/tags/v0.4.2";
const sweetCookieVerificationIntegrity = "sha512-HddZketABRWbHiLYqMbGlYuqEaWdtqAjES28eKHr2cPDdPvrXiF4JQxD4pl9WzSOre6p/B3zA4Z3uIsCHo/+uQ==";
const verificationPackages = [`@steipete/sweet-cookie@${sweetCookieVerificationUrl}`,"@types/bun@^1.3.14","fast-check@^4.8.0"];

async function assertSweetCookieLock(lockPath: string, label: string): Promise<void> {
  const record = (await Bun.file(lockPath).text())
    .split(/\r?\n/u)
    .find((line) => line.includes(`@steipete/sweet-cookie@${sweetCookieVerificationUrl}`));
  if (record === undefined || !record.includes(sweetCookieVerificationIntegrity)) {
    throw new Error(`${label} does not bind the immutable Sweet Cookie v0.4.2 codeload integrity`);
  }
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
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
    throw new Error(`Installed CLI failure contract drifted for: ${command.join(" ")}`);
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

async function verifyPackagedSkill(consumer: string): Promise<void> {
  const packageRoot = join(consumer, "node_modules", "@hraness", "wrench");
  const skillRoot = join(packageRoot, "skills", "wrench");
  const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const metadata = await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
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
  ] as const) {
    if (!disclosure.includes(required)) {
      throw new Error(
        `Packed Wrench skill must fail closed on X AI disclosure; missing ${JSON.stringify(required)}.`,
      );
    }
  }
  for (const reference of references) await access(join(skillRoot, reference));
  await verifyLocalMarkdownLinks(skillRoot);

  if (typeof manifest.version !== "string") {
    throw new Error("Packed Wrench package version is missing.");
  }
  const install = await readFile(join(skillRoot, "references", "install.md"), "utf8");
  if (!install.includes(`github:hraness/wrench#v${manifest.version}`)) {
    throw new Error("Packed Wrench skill install pin does not match the package version.");
  }
}

const repository = process.cwd();
const work = await mkdtemp(join(tmpdir(), "hraness-package-smoke-"));
try {
  await assertSweetCookieLock(join(repository, "bun.lock"), "repository lock");
  const archive = join(work, "package.tgz");
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await run([
    process.execPath,
    "pm",
    "pack",
    "--filename",
    archive,
    "--ignore-scripts",
    "--quiet",
  ], repository);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run([process.execPath, "add", archive, "--ignore-scripts"], consumer);
  await verifyPackagedSkill(consumer);
  await run(["node", "--input-type=module", "-e", `await import(${JSON.stringify(packageName)})`], consumer);
  for (const binName of binNames) {
    await run([join(consumer, "node_modules", ".bin", binName), "--help"], consumer);
  }
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
  await writeFile(join(consumer, "index.ts"), "import * as surface0 from \"@hraness/wrench\";\nimport * as surface1 from \"@hraness/wrench/client\";\nimport * as surface2 from \"@hraness/wrench/omni\";\nvoid [surface0, surface1, surface2];\n");
  await writeFile(join(consumer, "tsconfig.bundler.json"), "{\n  \"compilerOptions\": {\n    \"target\": \"ES2023\",\n    \"lib\": [\n      \"ES2023\",\n      \"DOM\",\n      \"DOM.Iterable\"\n    ],\n    \"types\": [\n      \"bun\",\n      \"node\"\n    ],\n    \"strict\": true,\n    \"noEmit\": true,\n    \"skipLibCheck\": false,\n    \"module\": \"Preserve\",\n    \"moduleResolution\": \"Bundler\"\n  },\n  \"include\": [\n    \"index.ts\"\n  ]\n}");
  await run([process.execPath, "x", "tsc", "-p", "./tsconfig.bundler.json"], consumer);

} finally {
  await rm(work, { recursive: true, force: true });
}
