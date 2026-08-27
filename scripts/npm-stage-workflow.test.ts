import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const stageWorkflowUrl = new URL("../.github/workflows/npm-stage.yml", import.meta.url);
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const manifestUrl = new URL("../package.json", import.meta.url);
const packageSmokeUrl = new URL("./package-smoke.ts", import.meta.url);
const publishingGuideUrl = new URL("../docs/publishing.md", import.meta.url);
const agentGuideUrl = new URL("../AGENTS.md", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const npmRegistry = "https://registry.npmjs.org";

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
      'artifact_name="npm-package-$version-$GITHUB_SHA"',
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
      "permissions:\n      contents: read\n      id-token: write",
      "timeout-minutes: 10",
      "node-version: \"24\"",
      "package-manager-cache: false",
      "npm@11.19.0",
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
      "name: ${{ needs.verify.outputs.artifact_name }}",
      "path: ${{ runner.temp }}/wrench-npm-package",
      "EXPECTED_TARBALL_NAME: ${{ needs.verify.outputs.tarball_name }}",
      "EXPECTED_VERSION: ${{ needs.verify.outputs.package_version }}",
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
      "EXPECTED_SOURCE_SHA: ${{ needs.verify.outputs.source_sha }}",
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

  test("gates the immutable GitHub Release on the exact public npm tarball", async () => {
    const workflow = await readFile(releaseWorkflowUrl, "utf8");

    for (const required of [
      "Verify exact public npm delivery",
      "node-version: \"24\"",
      "npm@11.19.0",
      "source_json=\"$RUNNER_TEMP/wrench-release-source.json\"",
      "registry_json=\"$RUNNER_TEMP/wrench-release-registry.json\"",
      "npm pack \"$package_spec\"",
      `--registry=${npmRegistry}`,
      "cmp \"$source_archive\" \"$registry_archive\"",
      "--archive \"$registry_archive\"",
      "--pack-json \"$registry_json\"",
    ] as const) {
      expect(workflow).toContain(required);
    }

    expect(workflow.match(/npm pack /gu)).toHaveLength(2);
    expect(workflow.match(new RegExp(`--registry=${npmRegistry.replaceAll(".", "\\.")}`, "gu")))
      .toHaveLength(3);
    expect(workflow.indexOf("Verify exact public npm delivery"))
      .toBeLessThan(workflow.indexOf("\n  publish:"));
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
      "cmp \"$wrench_npm_archive\" \"$wrench_registry_archive\"",
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
