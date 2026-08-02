import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@hraness/wrench";
const importSpecifiers = ["@hraness/wrench","@hraness/wrench/client","@hraness/wrench/omni"];
const binNames = ["wrench"];
const verificationPackages = ["@steipete/sweet-cookie@https://codeload.github.com/hraness/sweet-cookie/tar.gz/112dce1a3c3dd165310616ca63dd2f6cc652b212","@types/bun@^1.3.14","fast-check@^4.8.0"];

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

const repository = process.cwd();
const work = await mkdtemp(join(tmpdir(), "hraness-package-smoke-"));
try {
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
  await run(["node", "--input-type=module", "-e", `await import(${JSON.stringify(packageName)})`], consumer);
  for (const binName of binNames) {
    await run([join(consumer, "node_modules", ".bin", binName), "--help"], consumer);
  }
  if (verificationPackages.length > 0) {
    await run([process.execPath, "add", ...verificationPackages, "--ignore-scripts"], consumer);
  }
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
