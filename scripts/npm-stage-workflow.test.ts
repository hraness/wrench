import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  inspectPackageArtifact,
  type PackageArtifactInventory,
} from "./package-artifact.js";
import { verifyNpmPackageIdentity } from "./npm-package-identity.js";

const stageWorkflowUrl = new URL("../.github/workflows/npm-stage.yml", import.meta.url);
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const manifestUrl = new URL("../package.json", import.meta.url);
const packageSmokeUrl = new URL("./package-smoke.ts", import.meta.url);
const packageArtifactUrl = new URL("./package-artifact.ts", import.meta.url);
const packageIdentityUrl = new URL("./npm-package-identity.ts", import.meta.url);
const publishingGuideUrl = new URL("../docs/publishing.md", import.meta.url);
const agentGuideUrl = new URL("../AGENTS.md", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const npmRegistry = "https://registry.npmjs.org";
const repository = fileURLToPath(new URL("../", import.meta.url));

function workflowStepScript(workflow: string, name: string): string {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = workflow.indexOf(stepMarker);
  if (stepStart < 0) throw new Error(`Workflow step not found: ${name}`);
  const runMarker = "        run: |\n";
  const runStart = workflow.indexOf(runMarker, stepStart);
  if (runStart < 0) throw new Error(`Workflow step has no run script: ${name}`);
  const lines = workflow.slice(runStart + runMarker.length).split("\n");
  const script: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

async function runWorkflowScript(
  script: string,
  environment: Readonly<Record<string, string>>,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn(["/bin/bash", "-c", script], {
    cwd: repository,
    env: { ...process.env, ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return Object.freeze({ exitCode, stderr, stdout });
}

async function run(command: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn([...command], { cwd, stderr: "inherit", stdout: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}`);
}

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function packJson(
  bytes: Uint8Array,
  inventory: PackageArtifactInventory,
  name: string,
  version: string,
  reverseFiles = false,
): string {
  const files = reverseFiles ? [...inventory.files].reverse() : inventory.files;
  return `${JSON.stringify([{
    bundled: [],
    entryCount: inventory.fileCount,
    filename: `hraness-wrench-${version}.tgz`,
    files: files.map((file) => ({
      mode: file.mode,
      path: file.path,
      size: file.size,
    })),
    id: `${name}@${version}`,
    integrity: integrity(bytes),
    name,
    shasum: sha1(bytes),
    size: bytes.byteLength,
    unpackedSize: inventory.unpackedBytes,
    version,
  }], null, 2)}\n`;
}

function registryView(
  bytes: Uint8Array,
  inventory: PackageArtifactInventory,
  name: string,
  version: string,
): string {
  return `${JSON.stringify({
    dist: {
      fileCount: inventory.fileCount,
      integrity: integrity(bytes),
      shasum: sha1(bytes),
      tarball: `${npmRegistry}/${name}/-/wrench-${version}.tgz`,
      unpackedSize: inventory.unpackedBytes,
    },
    name,
    version,
  }, null, 2)}\n`;
}

function readTarOctal(tar: Buffer, offset: number): number {
  const value = tar.subarray(offset, offset + 12).toString("ascii").replace(/\0.*$/u, "").trim();
  return Number.parseInt(value, 8);
}

function firstRegularHeader(tar: Buffer): Readonly<{ offset: number; size: number }> {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readTarOctal(tar, offset + 124);
    const type = tar[offset + 156] ?? 0;
    if ((type === 0 || type === 48) && size > 0) return Object.freeze({ offset, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Test package contains no non-empty regular file");
}

function writeHeaderChecksum(tar: Buffer, offset: number): void {
  tar.fill(32, offset + 148, offset + 156);
  let checksum = 0;
  for (let index = offset; index < offset + 512; index += 1) checksum += tar[index] ?? 0;
  const field = `${checksum.toString(8).padStart(6, "0")}\0 `;
  tar.write(field, offset + 148, 8, "ascii");
}

function npmCommands(markdown: string): readonly string[] {
  const lines = markdown.split(/\r?\n/u);
  const commands: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.startsWith("npm ")) continue;
    const parts = [line];
    while (parts.at(-1)?.endsWith("\\")) {
      index += 1;
      const continuation = lines[index];
      if (continuation === undefined) throw new Error("Incomplete npm command in publishing guide.");
      parts.push(continuation);
    }
    commands.push(parts.join("\n"));
  }
  return commands;
}

describe("npm publication contract", () => {
  test("pins the public package to the canonical registry", async () => {
    const value: unknown = JSON.parse(await readFile(manifestUrl, "utf8"));
    expect(typeof value).toBe("object");
    expect(value).not.toBeNull();
    const manifest = value as { readonly publishConfig?: unknown };
    expect(manifest.publishConfig).toEqual({
      access: "public",
      registry: npmRegistry,
    });
  });

  test("separates read-only verification from tokenless terminal staging", async () => {
    const workflow = await readFile(stageWorkflowUrl, "utf8");
    const verifyStart = workflow.indexOf("\n  verify:\n");
    const stageStart = workflow.indexOf("\n  stage:\n");

    expect(verifyStart).toBeGreaterThan(-1);
    expect(stageStart).toBeGreaterThan(verifyStart);

    const verifyJob = workflow.slice(verifyStart, stageStart);
    const stageJob = workflow.slice(stageStart);

    for (const required of [
      "workflow_dispatch:",
      "contents: read",
    ] as const) {
      expect(workflow).toContain(required);
    }

    for (const required of [
      "name: Verify exact package",
      "permissions:\n      contents: read",
      "runs-on: ubuntu-latest",
      "source_sha: ${{ steps.identity.outputs.source_sha }}",
      "artifact_name: ${{ steps.pack.outputs.artifact_name }}",
      "tarball_name: ${{ steps.pack.outputs.tarball_name }}",
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "bun-version: \"1.3.14\"",
      "node-version: \"24\"",
      "package-manager-cache: false",
      "npm@11.19.0",
      "github.event.repository.default_branch",
      "refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH",
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run check",
      "git status --porcelain --untracked-files=all -- dist bun.lock",
      "npm pack \\",
      "--pack-destination \"$artifact_directory\"",
      "--archive \"$tarball\"",
      "--pack-json \"$pack_json\"",
      "sha256sum \"$tarball\"",
      'artifact_name="npm-package-$version-$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"',
      "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f",
      "name: ${{ steps.pack.outputs.artifact_name }}",
      "path: ${{ runner.temp }}/wrench-npm-package",
      "if-no-files-found: error",
    ] as const) {
      expect(verifyJob).toContain(required);
    }

    expect(verifyJob).not.toContain("id-token: write");
    expect(verifyJob).not.toContain("npm stage publish");
    expect(verifyJob.match(/git fetch --no-tags origin/gu) ?? []).toHaveLength(1);
    expect(verifyJob.match(/npm view /gu) ?? []).toHaveLength(2);

    for (const required of [
      "name: Stage exact package",
      "needs: verify",
      "permissions:\n      id-token: write",
      "timeout-minutes: 10",
      "node-version: \"24\"",
      "package-manager-cache: false",
      "npm@11.19.0",
      "name: Bind verified artifact identity",
      "EXPECTED_ARTIFACT_NAME: ${{ needs.verify.outputs.artifact_name }}",
      "EXPECTED_SOURCE_SHA: ${{ needs.verify.outputs.source_sha }}",
      "EXPECTED_TARBALL_NAME: ${{ needs.verify.outputs.tarball_name }}",
      "EXPECTED_VERSION: ${{ needs.verify.outputs.package_version }}",
      '[[ ! "$EXPECTED_VERSION" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]',
      '[[ ! "$EXPECTED_SOURCE_SHA" =~ ^[a-f0-9]{40}$ || "$EXPECTED_SOURCE_SHA" != "$GITHUB_SHA" ]]',
      '[[ ! "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ || ! "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]',
      'tarball_name="hraness-wrench-$EXPECTED_VERSION.tgz"',
      '"$EXPECTED_TARBALL_NAME" != "$tarball_name"',
      'artifact_name="npm-package-$EXPECTED_VERSION-$EXPECTED_SOURCE_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"',
      '"$EXPECTED_ARTIFACT_NAME" != "$artifact_name"',
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
      "name: ${{ steps.package_identity.outputs.artifact_name }}",
      "path: ${{ runner.temp }}/wrench-npm-package",
      "EXPECTED_TARBALL_NAME: ${{ steps.package_identity.outputs.tarball_name }}",
      "EXPECTED_VERSION: ${{ steps.package_identity.outputs.version }}",
      'pack_json="$artifact_directory/npm-pack.json"',
      'sha256_file="$artifact_directory/npm-package.sha256"',
      'tarball="$artifact_directory/$EXPECTED_TARBALL_NAME"',
      'find "$artifact_directory" -mindepth 1 -maxdepth 1 -print0 | sort -z',
      "[[ ${#artifact_entries[@]} -ne 3 ]]",
      "must contain exactly the tarball, npm-pack.json, and npm-package.sha256",
      '[[ ! -f "$required_file" || -L "$required_file" ]]',
      "contains an unsafe or unexpected entry",
      "npm-pack.json must contain exactly one package",
      'record?.name !== "@hraness/wrench"',
      "record?.version !== process.env.EXPECTED_VERSION",
      "record?.filename !== process.env.EXPECTED_TARBALL_NAME",
      '["entryCount", "size", "unpackedSize"]',
      "record.files.length !== record.entryCount",
      "bytes.byteLength !== record.size",
      'crypto.createHash("sha512")',
      'crypto.createHash("sha1")',
      "record.integrity !== integrity || record.shasum !== shasum",
      "Downloaded npm-package.sha256 is invalid",
      "Downloaded tarball does not match the verified SHA-256",
      "sha256=%s\\ntarball=%s\\n",
      "EXPECTED_SOURCE_SHA: ${{ steps.package_identity.outputs.source_sha }}",
      "EXPECTED_TARBALL_SHA256: ${{ steps.artifact.outputs.sha256 }}",
      "TARBALL: ${{ steps.artifact.outputs.tarball }}",
      'git init --quiet "$current_main"',
      '"https://github.com/$GITHUB_REPOSITORY.git"',
      'default_head="$(git -C "$current_main" rev-parse FETCH_HEAD)"',
      '"$GITHUB_SHA" != "$EXPECTED_SOURCE_SHA"',
      'current_tarball_sha256="$(sha256sum "$TARBALL"',
      '"$current_tarball_sha256" != "$EXPECTED_TARBALL_SHA256"',
      "npm stage publish \"$TARBALL\"",
      "--access public",
      "--ignore-scripts",
      "--provenance",
    ] as const) {
      expect(stageJob).toContain(required);
    }

    expect(workflow.match(/id-token: write/gu) ?? []).toHaveLength(1);
    expect(stageJob).not.toContain("actions/checkout@");
    expect(stageJob).not.toContain("contents: read");
    expect(stageJob).not.toContain("setup-bun@");
    expect(stageJob).not.toMatch(/\bbun\b/u);
    expect(stageJob).not.toContain("./scripts/");
    expect(stageJob.match(/git -C "\$current_main" fetch/gu) ?? []).toHaveLength(1);
    expect(stageJob.match(/npm stage publish/gu) ?? []).toHaveLength(1);

    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toMatch(/\n\s+push:/u);
    expect(workflow).not.toMatch(/\bnpm publish\b/u);
    const registryFlags = workflow.match(/--registry=[^\s"']+/gu) ?? [];
    expect(registryFlags).toHaveLength(6);
    expect(new Set(registryFlags)).toEqual(new Set([`--registry=${npmRegistry}`]));
    expect(
      workflow.match(
        new RegExp(`registry-url: "${npmRegistry.replaceAll(".", "\\.")}"`, "gu"),
      ) ?? [],
    ).toHaveLength(2);
    expect(
      verifyJob.match(
        new RegExp(`--registry=${npmRegistry.replaceAll(".", "\\.")}`, "gu"),
      ) ?? [],
    ).toHaveLength(4);
    expect(
      stageJob.match(
        new RegExp(`--registry=${npmRegistry.replaceAll(".", "\\.")}`, "gu"),
      ) ?? [],
    ).toHaveLength(2);

    const downloadIndex = stageJob.indexOf("actions/download-artifact@");
    const firstHashIndex = stageJob.indexOf('actual_sha256="$(sha256sum "$tarball"');
    const fetchIndex = stageJob.indexOf('git -C "$current_main" fetch');
    const fetchedHeadIndex = stageJob.indexOf("rev-parse FETCH_HEAD");
    const secondHashIndex = stageJob.indexOf('current_tarball_sha256="$(sha256sum "$TARBALL"');
    const stageIndex = stageJob.indexOf('npm stage publish "$TARBALL"');
    expect(firstHashIndex).toBeGreaterThan(downloadIndex);
    expect(fetchIndex).toBeGreaterThan(firstHashIndex);
    expect(fetchedHeadIndex).toBeGreaterThan(fetchIndex);
    expect(secondHashIndex).toBeGreaterThan(fetchedHeadIndex);
    expect(stageIndex).toBeGreaterThan(secondHashIndex);
  });

  test("rejects unsafe or cross-run npm artifact outputs before download", async () => {
    const workflow = await readFile(stageWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Bind verified artifact identity");
    const directory = await mkdtemp(join(tmpdir(), "wrench-stage-identity-"));
    const sourceSha = "a".repeat(40);
    const baseEnvironment = Object.freeze({
      EXPECTED_ARTIFACT_NAME: `npm-package-0.15.1-${sourceSha}-123456-2`,
      EXPECTED_SOURCE_SHA: sourceSha,
      EXPECTED_TARBALL_NAME: "hraness-wrench-0.15.1.tgz",
      EXPECTED_VERSION: "0.15.1",
      GITHUB_OUTPUT: join(directory, "github-output.txt"),
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123456",
      GITHUB_SHA: sourceSha,
    });

    try {
      const accepted = await runWorkflowScript(script, baseEnvironment);
      expect(accepted.exitCode).toBe(0);
      expect(await readFile(baseEnvironment.GITHUB_OUTPUT, "utf8")).toBe(
        `artifact_name=${baseEnvironment.EXPECTED_ARTIFACT_NAME}\n`
        + `tarball_name=${baseEnvironment.EXPECTED_TARBALL_NAME}\n`
        + `version=${baseEnvironment.EXPECTED_VERSION}\n`
        + `source_sha=${baseEnvironment.EXPECTED_SOURCE_SHA}\n`,
      );

      for (const environment of [
        { ...baseEnvironment, EXPECTED_VERSION: "0.15.1/../../escape" },
        { ...baseEnvironment, EXPECTED_TARBALL_NAME: "../../escape.tgz" },
        { ...baseEnvironment, EXPECTED_SOURCE_SHA: "../unsafe-source" },
        { ...baseEnvironment, EXPECTED_ARTIFACT_NAME: `${baseEnvironment.EXPECTED_ARTIFACT_NAME}-other` },
        { ...baseEnvironment, GITHUB_RUN_ID: "123456/other" },
        { ...baseEnvironment, GITHUB_RUN_ATTEMPT: "0" },
      ] as const) {
        const rejected = await runWorkflowScript(script, environment);
        expect(rejected.exitCode).not.toBe(0);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain("::error::");
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("validates and npm-installs the exact reported tarball", async () => {
    const smoke = await readFile(packageSmokeUrl, "utf8");

    for (const required of [
      "--archive <package.tgz> --pack-json <npm-pack.json>",
      "entryCount",
      "unpackedSize",
      "npm pack file inventory does not match unpackedSize",
      "createHash(\"sha512\")",
      "createHash(\"sha1\")",
      "Exact npm tarball digest does not match npm-pack.json",
      "Clean npm install does not match the exact npm pack metrics",
      "\"npm\",\n      \"install\"",
      "`--registry=${NPM_REGISTRY}`",
      "not currently published on npm",
      "manifest.publishConfig.registry !== NPM_REGISTRY",
    ] as const) {
      expect(smoke).toContain(required);
    }
  });

  test("gates the immutable GitHub Release on canonical public npm content", async () => {
    const [workflow, artifact, identity] = await Promise.all([
      readFile(releaseWorkflowUrl, "utf8"),
      readFile(packageArtifactUrl, "utf8"),
      readFile(packageIdentityUrl, "utf8"),
    ]);

    for (const required of [
      "Verify exact public npm delivery",
      "node-version: \"24\"",
      "npm@11.19.0",
      "source_json=\"$RUNNER_TEMP/wrench-release-source.json\"",
      "registry_json=\"$RUNNER_TEMP/wrench-release-registry.json\"",
      "registry_view_json=\"$RUNNER_TEMP/wrench-release-registry-view.json\"",
      "npm pack \"$package_spec\"",
      "npm view \"$package_spec\" name version dist",
      `--registry=${npmRegistry}`,
      "scripts/npm-package-identity.ts",
      "--source-archive \"$source_archive\"",
      "--source-pack-json \"$source_json\"",
      "--registry-archive \"$registry_archive\"",
      "--registry-pack-json \"$registry_json\"",
      "--registry-view-json \"$registry_view_json\"",
      "--expected-name \"$package_name\"",
      "--expected-version \"$package_version\"",
      "--archive \"$registry_archive\"",
      "--pack-json \"$registry_json\"",
    ] as const) {
      expect(workflow).toContain(required);
    }

    expect(workflow).not.toContain("cmp \"$source_archive\" \"$registry_archive\"");
    expect(workflow.match(/npm pack /gu)).toHaveLength(2);
    expect(workflow.match(new RegExp(`--registry=${npmRegistry.replaceAll(".", "\\.")}`, "gu")))
      .toHaveLength(4);
    expect(workflow.indexOf("Verify exact public npm delivery"))
      .toBeLessThan(workflow.indexOf("\n  publish:"));

    for (const required of [
      "contentSha256",
      "contentSha512",
      "Unsupported package tar entry type",
      "Package tar contains data after its zero trailer",
      "maxOutputLength",
      "actual.mode !== file.mode",
    ] as const) {
      expect(`${artifact}\n${identity}`).toContain(required);
    }
    for (const required of [
      "Source and registry package content differ at canonical entry",
      "Source and registry npm pack file metadata differ",
      "npm registry metadata differs from the downloaded canonical package",
      "canonicalRegistryTarball",
      'createHash("sha1")',
      'createHash("sha256")',
      'createHash("sha512")',
    ] as const) {
      expect(identity).toContain(required);
    }
  });

  test("documents bootstrap, verification, stage-only trust, MFA, and tag ordering", async () => {
    const [guide, agents, readme, manifestText] = await Promise.all([
      readFile(publishingGuideUrl, "utf8"),
      readFile(agentGuideUrl, "utf8"),
      readFile(readmeUrl, "utf8"),
      readFile(manifestUrl, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as { readonly version: string };
    const exactPackage = `@hraness/wrench@${manifest.version}`;

    for (const required of [
      exactPackage,
      "npm publish \"$wrench_npm_archive\"",
      "npm trust github @hraness/wrench",
      "--allow-stage-publish",
      "npm access set mfa=publish @hraness/wrench",
      "scripts/npm-package-identity.ts",
      "--source-archive \"$wrench_npm_archive\"",
      "--registry-archive \"$wrench_registry_archive\"",
      `git tag v${manifest.version}`,
      "npm stage approve <stage-id>",
    ] as const) {
      expect(guide).toContain(required);
    }
    const commands = npmCommands(guide);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).toContain(`--registry=${npmRegistry}`);
    expect(guide.indexOf("npm publish \"$wrench_npm_archive\""))
      .toBeLessThan(guide.indexOf("npm trust github @hraness/wrench"));
    expect(guide.indexOf("npm trust github @hraness/wrench"))
      .toBeLessThan(guide.indexOf(`git tag v${manifest.version}`));

    expect(agents).toContain("Follow `docs/publishing.md`");
    expect(agents).toContain("verify that exact public artifact before creating its tag");
    expect(readme).toContain(exactPackage);
    expect(readme).not.toContain("not currently published on npm");
    expect(readme).not.toContain("registries are not supported install paths");
  });
});

describe("canonical npm package identity", () => {
  test("accepts transport and metadata-order drift while rejecting metadata, content, mode, and link drift", async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
    const filename = `hraness-wrench-${manifest.version}.tgz`;
    const work = await mkdtemp(join(tmpdir(), "wrench-package-identity-test-"));
    try {
      const sourceDirectory = join(work, "source");
      const registryDirectory = join(work, "registry");
      await mkdir(sourceDirectory);
      await mkdir(registryDirectory);
      const sourceArchive = join(sourceDirectory, filename);
      const registryArchive = join(registryDirectory, filename);
      await run([
        process.execPath,
        "pm",
        "pack",
        "--filename",
        sourceArchive,
        "--ignore-scripts",
        "--quiet",
      ], repository);

      const sourceBytes = await readFile(sourceArchive);
      const transportVariant = Buffer.from(sourceBytes);
      transportVariant[9] = transportVariant[9] === 3 ? 0 : 3;
      expect(transportVariant.equals(sourceBytes)).toBe(false);
      expect(gunzipSync(transportVariant).equals(gunzipSync(sourceBytes))).toBe(true);
      await writeFile(registryArchive, transportVariant);

      const [sourceInventory, registryInventory] = await Promise.all([
        inspectPackageArtifact(sourceArchive),
        inspectPackageArtifact(registryArchive),
      ]);
      const sourcePackJson = join(sourceDirectory, "npm-pack.json");
      const registryPackJson = join(registryDirectory, "npm-pack.json");
      const registryViewJson = join(registryDirectory, "npm-view.json");
      await Promise.all([
        writeFile(
          sourcePackJson,
          packJson(sourceBytes, sourceInventory, manifest.name, manifest.version),
        ),
        writeFile(
          registryPackJson,
          packJson(
            transportVariant,
            registryInventory,
            manifest.name,
            manifest.version,
            true,
          ),
        ),
        writeFile(
          registryViewJson,
          registryView(transportVariant, registryInventory, manifest.name, manifest.version),
        ),
      ]);
      const validInput = Object.freeze({
        expectedName: manifest.name,
        expectedVersion: manifest.version,
        registryArchive,
        registryPackJson,
        registryViewJson,
        sourceArchive,
        sourcePackJson,
      });
      const verified = await verifyNpmPackageIdentity(validInput);
      expect(verified.fileCount).toBe(sourceInventory.fileCount);
      expect(verified.sourceArchiveSha512).not.toBe(verified.registryArchiveSha512);

      const metadataDirectory = join(work, "metadata-mode");
      await mkdir(metadataDirectory);
      const metadataPackJson = join(metadataDirectory, "npm-pack.json");
      const metadataRecord = JSON.parse(
        packJson(transportVariant, registryInventory, manifest.name, manifest.version),
      ) as [{ files: Array<{ mode: number }> }];
      const firstMetadataFile = metadataRecord[0].files[0];
      if (firstMetadataFile === undefined) throw new Error("Test package has no metadata file");
      firstMetadataFile.mode = firstMetadataFile.mode === 0o644 ? 0o755 : 0o644;
      await writeFile(metadataPackJson, `${JSON.stringify(metadataRecord, null, 2)}\n`);
      await expect(verifyNpmPackageIdentity({
        ...validInput,
        registryPackJson: metadataPackJson,
      })).rejects.toThrow("Registry npm pack metadata differs from tar path, mode, or size");

      const originalTar = gunzipSync(sourceBytes);
      const first = firstRegularHeader(originalTar);

      const modeDirectory = join(work, "mode");
      await mkdir(modeDirectory);
      const modeArchive = join(modeDirectory, filename);
      const modeTar = Buffer.from(originalTar);
      modeTar.write("0000755\0", first.offset + 100, 8, "ascii");
      writeHeaderChecksum(modeTar, first.offset);
      const modeBytes = gzipSync(modeTar, { level: 9 });
      await writeFile(modeArchive, modeBytes);
      const modeInventory = await inspectPackageArtifact(modeArchive);
      const modePackJson = join(modeDirectory, "npm-pack.json");
      const modeViewJson = join(modeDirectory, "npm-view.json");
      await Promise.all([
        writeFile(
          modePackJson,
          packJson(modeBytes, modeInventory, manifest.name, manifest.version),
        ),
        writeFile(
          modeViewJson,
          registryView(modeBytes, modeInventory, manifest.name, manifest.version),
        ),
      ]);
      await expect(verifyNpmPackageIdentity({
        ...validInput,
        registryArchive: modeArchive,
        registryPackJson: modePackJson,
        registryViewJson: modeViewJson,
      })).rejects.toThrow("Source and registry npm pack file metadata differ");

      const contentDirectory = join(work, "content");
      await mkdir(contentDirectory);
      const contentArchive = join(contentDirectory, filename);
      const contentTar = Buffer.from(originalTar);
      contentTar[first.offset + 512] = (contentTar[first.offset + 512] ?? 0) ^ 0xff;
      const contentBytes = gzipSync(contentTar, { level: 9 });
      await writeFile(contentArchive, contentBytes);
      const contentInventory = await inspectPackageArtifact(contentArchive);
      const contentPackJson = join(contentDirectory, "npm-pack.json");
      const contentViewJson = join(contentDirectory, "npm-view.json");
      await Promise.all([
        writeFile(
          contentPackJson,
          packJson(contentBytes, contentInventory, manifest.name, manifest.version),
        ),
        writeFile(
          contentViewJson,
          registryView(contentBytes, contentInventory, manifest.name, manifest.version),
        ),
      ]);
      await expect(verifyNpmPackageIdentity({
        ...validInput,
        registryArchive: contentArchive,
        registryPackJson: contentPackJson,
        registryViewJson: contentViewJson,
      })).rejects.toThrow("Source and registry package content differ at canonical entry");

      const linkDirectory = join(work, "link");
      await mkdir(linkDirectory);
      const linkArchive = join(linkDirectory, filename);
      const linkTar = Buffer.from(originalTar);
      linkTar[first.offset + 156] = 50;
      writeHeaderChecksum(linkTar, first.offset);
      await writeFile(linkArchive, gzipSync(linkTar, { level: 9 }));
      await expect(verifyNpmPackageIdentity({
        ...validInput,
        registryArchive: linkArchive,
      })).rejects.toThrow("Unsupported package tar entry type");
    } finally {
      await rm(work, { force: true, recursive: true });
    }
  });
});
