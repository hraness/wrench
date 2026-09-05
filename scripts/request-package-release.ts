import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "hraness/wrench";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}.git`;
const REPOSITORY_ID = 1_316_443_113;
const OWNER_ACTOR_ID = "894119";
const NPM_ENVIRONMENT = "npm-stage";
const CI_WORKFLOW_ID = 323_493_607;
const CI_WORKFLOW_NAME = "CI";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const MAIN_REF = "refs/heads/main";
const MAXIMUM_INVENTORY_BYTES = 64 * 1_024;
const MAXIMUM_INVENTORY_ROWS = 500;
const MAXIMUM_COMMAND_BYTES = 256 * 1_024;
const COMMAND_TIMEOUT_MILLISECONDS = 120_000;
const SHA = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/u;

type Version = Readonly<{
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: readonly (bigint | string)[];
  text: string;
}>;

export type VersionTag = Readonly<{
  objectSha: string;
  ref: string;
  tag: string;
  version: Version;
}>;

export type PackageReleaseRuntime = Readonly<{
  git: (arguments_: readonly string[], authenticated?: boolean) => string;
  localRefExists: (ref: string) => boolean;
  readWorkingManifest: () => string;
  run: (command: string, arguments_: readonly string[], authenticated?: boolean) => string;
}>;

export type MainCiReceipt = Readonly<{
  attempt: number;
  runId: number;
  sourceSha: string;
}>;

function fail(message: string): never {
  throw new Error(message);
}

export function parsePackageVersion(value: string): Version {
  const match = VERSION.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    fail(`Package version ${value} is not strict SemVer without build metadata.`);
  }
  const prereleaseText = match[4];
  const prerelease = prereleaseText === undefined
    ? []
    : prereleaseText.split(".").map((identifier) => {
      if (!IDENTIFIER.test(identifier)) fail(`Package version ${value} has an invalid prerelease identifier.`);
      return /^[0-9]+$/u.test(identifier) ? BigInt(identifier) : identifier;
    });
  return Object.freeze({
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: Object.freeze(prerelease),
    text: value,
  });
}

export function comparePackageVersions(left: Version, right: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "bigint" && typeof rightPart === "bigint") return leftPart > rightPart ? 1 : -1;
    if (typeof leftPart === "bigint") return -1;
    if (typeof rightPart === "bigint") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function parseVersionTagInventory(value: Uint8Array | string): readonly VersionTag[] {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  if (bytes.byteLength > MAXIMUM_INVENTORY_BYTES) fail("Remote version-tag inventory exceeds its byte bound.");
  const input = typeof value === "string"
    ? value
    : new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (input === "") return Object.freeze([]);
  if (input.includes("\0") || input.includes("\r") || !input.endsWith("\n")) {
    fail("Remote version-tag inventory is not canonical line-oriented output.");
  }
  const rows = input.slice(0, -1).split("\n");
  if (rows.length > MAXIMUM_INVENTORY_ROWS || rows.some((row) => row === "")) {
    fail("Remote version-tag inventory exceeds its row bound.");
  }
  const seen = new Set<string>();
  const entries = rows.map((row) => {
    const [objectSha, ref, ...extra] = row.split("\t");
    const tag = ref?.startsWith("refs/tags/v") ? ref.slice("refs/tags/v".length) : undefined;
    if (extra.length !== 0 || objectSha === undefined || !SHA.test(objectSha) || ref === undefined || tag === undefined) {
      return fail("Remote version-tag inventory contains a malformed row.");
    }
    if (seen.has(ref)) fail(`Remote version-tag inventory repeats ${ref}.`);
    seen.add(ref);
    return Object.freeze({ objectSha, ref, tag: `v${tag}`, version: parsePackageVersion(tag) });
  });
  const canonical = [...entries]
    .sort((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)
    .map((entry) => `${entry.objectSha}\t${entry.ref}\n`)
    .join("");
  if (canonical !== input) fail("Remote version-tag inventory is not in canonical ref order.");
  return Object.freeze(entries);
}

export function assertMonotonicVersionTag(
  candidateVersion: string,
  entries: readonly VersionTag[],
): Readonly<{ existing?: VersionTag }> {
  const candidate = parsePackageVersion(candidateVersion);
  const candidateTag = `v${candidateVersion}`;
  const existing = entries.find((entry) => entry.tag === candidateTag);
  for (const entry of entries) {
    if (entry.tag === candidateTag) continue;
    if (comparePackageVersions(candidate, entry.version) <= 0) {
      fail(`Candidate ${candidateTag} is not newer than existing distinct release ${entry.tag}.`);
    }
  }
  return Object.freeze(existing === undefined ? {} : { existing });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function foreignJson(value: string, description: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fail(`${description} is not valid JSON.`);
  }
}

export function parseMainCiRun(sourceSha: string, value: unknown): MainCiReceipt {
  if (!SHA.test(sourceSha)) fail("Current-main CI receipt received a malformed source commit.");
  const response = record(value);
  const runs = response?.workflow_runs;
  if (response?.total_count !== 1 || !Array.isArray(runs) || runs.length !== 1) {
    fail("Current-main CI run inventory is not one exact bounded receipt.");
  }
  const run = record(runs[0]);
  const repository = record(run?.repository);
  const headRepository = record(run?.head_repository);
  const runId = run?.id;
  const attempt = run?.run_attempt;
  if (
    typeof runId !== "number"
    || !Number.isSafeInteger(runId)
    || runId <= 0
    || typeof attempt !== "number"
    || !Number.isSafeInteger(attempt)
    || attempt <= 0
    || run?.workflow_id !== CI_WORKFLOW_ID
    || run.name !== CI_WORKFLOW_NAME
    || run.path !== CI_WORKFLOW_PATH
    || run.event !== "push"
    || run.head_branch !== "main"
    || run.head_sha !== sourceSha
    || run.status !== "completed"
    || run.conclusion !== "success"
    || repository?.id !== REPOSITORY_ID
    || repository.full_name !== REPOSITORY
    || headRepository?.id !== REPOSITORY_ID
    || headRepository.full_name !== REPOSITORY
  ) {
    fail("Current-main CI run does not match the exact successful Wrench push receipt.");
  }
  return Object.freeze({ attempt, runId, sourceSha });
}

export function assertMainCiJobs(receipt: MainCiReceipt, value: unknown): void {
  const response = record(value);
  const jobs = response?.jobs;
  if (response?.total_count !== 3 || !Array.isArray(jobs) || jobs.length !== 3) {
    fail("Current-main CI job inventory is not the exact three-job receipt.");
  }
  const expectedNames = new Set(["check", "macOS", "Required"]);
  const seen = new Set<string>();
  for (const foreignJob of jobs) {
    const job = record(foreignJob);
    const name = job?.name;
    if (
      typeof name !== "string"
      || !expectedNames.has(name)
      || seen.has(name)
      || job.run_id !== receipt.runId
      || job.run_attempt !== receipt.attempt
      || job.head_sha !== receipt.sourceSha
      || job.workflow_name !== CI_WORKFLOW_NAME
      || job.status !== "completed"
      || job.conclusion !== "success"
    ) {
      fail("Current-main CI jobs do not match the exact successful Required gate.");
    }
    seen.add(name);
  }
  if (seen.size !== expectedNames.size) {
    fail("Current-main CI jobs are missing the exact Required gate.");
  }
}

export function assertVisibleGitIndex(value: string): void {
  if (value !== "" && !value.endsWith("\0")) {
    fail("Git index inventory is not canonical NUL-delimited output.");
  }
  const entries = value === "" ? [] : value.slice(0, -1).split("\0");
  for (const entry of entries) {
    if (entry.length < 3 || entry[1] !== " ") {
      fail("Git index inventory contains a malformed entry.");
    }
    const state = entry[0];
    if (state === "S" || state === state?.toLowerCase()) {
      fail("Git index contains a skip-worktree or assume-unchanged entry.");
    }
  }
}

export function assertCommittedPackageManifest(
  workingManifest: string,
  committedManifest: string,
): Readonly<{ name: "@hraness/wrench"; version: string }> {
  if (workingManifest !== committedManifest) {
    fail("Working package.json differs from the exact committed package manifest.");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(committedManifest) as unknown;
  } catch {
    return fail("Committed package.json is malformed.");
  }
  const value = record(manifest);
  const name = value?.name;
  const version = value?.version;
  if (name !== "@hraness/wrench" || typeof version !== "string") {
    fail("Committed package.json has the wrong package identity.");
  }
  parsePackageVersion(version);
  return Object.freeze({ name, version });
}

export function assertNpmStageEnvironment(
  environmentValue: unknown,
  deploymentPolicyValue: unknown,
): void {
  const environment = record(environmentValue);
  const protectionRules = environment?.protection_rules;
  const deploymentBranchPolicy = record(environment?.deployment_branch_policy);
  if (
    environment?.name !== NPM_ENVIRONMENT
    || environment.can_admins_bypass !== false
    || !Array.isArray(protectionRules)
    || protectionRules.length !== 1
    || record(protectionRules[0])?.type !== "branch_policy"
    || deploymentBranchPolicy?.protected_branches !== false
    || deploymentBranchPolicy.custom_branch_policies !== true
  ) {
    fail("npm-stage environment protection drifted from the no-review protected-tag policy.");
  }

  const deploymentPolicies = record(deploymentPolicyValue);
  const branchPolicies = deploymentPolicies?.branch_policies;
  if (
    deploymentPolicies?.total_count !== 1
    || !Array.isArray(branchPolicies)
    || branchPolicies.length !== 1
    || record(branchPolicies[0])?.name !== "v*"
    || record(branchPolicies[0])?.type !== "tag"
  ) {
    fail("npm-stage deployment policy drifted from the sole v* tag admission.");
  }
}

function run(command: string, arguments_: readonly string[]): string {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
    },
    maxBuffer: MAXIMUM_COMMAND_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MILLISECONDS,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr.trim();
    fail(`${command} ${arguments_[0] ?? ""} failed${detail === "" ? "" : `: ${detail}`}.`);
  }
  return result.stdout;
}

function git(arguments_: readonly string[], authenticated = false): string {
  return run("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "credential.interactive=never",
    ...(authenticated ? ["-c", "credential.helper=!gh auth git-credential"] : []),
    ...arguments_,
  ]);
}

function localRefExists(ref: string): boolean {
  const result = spawnSync(
    "git",
    [
      "-c", "core.hooksPath=/dev/null",
      "-c", "credential.helper=",
      "-c", "credential.interactive=never",
      "show-ref", "--verify", "--quiet", ref,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_ASKPASS: "/bin/false",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        SSH_ASKPASS: "/bin/false",
      },
      maxBuffer: MAXIMUM_COMMAND_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MILLISECONDS,
    },
  );
  if (result.error !== undefined || (result.status !== 0 && result.status !== 1)) {
    fail("Local version-tag existence check failed closed.");
  }
  return result.status === 0;
}

function readInventory(
  runtime: PackageReleaseRuntime,
): Readonly<{ canonical: string; entries: readonly VersionTag[] }> {
  const canonical = runtime.git(["ls-remote", "--sort=refname", "--refs", REPOSITORY_URL, "refs/tags/v*"]);
  return Object.freeze({ canonical, entries: parseVersionTagInventory(canonical) });
}

function assertCanonicalRepositoryUrl(runtime: PackageReleaseRuntime): void {
  if (runtime.git(["ls-remote", "--get-url", REPOSITORY_URL]) !== `${REPOSITORY_URL}\n`) {
    fail("Git URL rewriting changed the exact Wrench repository endpoint.");
  }
}

function assertExactCurrentMain(runtime: PackageReleaseRuntime, sourceSha: string): void {
  const mainAdvertisement = runtime.git(["ls-remote", "--sort=refname", "--refs", REPOSITORY_URL, MAIN_REF]);
  if (mainAdvertisement !== `${sourceSha}\t${MAIN_REF}\n`) {
    fail("Local HEAD is not exact current protected main.");
  }
}

function canonicalAnnotation(tag: string, sha: string): string {
  return `Wrench package release ${tag}\nsource-sha ${sha}\n`;
}

function verifyLocalAnnotatedTag(runtime: PackageReleaseRuntime, tag: string, sha: string): string {
  const ref = `refs/tags/${tag}`;
  const objectSha = runtime.git(["rev-parse", "--verify", ref]).trim();
  const objectType = runtime.git(["cat-file", "-t", objectSha]).trim();
  const peeled = runtime.git(["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!SHA.test(objectSha) || objectType !== "tag" || peeled !== sha) {
    fail(`Local ${tag} is not one annotated tag for exact source ${sha}.`);
  }
  const object = runtime.git(["cat-file", "tag", objectSha]);
  const separator = object.indexOf("\n\n");
  const headers = separator < 0 ? [] : object.slice(0, separator).split("\n");
  if (
    headers.length !== 4
    || headers[0] !== `object ${sha}`
    || headers[1] !== "type commit"
    || headers[2] !== `tag ${tag}`
    || !headers[3]?.startsWith("tagger ")
    || object.slice(separator + 2) !== canonicalAnnotation(tag, sha)
  ) {
    fail(`Local ${tag} does not have the canonical release annotation.`);
  }
  return objectSha;
}

function assertLiveNpmStageEnvironment(runtime: PackageReleaseRuntime): void {
  const headers = [
    "--header", "Accept: application/vnd.github+json",
    "--header", "X-GitHub-Api-Version: 2026-03-10",
    "--hostname", "github.com",
  ] as const;
  const environment = runtime.run("gh", [
    "api", "--method", "GET", ...headers,
    `/repos/${REPOSITORY}/environments/${NPM_ENVIRONMENT}`,
  ]);
  const deploymentPolicies = runtime.run("gh", [
    "api", "--method", "GET", ...headers,
    `/repos/${REPOSITORY}/environments/${NPM_ENVIRONMENT}/deployment-branch-policies?per_page=100&page=1`,
  ]);
  assertNpmStageEnvironment(
    foreignJson(environment, "npm-stage environment response"),
    foreignJson(deploymentPolicies, "npm-stage deployment-policy response"),
  );
}

function assertLiveMainCi(runtime: PackageReleaseRuntime, sourceSha: string): void {
  const headers = [
    "--header", "Accept: application/vnd.github+json",
    "--header", "X-GitHub-Api-Version: 2026-03-10",
    "--hostname", "github.com",
  ] as const;
  const runs = runtime.run("gh", [
    "api", "--method", "GET", ...headers,
    `/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${sourceSha}&per_page=100&page=1&exclude_pull_requests=true`,
  ]);
  const receipt = parseMainCiRun(
    sourceSha,
    foreignJson(runs, "Current-main CI run response"),
  );
  const jobs = runtime.run("gh", [
    "api", "--method", "GET", ...headers,
    `/repos/${REPOSITORY}/actions/runs/${receipt.runId}/attempts/${receipt.attempt}/jobs?per_page=100&page=1`,
  ]);
  assertMainCiJobs(receipt, foreignJson(jobs, "Current-main CI job response"));
}

const DEFAULT_RUNTIME: PackageReleaseRuntime = Object.freeze({
  git,
  localRefExists,
  readWorkingManifest: () => readFileSync(resolve("package.json"), "utf8"),
  run,
});

export function requestPackageRelease(runtime: PackageReleaseRuntime = DEFAULT_RUNTIME): string {
  const sourceSha = runtime.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!SHA.test(sourceSha) || runtime.git(["branch", "--show-current"]).trim() !== "main") {
    fail("Package release requests must run from exact local main.");
  }
  assertVisibleGitIndex(runtime.git(["ls-files", "-v", "-z"]));
  const committedManifest = runtime.git(["show", `${sourceSha}:package.json`]);
  const manifest = assertCommittedPackageManifest(runtime.readWorkingManifest(), committedManifest);
  const tag = `v${manifest.version}`;
  if (runtime.git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
    fail("Package release requests require a clean working tree.");
  }
  assertCanonicalRepositoryUrl(runtime);
  assertExactCurrentMain(runtime, sourceSha);
  const actor = runtime.run("gh", [
    "api", "--hostname", "github.com", "user", "--jq", "[.id,.type] | @tsv",
  ]).trim();
  if (actor !== `${OWNER_ACTOR_ID}\tUser`) {
    fail(`Package release requires the existing local GitHub credential for immutable owner actor ID ${OWNER_ACTOR_ID}.`);
  }
  assertLiveNpmStageEnvironment(runtime);
  assertLiveMainCi(runtime, sourceSha);
  assertCanonicalRepositoryUrl(runtime);
  assertExactCurrentMain(runtime, sourceSha);

  const first = readInventory(runtime);
  const admission = assertMonotonicVersionTag(manifest.version, first.entries);
  const localExists = runtime.localRefExists(`refs/tags/${tag}`);
  let tagObjectSha: string;
  if (admission.existing !== undefined) {
    if (!localExists) {
      runtime.git(["fetch", "--no-tags", "--no-write-fetch-head", REPOSITORY_URL, `refs/tags/${tag}:refs/tags/${tag}`]);
    }
    tagObjectSha = verifyLocalAnnotatedTag(runtime, tag, sourceSha);
    if (tagObjectSha !== admission.existing.objectSha) fail(`Remote ${tag} differs from its exact local recovery tag.`);
    return `${tag} already exists with the exact canonical source; publication workflows may be rerun without moving it.\n`;
  }
  if (localExists) {
    tagObjectSha = verifyLocalAnnotatedTag(runtime, tag, sourceSha);
  } else {
    runtime.git([
      "-c",
      "tag.gpgSign=false",
      "tag",
      "--annotate",
      "--message",
      canonicalAnnotation(tag, sourceSha).trimEnd(),
      tag,
      sourceSha,
    ]);
    tagObjectSha = verifyLocalAnnotatedTag(runtime, tag, sourceSha);
  }

  const second = readInventory(runtime);
  assertMonotonicVersionTag(manifest.version, second.entries);
  if (second.canonical !== first.canonical) fail("Remote version tags changed before immutable tag creation.");
  assertCanonicalRepositoryUrl(runtime);
  runtime.git(["push", REPOSITORY_URL, `refs/tags/${tag}:refs/tags/${tag}`], true);
  assertCanonicalRepositoryUrl(runtime);
  const final = readInventory(runtime);
  const published = assertMonotonicVersionTag(manifest.version, final.entries).existing;
  if (published?.objectSha !== tagObjectSha) fail("Remote tag readback does not match the exact annotated tag object.");
  return `Pushed immutable ${tag} at ${sourceSha}; protected tag workflows now own npm publication.\n`;
}

function main(): void {
  process.stdout.write(requestPackageRelease());
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
