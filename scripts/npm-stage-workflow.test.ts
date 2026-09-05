import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  inspectPackageArtifact,
  type PackageArtifactInventory,
} from "./package-artifact.js";
import {
  MAX_PACKAGE_TAR_BYTES,
  MAX_PACKED_BYTES,
  MAX_PACKED_ENTRIES,
  MAX_PACKED_FILES,
  MAX_UNPACKED_BYTES,
  packageArtifactBudget,
} from "./package-budget.js";
import { verifyNpmPackageIdentity } from "./npm-package-identity.js";
import {
  createReleaseAppJwt,
  parseReleaseAppConfiguration,
  parseReleaseAppIdentity,
  parseReleaseAppInstallation,
  parseReleaseAppTokenResponse,
  RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS,
  releaseAppTokenRequestBody,
  revokeReleaseAppTokenWithConvergence,
  WRENCH_REPOSITORY_ID,
  withReleaseAppToken,
  withReleaseAppTokenFromEnvironment,
} from "./release-app-token.mjs";
import {
  assertReleaseTagNewerThanPublished,
  collectDeploymentStatuses,
  collectProductionDeployments,
  createProviderBaseline as createProviderBaselineRaw,
  decodeProviderReceipt,
  encodeProviderReceipt,
  parseIncludedGitHubResponse,
  promoteWebsiteProduction,
  revalidateReleaseAuthority,
  releaseGraphqlRequestBudget,
  releasePublicHostRequestBudget,
  releaseRestRequestBudget,
  scrubReadOnlyGithubEnvironment,
  waitForProviderOutcome as waitForProviderOutcomeRaw,
  WrenchPublicSite,
} from "./release-provider-outcome.mjs";
import {
  createProductionReleaseMarker,
  parseProductionReleaseMarker,
  PRODUCTION_RELEASE_MARKER_PATH,
  serializeProductionReleaseMarker,
} from "../website/production-release-marker.mjs";
import {
  advanceWebsiteProductionRef,
  verifiedReleaseFetchArguments,
  websiteProductionPushArguments,
} from "./release-ref-writer.mjs";

const stageWorkflowUrl = new URL("../.github/workflows/npm-stage.yml", import.meta.url);
const ciWorkflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);
const releaseWorkflowUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const websiteProductionWorkflowUrl = new URL(
  "../.github/workflows/website-production.yml",
  import.meta.url,
);
const codeownersUrl = new URL("../.github/CODEOWNERS", import.meta.url);
const workflowsUrl = new URL("../.github/workflows/", import.meta.url);
const releaseAppTokenHelperUrl = new URL("./release-app-token.mjs", import.meta.url);
const releaseRefWriterHelperUrl = new URL("./release-ref-writer.mjs", import.meta.url);
const providerOutcomeHelperUrl = new URL("./release-provider-outcome.mjs", import.meta.url);
const manifestUrl = new URL("../package.json", import.meta.url);
const packageSmokeUrl = new URL("./package-smoke.ts", import.meta.url);
const standaloneSmokeUrl = new URL("./standalone-smoke.ts", import.meta.url);
const packageArtifactUrl = new URL("./package-artifact.ts", import.meta.url);
const packageBudgetUrl = new URL("./package-budget.ts", import.meta.url);
const packageIdentityUrl = new URL("./npm-package-identity.ts", import.meta.url);
const tsconfigUrl = new URL("../tsconfig.json", import.meta.url);
const publishingGuideUrl = new URL("../docs/publishing.md", import.meta.url);
const agentGuideUrl = new URL("../AGENTS.md", import.meta.url);
const websiteAgentGuideUrl = new URL("../website/AGENTS.md", import.meta.url);
const websiteReadmeUrl = new URL("../website/README.md", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
const skillInstallGuideUrl = new URL("../skills/wrench/references/install.md", import.meta.url);
const npmRegistry = "https://registry.npmjs.org";
const repository = fileURLToPath(new URL("../", import.meta.url));
const publicExportKeys = Object.freeze([
  ".",
  "./client",
  "./beeper",
  "./apple-photos",
  "./whatsapp",
  "./omni",
  "./messaging",
]);
const publicImportSpecifiers = Object.freeze([
  "@hraness/wrench",
  "@hraness/wrench/client",
  "@hraness/wrench/beeper",
  "@hraness/wrench/apple-photos",
  "@hraness/wrench/whatsapp",
  "@hraness/wrench/omni",
  "@hraness/wrench/messaging",
]);
const publicDistEntrypoints = Object.freeze([
  "dist/index.js",
  "dist/client.js",
  "dist/beeper-client.js",
  "dist/apple-photos-client.js",
  "dist/whatsapp-client.js",
  "dist/omni-client.js",
  "dist/messaging.js",
]);

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
    if (line.length === 0) {
      script.push("");
      continue;
    }
    if (!line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  return script.join("\n");
}

async function runWorkflowScript(
  script: string,
  environment: Readonly<Record<string, string>>,
  cwd = repository,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
  const child = Bun.spawn(["/bin/bash", "-c", script], {
    cwd,
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

const providerRepository = "hraness/wrench";
const providerPreviousSha = "1".repeat(40);
const providerVerifiedSha = "2".repeat(40);
const providerTagObjectSha = "3".repeat(40);
const providerWorkflowSha = "4".repeat(40);
const providerTag = "v0.16.2";
const providerTagCommitEndpoint =
  `/repos/${providerRepository}/commits/refs%2Ftags%2F${providerTag}`;
const providerAmbiguousTagCommitEndpoints = Object.freeze([
  `/repos/${providerRepository}/commits/${providerTag}`,
  `/repos/${providerRepository}/commits/tags/${providerTag}`,
  `/repos/${providerRepository}/commits/refs/tags/${providerTag}`,
]);
const providerReleasePublishedAt = "2026-08-29T14:00:00Z";
const providerBaselineServerDate = "2026-08-29T15:00:00.000Z";
const providerPromotionServerDate = "2026-08-29T15:01:00.000Z";
const providerReleaseAppRevocation = Object.freeze({
  converged: true,
  observationCount: 3,
  propagationObserved: true,
  stableDenials: 2,
});
const providerAuthority = Object.freeze({
  repository: providerRepository,
  verifiedSha: providerVerifiedSha,
  verifiedTag: providerTag,
});

type ProviderMarker = ReturnType<typeof createProductionReleaseMarker>;

function providerMarker(
  sourceSha: string,
  tag: string,
  deploymentId: number,
): ProviderMarker {
  return createProductionReleaseMarker({
    deploymentUrl: `https://wrench-${String(deploymentId)}-hraness.vercel.app`,
    name: "@hraness/wrench",
    sourceSha,
    tag,
    version: tag.slice(1),
  });
}

function providerMarkerObservation(
  marker: ProviderMarker | "missing",
  requestIndex: number,
): Readonly<Record<string, unknown>> {
  const requestPath = `${PRODUCTION_RELEASE_MARKER_PATH}?release=${providerTag}&source=${providerVerifiedSha}&nonce=fixture-${String(requestIndex).padStart(4, "0")}`;
  if (marker === "missing") {
    return Object.freeze({
      bodySha256: createHash("sha256").update("<!doctype html>\nmissing\n").digest("hex"),
      kind: "missing",
      requestPath,
    });
  }
  const body = serializeProductionReleaseMarker(marker);
  return Object.freeze({
    bodySha256: createHash("sha256").update(body).digest("hex"),
    kind: "release",
    marker,
    requestPath,
  });
}

class ProviderPublicSiteFixture {
  readonly calls: string[] = [];
  readonly timeouts: number[] = [];
  readonly markerSnapshots: readonly (ProviderMarker | "missing")[];
  readonly healthDigests: ReadonlyMap<string, readonly string[]>;
  readonly redirectDigests: readonly string[];
  readonly readHook: ((timeoutMilliseconds: number) => void) | undefined;
  #markerRead = 0;
  #healthReads = new Map<string, number>();
  #redirectRead = 0;

  constructor({
    healthDigests = new Map(),
    markerSnapshots = [providerMarker(providerVerifiedSha, providerTag, 20)],
    readHook,
    redirectDigests = [createHash("sha256").update("Redirecting...\n").digest("hex")],
  }: Readonly<{
    healthDigests?: ReadonlyMap<string, readonly string[]>;
    markerSnapshots?: readonly (ProviderMarker | "missing")[];
    readHook?: (timeoutMilliseconds: number) => void;
    redirectDigests?: readonly string[];
  }> = {}) {
    this.healthDigests = healthDigests;
    this.markerSnapshots = markerSnapshots;
    this.readHook = readHook;
    this.redirectDigests = redirectDigests;
  }

  #record(call: string, timeoutMilliseconds: number): void {
    this.calls.push(call);
    this.timeouts.push(timeoutMilliseconds);
    this.readHook?.(timeoutMilliseconds);
  }

  async readMarker(
    _tag: string,
    _sha: string,
    { timeoutMilliseconds }: Readonly<{ timeoutMilliseconds: number }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#record("marker", timeoutMilliseconds);
    const snapshot = this.markerSnapshots[
      Math.min(this.#markerRead, this.markerSnapshots.length - 1)
    ];
    this.#markerRead += 1;
    if (snapshot === undefined) throw new Error("public marker fixture is empty");
    return providerMarkerObservation(snapshot, this.#markerRead);
  }

  async readHealthRoute(
    route: string,
    _tag: string,
    _sha: string,
    { timeoutMilliseconds }: Readonly<{ timeoutMilliseconds: number }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#record(`health ${route}`, timeoutMilliseconds);
    const read = this.#healthReads.get(route) ?? 0;
    this.#healthReads.set(route, read + 1);
    const snapshots = this.healthDigests.get(route) ?? [
      createHash("sha256").update(`stable ${route}`).digest("hex"),
    ];
    const bodySha256 = snapshots[Math.min(read, snapshots.length - 1)];
    if (bodySha256 === undefined) throw new Error("public health fixture is empty");
    return Object.freeze({
      bodyBytes: 64,
      bodySha256,
      contentType: route === "/llms.txt"
        ? "text/plain; charset=utf-8"
        : "text/html; charset=utf-8",
      path: route,
      status: 200,
    });
  }

  async readWwwRedirect(
    requestPath: string,
    { timeoutMilliseconds }: Readonly<{ timeoutMilliseconds: number }>,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#record("www", timeoutMilliseconds);
    const bodySha256 = this.redirectDigests[
      Math.min(this.#redirectRead, this.redirectDigests.length - 1)
    ];
    this.#redirectRead += 1;
    if (bodySha256 === undefined) throw new Error("public redirect fixture is empty");
    return Object.freeze({
      bodySha256,
      contentType: "text/plain",
      location: `https://wrench.rip${requestPath}`,
      status: 308,
    });
  }
}

function inferredBaselinePublicSite(
  options: Parameters<typeof createProviderBaselineRaw>[0],
): ProviderPublicSiteFixture {
  const api = options.api as unknown as Readonly<{
    deploymentSnapshots?: readonly (readonly ProviderJson[])[];
    graphqlSnapshots?: readonly (readonly ProviderJson[])[];
    refSha?: string;
  }>;
  const refSha = api.refSha ?? providerPreviousSha;
  const rest = api.deploymentSnapshots?.[0] ?? [];
  const matching = rest
    .map((value) => value as Readonly<Record<string, ProviderJson>>)
    .filter((value) => value.sha === refSha)
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  const graph = api.graphqlSnapshots?.[0]
    ?.map((value) => value as Readonly<Record<string, ProviderJson>>)
    .filter((value) => value.commitOid === refSha)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  const deploymentId = Number(matching[0]?.id ?? graph?.[0]?.databaseId ?? 10);
  const tag = refSha === providerVerifiedSha ? providerTag : "v0.16.1";
  return new ProviderPublicSiteFixture({
    markerSnapshots: [providerMarker(refSha, tag, deploymentId)],
  });
}

const createProviderBaseline = (
  options: Parameters<typeof createProviderBaselineRaw>[0],
): ReturnType<typeof createProviderBaselineRaw> => createProviderBaselineRaw({
  publicSite: inferredBaselinePublicSite(options),
  verifiedTag: providerTag,
  ...options,
});

const waitForProviderOutcome = (
  options: Parameters<typeof waitForProviderOutcomeRaw>[0],
): ReturnType<typeof waitForProviderOutcomeRaw> => {
  const receipt = options.promotionReceipt as unknown as Readonly<{ mode?: unknown }>;
  const deploymentId = receipt.mode === "already-exact" ? 10 : 20;
  return waitForProviderOutcomeRaw({
    defaultBranch: "main",
    eventName: "push",
    publicSite: new ProviderPublicSiteFixture({
      markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, deploymentId)],
    }),
    recoveryWorkflowSha: "",
    ...providerAuthority,
    ...options,
  });
};

type ProviderJson = null | boolean | number | string | readonly ProviderJson[] | {
  readonly [key: string]: ProviderJson;
};

function providerDeployment(
  id: number,
  createdAt: string,
  overrides: Readonly<Record<string, ProviderJson>> = {},
): ProviderJson {
  const sha = typeof overrides.sha === "string" ? overrides.sha : providerVerifiedSha;
  return {
    created_at: createdAt,
    creator: { id: 35613825, login: "vercel[bot]", type: "Bot" },
    environment: "Production",
    id,
    original_environment: "Production",
    ref: sha,
    sha,
    statuses_url: `https://api.github.com/repos/${providerRepository}/deployments/${String(id)}/statuses`,
    task: "deploy",
    ...overrides,
  };
}

function providerGraphqlDeployment(
  id: number,
  createdAt: string,
  overrides: Readonly<Record<string, ProviderJson>> = {},
): ProviderJson {
  const vercelUrl = `https://wrench-${String(id)}-hraness.vercel.app`;
  const defaultLatestStatus: ProviderJson = {
    createdAt,
    creator: { __typename: "Bot", databaseId: 35613825, login: "vercel" },
    environment: "Production",
    environmentUrl: vercelUrl,
    id: `status-${String(id)}`,
    logUrl: vercelUrl,
    state: "SUCCESS",
    updatedAt: createdAt,
  };
  const latestStatus = Object.hasOwn(overrides, "latestStatus")
    ? overrides.latestStatus
    : defaultLatestStatus;
  const { latestStatus: _latestStatus, ...restOverrides } = overrides;
  return {
    commitOid: providerVerifiedSha,
    createdAt,
    creator: { __typename: "Bot", databaseId: 35613825, login: "vercel" },
    databaseId: id,
    environment: "Production",
    latestStatus,
    originalEnvironment: "Production",
    ref: null,
    state: "ACTIVE",
    task: "deploy",
    updatedAt: createdAt,
    ...restOverrides,
  };
}

function graphqlDeploymentFromRest(
  value: ProviderJson,
  restStatuses: readonly ProviderJson[] = [],
): ProviderJson {
  const deployment = value as Readonly<Record<string, ProviderJson>>;
  const creator = deployment.creator as Readonly<Record<string, ProviderJson>>;
  const derivedStatuses = restStatuses.map((value) => {
    const status = value as Readonly<Record<string, ProviderJson>>;
    const statusCreator = status.creator as Readonly<Record<string, ProviderJson>>;
    return {
      createdAt: status.created_at,
      creator: {
        __typename: statusCreator.type,
        databaseId: statusCreator.id,
        login: statusCreator.login === "vercel[bot]" ? "vercel" : statusCreator.login,
      },
      environment: status.environment,
      environmentUrl: status.environment_url,
      id: status.node_id,
      logUrl: status.log_url,
      state: typeof status.state === "string" ? status.state.toUpperCase() : status.state,
      updatedAt: status.updated_at,
    } satisfies ProviderJson;
  });
  const derivedLatestStatus = derivedStatuses[0];
  const statusState = (derivedLatestStatus as Readonly<Record<string, ProviderJson>> | undefined)
    ?.state;
  const derivedState = statusState === "SUCCESS" ? "ACTIVE" : statusState;
  const latestStatus = deployment.graphql_latest_status ?? derivedLatestStatus ??
    (providerGraphqlDeployment(
      deployment.id as number,
      deployment.created_at as string,
    ) as Readonly<Record<string, ProviderJson>>).latestStatus;
  return providerGraphqlDeployment(
    deployment.id as number,
    deployment.created_at as string,
    {
      commitOid: deployment.sha,
      creator: {
        __typename: creator.type,
        databaseId: creator.id,
        login: creator.login === "vercel[bot]" ? "vercel" : creator.login,
      },
      environment: deployment.environment,
      latestStatus,
      originalEnvironment: deployment.original_environment,
      state: deployment.graphql_state ?? derivedState ?? "ACTIVE",
      task: deployment.task,
      updatedAt:
        deployment.graphql_updated_at ??
        (derivedLatestStatus as Readonly<Record<string, ProviderJson>> | undefined)?.updatedAt ??
        deployment.created_at,
    },
  );
}

function providerGraphqlResponse(
  nodes: readonly ProviderJson[],
  {
    cost = 1,
    endCursor = null,
    hasNextPage = false,
    remaining = 999,
    resetAt = "2026-08-29T16:00:00Z",
    totalCount = nodes.length,
  }: Readonly<{
    cost?: number;
    endCursor?: ProviderJson;
    hasNextPage?: boolean;
    remaining?: number;
    resetAt?: string;
    totalCount?: number;
  }> = {},
): ProviderJson {
  return {
    data: {
      rateLimit: { cost, remaining, resetAt },
      repository: {
        deployments: {
          nodes,
          pageInfo: { endCursor, hasNextPage },
          totalCount,
        },
      },
    },
  };
}

function providerStatus(
  id: number,
  state: string,
  createdAt: string,
  overrides: Readonly<Record<string, ProviderJson>> = {},
  deploymentId = 10,
): ProviderJson {
  const vercelUrl = `https://wrench-${String(deploymentId)}-hraness.vercel.app`;
  return {
    created_at: createdAt,
    creator: { id: 35613825, login: "vercel[bot]", type: "Bot" },
    deployment_url: `https://api.github.com/repos/${providerRepository}/deployments/${String(deploymentId)}`,
    environment: "Production",
    environment_url: vercelUrl,
    id,
    log_url: vercelUrl,
    node_id: `status-${String(id)}`,
    state,
    target_url: vercelUrl,
    updated_at: createdAt,
    ...overrides,
  };
}

function providerRef(sha: string, branch = "website-production"): ProviderJson {
  return { object: { sha, type: "commit" }, ref: `refs/heads/${branch}` };
}

function providerRelease(overrides: Readonly<Record<string, ProviderJson>> = {}): ProviderJson {
  return {
    assets: [],
    draft: false,
    id: 10,
    immutable: true,
    prerelease: false,
    published_at: providerReleasePublishedAt,
    tag_name: providerTag,
    target_commitish: "main",
    ...overrides,
  };
}

function providerLatest(overrides: Readonly<Record<string, ProviderJson>> = {}): ProviderJson {
  return { tag_name: providerTag, ...overrides };
}

function providerCompare(overrides: Readonly<Record<string, ProviderJson>> = {}): ProviderJson {
  return {
    ahead_by: 1,
    base_commit: { sha: providerPreviousSha },
    behind_by: 0,
    commits: [{ sha: providerVerifiedSha }],
    merge_base_commit: { sha: providerPreviousSha },
    status: "ahead",
    ...overrides,
  };
}

function providerCommitResponse(sha: string): ProviderJson {
  return {
    commit: {
      message: "deterministic annotated-tag target fixture",
      tree: { sha: "4".repeat(40) },
    },
    parents: [],
    sha,
  };
}

class ProviderApiFixture {
  readonly calls: string[] = [];
  readonly graphqlCalls: string[] = [];
  readonly includedCalls: string[] = [];
  readonly timeoutMilliseconds: number[] = [];
  readonly deploymentDetailSnapshots: readonly ProviderJson[];
  readonly defaultBranchSnapshots: readonly string[];
  readonly defaultBranchShaSnapshots: readonly string[];
  readonly deploymentSnapshots: ProviderJson[][];
  readonly graphqlResponses: readonly ProviderJson[];
  readonly graphqlSnapshots: ProviderJson[][] | undefined;
  readonly latestSnapshots: readonly ProviderJson[];
  readonly serverDates: readonly string[];
  readonly statusSnapshots: Map<number, ProviderJson[][]>;
  compare: ProviderJson = providerCompare();
  compareHook: (() => void) | undefined;
  sourceCompare: ProviderJson | undefined;
  readonly sourceCompareSnapshots: readonly ProviderJson[];
  deploymentDetailError: Error | undefined;
  patchError: Error | undefined;
  refSha: string;
  readonly refSnapshots: readonly string[];
  readonly refValues: readonly ProviderJson[];
  readonly releaseSnapshots: readonly ProviderJson[];
  readonly tagSnapshots: readonly string[];
  latest: ProviderJson = providerLatest();
  release: ProviderJson = providerRelease();
  readonly readHook: ((timeoutMilliseconds: number | undefined) => void) | undefined;

  #deploymentDetailRead = 0;
  #defaultBranchRead = 0;
  #defaultBranchShaRead = 0;
  #deploymentRead = -1;
  #deploymentSnapshot: ProviderJson[] = [];
  #graphqlRead = -1;
  #graphqlResponseRead = 0;
  #graphqlSnapshot: ProviderJson[] = [];
  #refRead = 0;
  #releaseRead = 0;
  #latestRead = 0;
  #serverDateRead = 0;
  #sourceCompareRead = 0;
  #statusReads = new Map<number, number>();
  #statusCurrent = new Map<number, ProviderJson[]>();
  #tagRead = 0;

  constructor({
    deploymentDetails = [],
    defaultBranchSnapshots = [],
    defaultBranchShaSnapshots = [],
    deployments = [[]],
    graphqlDeployments,
    graphqlResponses = [],
    latestSnapshots = [],
    refSnapshots = [],
    refSha = providerPreviousSha,
    refValues = [],
    readHook,
    releaseSnapshots = [],
    serverDates = [providerPromotionServerDate],
    sourceCompare,
    sourceCompareSnapshots = [],
    statuses = new Map<number, ProviderJson[][]>(),
    tagSnapshots = [],
  }: Readonly<{
    deploymentDetails?: readonly ProviderJson[];
    defaultBranchSnapshots?: readonly string[];
    defaultBranchShaSnapshots?: readonly string[];
    deployments?: ProviderJson[][];
    graphqlDeployments?: ProviderJson[][];
    graphqlResponses?: readonly ProviderJson[];
    latestSnapshots?: readonly ProviderJson[];
    refSnapshots?: readonly string[];
    refSha?: string;
    refValues?: readonly ProviderJson[];
    readHook?: (timeoutMilliseconds: number | undefined) => void;
    releaseSnapshots?: readonly ProviderJson[];
    serverDates?: readonly string[];
    sourceCompare?: ProviderJson;
    sourceCompareSnapshots?: readonly ProviderJson[];
    statuses?: Map<number, ProviderJson[][]>;
    tagSnapshots?: readonly string[];
  }> = {}) {
    this.deploymentDetailSnapshots = deploymentDetails;
    this.defaultBranchSnapshots = defaultBranchSnapshots;
    this.defaultBranchShaSnapshots = defaultBranchShaSnapshots;
    this.deploymentSnapshots = deployments;
    this.graphqlResponses = graphqlResponses;
    this.graphqlSnapshots = graphqlDeployments;
    this.latestSnapshots = latestSnapshots;
    this.refSha = refSha;
    this.refSnapshots = refSnapshots;
    this.refValues = refValues;
    this.readHook = readHook;
    this.releaseSnapshots = releaseSnapshots;
    this.serverDates = serverDates;
    this.sourceCompare = sourceCompare;
    this.sourceCompareSnapshots = sourceCompareSnapshots;
    this.statusSnapshots = statuses;
    this.tagSnapshots = tagSnapshots;
  }

  async graphql(input: Readonly<{
    after?: string;
    name: string;
    owner: string;
    query: string;
  }>, options?: Readonly<{ timeoutMilliseconds?: number }>): Promise<ProviderJson> {
    if (options?.timeoutMilliseconds !== undefined) {
      this.timeoutMilliseconds.push(options.timeoutMilliseconds);
    }
    this.readHook?.(options?.timeoutMilliseconds);
    expect(input.owner).toBe("hraness");
    expect(input.name).toBe("wrench");
    expect(input.query).toContain("query WrenchProductionDeployments");
    this.graphqlCalls.push(`after=${input.after ?? ""}`);
    const response = this.graphqlResponses[
      Math.min(this.#graphqlResponseRead, this.graphqlResponses.length - 1)
    ];
    if (response !== undefined) {
      this.#graphqlResponseRead += 1;
      return response;
    }
    const page = input.after === undefined
      ? 1
      : Number(/^cursor-([1-4])$/u.exec(input.after)?.[1] ?? "0") + 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 5) {
      throw new Error(`Unexpected GraphQL cursor ${input.after ?? ""}`);
    }
    if (page === 1) {
      this.#graphqlRead += 1;
      const read = Math.min(this.#graphqlRead, this.deploymentSnapshots.length - 1);
      this.#deploymentSnapshot = this.deploymentSnapshots[read] ?? [];
      this.#graphqlSnapshot = this.graphqlSnapshots?.[
        Math.min(this.#graphqlRead, this.graphqlSnapshots.length - 1)
      ] ?? this.#deploymentSnapshot.map((deployment) => {
        const raw = deployment as Readonly<Record<string, ProviderJson>>;
        const id = raw.id as number;
        const statusRead = this.#statusReads.get(id) ?? 0;
        const snapshots = this.statusSnapshots.get(id) ?? [];
        const currentStatuses = snapshots[Math.min(statusRead, snapshots.length - 1)] ?? [];
        return graphqlDeploymentFromRest(deployment, currentStatuses);
      });
    }
    const start = (page - 1) * 100;
    const nodes = this.#graphqlSnapshot.slice(start, page * 100);
    const hasNextPage = this.#graphqlSnapshot.length > page * 100;
    return providerGraphqlResponse(nodes, {
      endCursor: hasNextPage ? `cursor-${String(page)}` : `end-${String(page)}`,
      hasNextPage,
      remaining: 999 - this.graphqlCalls.length,
      totalCount: this.#graphqlSnapshot.length,
    });
  }

  async get(
    endpoint: string,
    options?: Readonly<{ timeoutMilliseconds?: number }>,
  ): Promise<ProviderJson> {
    if (options?.timeoutMilliseconds !== undefined) {
      this.timeoutMilliseconds.push(options.timeoutMilliseconds);
    }
    this.readHook?.(options?.timeoutMilliseconds);
    this.calls.push(`GET ${endpoint}`);
    if (endpoint === `/repos/${providerRepository}`) {
      const branch = this.defaultBranchSnapshots[
        Math.min(this.#defaultBranchRead, this.defaultBranchSnapshots.length - 1)
      ];
      this.#defaultBranchRead += 1;
      return { default_branch: branch ?? "main" };
    }
    if (endpoint === `/repos/${providerRepository}/git/ref/heads/main`) {
      const sha = this.defaultBranchShaSnapshots[
        Math.min(this.#defaultBranchShaRead, this.defaultBranchShaSnapshots.length - 1)
      ];
      this.#defaultBranchShaRead += 1;
      return providerRef(sha ?? providerVerifiedSha, "main");
    }
    if (endpoint === `/repos/${providerRepository}/git/ref/heads/website-production`) {
      const value = this.refValues[Math.min(this.#refRead, this.refValues.length - 1)];
      const snapshot = this.refSnapshots[Math.min(this.#refRead, this.refSnapshots.length - 1)];
      this.#refRead += 1;
      if (value !== undefined) return value;
      return providerRef(snapshot ?? this.refSha);
    }
    if (endpoint === `/repos/${providerRepository}/releases/tags/${providerTag}`) {
      const snapshot = this.releaseSnapshots[
        Math.min(this.#releaseRead, this.releaseSnapshots.length - 1)
      ];
      this.#releaseRead += 1;
      if (snapshot !== undefined) return snapshot;
      return this.release;
    }
    if (endpoint === `/repos/${providerRepository}/releases/latest`) {
      const snapshot = this.latestSnapshots[
        Math.min(this.#latestRead, this.latestSnapshots.length - 1)
      ];
      this.#latestRead += 1;
      return snapshot ?? this.latest;
    }
    if (endpoint === providerTagCommitEndpoint) {
      const snapshot = this.tagSnapshots[Math.min(this.#tagRead, this.tagSnapshots.length - 1)];
      this.#tagRead += 1;
      return providerCommitResponse(snapshot ?? providerVerifiedSha);
    }
    if (providerAmbiguousTagCommitEndpoints.includes(endpoint)) {
      return providerCommitResponse(providerTagObjectSha);
    }
    if (
      endpoint ===
      `/repos/${providerRepository}/compare/${providerPreviousSha}...${providerVerifiedSha}`
    ) {
      this.compareHook?.();
      return this.compare;
    }
    const sourceComparison = new RegExp(
      `^/repos/${providerRepository}/compare/([0-9a-f]{40})\\.\\.\\.([0-9a-f]{40})$`,
      "u",
    ).exec(endpoint);
    if (sourceComparison !== null) {
      const ancestor = sourceComparison[1] ?? "";
      const descendant = sourceComparison[2] ?? "";
      const snapshot = this.sourceCompareSnapshots[
        Math.min(this.#sourceCompareRead, this.sourceCompareSnapshots.length - 1)
      ];
      this.#sourceCompareRead += 1;
      return snapshot ?? this.sourceCompare ?? providerCompare({
        base_commit: { sha: ancestor },
        commits: [{ sha: descendant }],
        merge_base_commit: { sha: ancestor },
      });
    }
    const deploymentPage = new RegExp(
      `^/repos/${providerRepository}/deployments\\?environment=Production&task=deploy&per_page=100&page=([1-6])$`,
      "u",
    ).exec(endpoint);
    if (deploymentPage !== null) {
      const page = Number(deploymentPage[1]);
      if (page === 1) {
        this.#deploymentRead += 1;
        this.#deploymentSnapshot =
          this.deploymentSnapshots[Math.min(this.#deploymentRead, this.deploymentSnapshots.length - 1)] ?? [];
      }
      return this.#deploymentSnapshot.slice((page - 1) * 100, page * 100);
    }
    const deploymentDetail = new RegExp(
      `^/repos/${providerRepository}/deployments/([1-9][0-9]*)$`,
      "u",
    ).exec(endpoint);
    if (deploymentDetail !== null) {
      if (this.deploymentDetailError !== undefined) throw this.deploymentDetailError;
      const deploymentId = Number(deploymentDetail[1]);
      const snapshot = this.deploymentDetailSnapshots[
        Math.min(this.#deploymentDetailRead, this.deploymentDetailSnapshots.length - 1)
      ];
      this.#deploymentDetailRead += 1;
      if (snapshot !== undefined) return snapshot;
      const found = this.#deploymentSnapshot.find((deployment) =>
        (deployment as Readonly<Record<string, ProviderJson>>).id === deploymentId);
      if (found !== undefined) return found;
      throw new Error(`Deployment ${String(deploymentId)} disappeared`);
    }
    const statusPage = new RegExp(
      `^/repos/${providerRepository}/deployments/([1-9][0-9]*)/statuses\\?per_page=100&page=([1-6])$`,
      "u",
    ).exec(endpoint);
    if (statusPage !== null) {
      const deploymentId = Number(statusPage[1]);
      const page = Number(statusPage[2]);
      if (page === 1) {
        const read = (this.#statusReads.get(deploymentId) ?? -1) + 1;
        this.#statusReads.set(deploymentId, read);
        const snapshots = this.statusSnapshots.get(deploymentId) ?? [[]];
        this.#statusCurrent.set(
          deploymentId,
          snapshots[Math.min(read, snapshots.length - 1)] ?? [],
        );
      }
      const statuses = this.#statusCurrent.get(deploymentId) ?? [];
      return statuses.slice((page - 1) * 100, page * 100);
    }
    throw new Error(`Unexpected provider GET ${endpoint}`);
  }

  async getWithServerDate(endpoint: string): Promise<ProviderJson> {
    this.includedCalls.push(endpoint);
    const body = await this.get(endpoint);
    const serverDate = this.serverDates[
      Math.min(this.#serverDateRead, this.serverDates.length - 1)
    ];
    this.#serverDateRead += 1;
    return { body, serverDate: serverDate ?? providerPromotionServerDate };
  }

  async advanceRef(
    repository: string,
    expectedOldSha: string,
    verifiedSha: string,
    verifiedTag: string,
  ): Promise<ProviderJson> {
    this.calls.push(`GIT CAS ${repository} ${expectedOldSha} ${verifiedSha} ${verifiedTag}`);
    expect(repository).toBe(providerRepository);
    expect(expectedOldSha).toBe(providerPreviousSha);
    expect(verifiedSha).toBe(providerVerifiedSha);
    expect(verifiedTag).toBe(providerTag);
    if (this.patchError !== undefined) throw this.patchError;
    this.refSha = providerVerifiedSha;
    return providerReleaseAppRevocation;
  }
}

function terminalBaselineStatus(
  deploymentId = 10,
  createdAt = "2026-08-29T13:01:00Z",
): Map<number, ProviderJson[][]> {
  return new Map([
    [deploymentId, [[providerStatus(100, "success", createdAt, {}, deploymentId)]]],
  ]);
}

async function providerReceipts(mode: "advanced" | "already-exact"): Promise<Readonly<{
  baseline: ProviderJson;
  baselineDeployment: ProviderJson;
  promotion: ProviderJson;
  promotionCalls: readonly string[];
}>> {
  const baselineDeployment = providerDeployment(
    10,
    mode === "already-exact" ? "2026-08-29T14:05:00Z" : "2026-08-29T13:00:00Z",
    mode === "already-exact" ? {} : { sha: providerPreviousSha },
  );
  const baselineApi = new ProviderApiFixture({
    deployments: [[baselineDeployment]],
    refSha: mode === "already-exact" ? providerVerifiedSha : providerPreviousSha,
    serverDates: [providerBaselineServerDate, providerBaselineServerDate],
    statuses: terminalBaselineStatus(
      10,
      mode === "already-exact" ? "2026-08-29T14:06:00Z" : "2026-08-29T13:01:00Z",
    ),
  });
  const baseline = await createProviderBaseline({
    api: baselineApi,
    repository: providerRepository,
    verifiedSha: providerVerifiedSha,
  }) as ProviderJson;
  const promotionApi = new ProviderApiFixture({
    deployments: [[baselineDeployment]],
    refSha: mode === "already-exact" ? providerVerifiedSha : providerPreviousSha,
    serverDates: [providerPromotionServerDate],
    statuses: terminalBaselineStatus(
      10,
      mode === "already-exact" ? "2026-08-29T14:06:00Z" : "2026-08-29T13:01:00Z",
    ),
  });
  const promotion = await promoteWebsiteProduction({
    api: promotionApi,
    baselineReceipt: baseline,
    repository: providerRepository,
    verifiedSha: providerVerifiedSha,
    verifiedTag: providerTag,
  }) as ProviderJson;
  return Object.freeze({
    baseline,
    baselineDeployment,
    promotion,
    promotionCalls: Object.freeze([...promotionApi.calls]),
  });
}

describe("npm publication contract", () => {
  test("derives the tar expansion ceiling from the reviewed package budget", async () => {
    const artifact = await readFile(packageArtifactUrl, "utf8");

    expect(MAX_PACKAGE_TAR_BYTES).toBe(
      Math.ceil(
        (MAX_UNPACKED_BYTES + MAX_PACKED_ENTRIES * 1_023 + 1_024) / 512,
      ) * 512,
    );
    expect(MAX_PACKAGE_TAR_BYTES).toBe(12_656_128);
    expect(MAX_PACKAGE_TAR_BYTES % 512).toBe(0);
    expect(artifact).toContain("maxOutputLength: MAX_PACKAGE_TAR_BYTES");
    expect(artifact).not.toContain("const maximumTarBytes");
  });

  test("enforces the derived package decompression ceiling", () => {
    const atCeiling = gzipSync(Buffer.alloc(MAX_PACKAGE_TAR_BYTES));
    const overCeiling = gzipSync(Buffer.alloc(MAX_PACKAGE_TAR_BYTES + 512));

    expect(
      gunzipSync(atCeiling, { maxOutputLength: MAX_PACKAGE_TAR_BYTES }).byteLength,
    ).toBe(MAX_PACKAGE_TAR_BYTES);
    expect(() =>
      gunzipSync(overCeiling, { maxOutputLength: MAX_PACKAGE_TAR_BYTES })
    ).toThrow();
  });

  test("keeps both complete CI checks within the reviewed wall-time budget", async () => {
    const workflow = await readFile(ciWorkflowUrl, "utf8");
    const checkStart = workflow.indexOf("\n  check:\n");
    const macosStart = workflow.indexOf("\n  macos:\n");
    const requiredStart = workflow.indexOf("\n  required:\n");

    expect(workflow.match(/^  check:$/gmu)).toHaveLength(1);
    expect(workflow.match(/^  macos:$/gmu)).toHaveLength(1);
    expect(workflow.match(/^  required:$/gmu)).toHaveLength(1);
    expect(workflow.match(/^    timeout-minutes: [0-9]+$/gmu)).toHaveLength(3);
    expect(checkStart).toBeGreaterThan(-1);
    expect(macosStart).toBeGreaterThan(checkStart);
    expect(requiredStart).toBeGreaterThan(macosStart);

    const checkJob = workflow.slice(checkStart, macosStart);
    const macosJob = workflow.slice(macosStart, requiredStart);
    const requiredJob = workflow.slice(requiredStart);

    const timeoutValues = (job: string): readonly number[] =>
      [...job.matchAll(/^    timeout-minutes: ([0-9]+)$/gmu)]
        .map((match) => Number(match[1]));

    expect(timeoutValues(checkJob)).toEqual([75]);
    expect(timeoutValues(macosJob)).toEqual([75]);
    expect(timeoutValues(requiredJob)).toEqual([5]);
    expect(checkJob.match(/^      - run: bun run check$/gmu) ?? []).toHaveLength(1);
    expect(macosJob.match(/^      - run: bun run check$/gmu) ?? []).toHaveLength(1);
    expect(requiredJob.match(/^      - run: bun run check$/gmu) ?? []).toHaveLength(0);
    expect(requiredJob.match(/^    needs: \[check, macos\]$/gmu) ?? []).toHaveLength(1);
  });

  test("keeps one narrow release-authoritative package budget", async () => {
    const [artifact, budget, smoke] = await Promise.all([
      readFile(packageArtifactUrl, "utf8"),
      readFile(packageBudgetUrl, "utf8"),
      readFile(packageSmokeUrl, "utf8"),
    ]);

    expect(artifact).toContain('from "./package-budget.js"');
    expect(smoke).toContain('from "./package-budget.js"');
    expect(budget).toContain("two `bun pm pack` artifacts");
    expect(budget).toContain("2,072,376 packed bytes");
    expect(budget).toContain("12,230,695 unpacked bytes, and");
    expect(budget).toContain("466 files");
    expect(budget).toContain(
      "6d9b427794aa2a74cd41badb9109f04c40f5be3fc20f4a9b7a4068c181b8d110",
    );
    expect(budget).toContain("measured a 3,543-byte Linux/macOS gzip spread");
    expect(budget).toContain("Keep the existing 2,178,192 packed-byte ceiling");
    expect(budget).toContain("4,244 unpacked bytes of bounded headroom");
    expect(MAX_PACKED_BYTES).toBe(2_178_192);
    expect(MAX_PACKED_ENTRIES).toBe(466);
    expect(MAX_PACKED_FILES).toBe(466);
    expect(MAX_UNPACKED_BYTES).toBe(12_234_939);
    expect(Object.isFrozen(packageArtifactBudget)).toBe(true);
    for (const range of Object.values(packageArtifactBudget)) {
      expect(Object.isFrozen(range)).toBe(true);
    }
    expect(packageArtifactBudget).toEqual({
      entryCount: { min: 466, max: 466 },
      fileCount: { min: 466, max: 466 },
      packedBytes: { min: 1_600_000, max: 2_178_192 },
      unpackedBytes: { min: 9_000_000, max: 12_234_939 },
    });
  });

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

  test("keeps the exact seven public SDK entrypoints and required source inventory", async () => {
    const [manifestSource, tsconfigSource, artifact, packageSmoke, standaloneSmoke]
      = await Promise.all([
        readFile(manifestUrl, "utf8"),
        readFile(tsconfigUrl, "utf8"),
        readFile(packageArtifactUrl, "utf8"),
        readFile(packageSmokeUrl, "utf8"),
        readFile(standaloneSmokeUrl, "utf8"),
      ]);
    const value: unknown = JSON.parse(manifestSource);
    expect(typeof value).toBe("object");
    expect(value).not.toBeNull();
    const manifest = value as { readonly exports?: unknown; readonly files?: unknown };
    expect(typeof manifest.exports).toBe("object");
    expect(manifest.exports).not.toBeNull();
    expect(Object.keys(manifest.exports as object)).toEqual(publicExportKeys);
    expect(Array.isArray(manifest.files)).toBe(true);
    const files = manifest.files as readonly unknown[];
    expect(files.every((path) => typeof path === "string" && path.length > 0)).toBe(true);
    expect(new Set(files).size).toBe(files.length);
    for (const requiredSource of [
      "src/assets/adapters/beeper/wrench-web-adapter.v2.2.0.json",
      "src/assets/adapters/beeper/wrench-web-adapter.v2.3.0.json",
      "src/local-cli-surface-contract.ts",
      "src/messaging.ts",
    ] as const) {
      expect(files).toContain(requiredSource);
      expect(artifact).toContain(`"${requiredSource}"`);
    }
    const tsconfig: unknown = JSON.parse(tsconfigSource);
    expect(
      (tsconfig as {
        readonly compilerOptions?: { readonly paths?: Record<string, unknown> };
      }).compilerOptions?.paths,
    ).toEqual({
      "@hraness/wrench": ["./src/index.ts"],
      "@hraness/wrench/client": ["./src/client.ts"],
      "@hraness/wrench/beeper": ["./src/beeper-client.ts"],
      "@hraness/wrench/apple-photos": ["./src/apple-photos-client.ts"],
      "@hraness/wrench/whatsapp": ["./src/whatsapp-client.ts"],
      "@hraness/wrench/omni": ["./src/omni-client.ts"],
      "@hraness/wrench/messaging": ["./src/messaging.ts"],
    });
    for (const specifier of publicImportSpecifiers) {
      expect(packageSmoke).toContain(`"${specifier}"`);
      expect(standaloneSmoke).toContain(`"${specifier}"`);
    }
  });

  test("keeps separate truthful Wrench 0.16.3, 0.16.4, and 0.16.5 changelog sections", async () => {
    const changelog = await readFile(changelogUrl, "utf8");
    const unreleasedHeader = "## Unreleased\n";
    const currentHeader = "## 0.16.5 - 2026-09-04\n";
    const releaseHeader = "## 0.16.4 - 2026-09-03\n";
    const incidentHeader = "## 0.16.3 - 2026-09-01\n";
    const unreleasedStart = changelog.indexOf(unreleasedHeader);
    const currentStart = changelog.indexOf(currentHeader);
    const releaseStart = changelog.indexOf(releaseHeader);
    const incidentStart = changelog.indexOf(incidentHeader);

    expect(changelog.match(/^## Unreleased$/gmu) ?? []).toHaveLength(1);
    expect(changelog.match(/^## 0\.16\.5 - 2026-09-04$/gmu) ?? []).toHaveLength(1);
    expect(changelog.match(/^## 0\.16\.4 - 2026-09-03$/gmu) ?? []).toHaveLength(1);
    expect(changelog.match(/^## 0\.16\.3 - 2026-09-01$/gmu) ?? []).toHaveLength(1);
    expect(unreleasedStart).toBeGreaterThan(-1);
    expect(currentStart).toBeGreaterThan(unreleasedStart);
    expect(releaseStart).toBeGreaterThan(currentStart);
    expect(incidentStart).toBeGreaterThan(releaseStart);
    expect(changelog.slice(unreleasedStart + unreleasedHeader.length, currentStart).trim()).toBe("");

    const currentReleaseEnd = changelog.indexOf("\n## ", currentStart + currentHeader.length);
    expect(currentReleaseEnd).toBe(releaseStart - 1);
    const currentSection = changelog.slice(currentStart, currentReleaseEnd);
    for (const requiredFact of [
      "production-outcome job",
      "canonical release marker",
      "custom-domain auto-assignment",
      "Latest Release projection",
      "version-tag update/deletion ruleset",
    ] as const) {
      expect(currentSection).toContain(requiredFact);
    }

    const nextReleaseStart = changelog.indexOf("\n## ", releaseStart + releaseHeader.length);
    expect(nextReleaseStart).toBe(incidentStart - 1);
    const releaseSection = changelog.slice(releaseStart, nextReleaseStart);
    for (const requiredFact of [
      "Omarchy",
      "production promotion",
      "release App",
      "Beeper",
      "signed-in X account's bookmarks",
      "Apple Photos",
      "WhatsApp",
    ] as const) {
      expect(releaseSection).toContain(requiredFact);
    }
    expect(releaseSection.match(/\bX\b/gmu) ?? []).toHaveLength(1);
    expect(releaseSection).not.toContain("CreateTweet");
    expect(releaseSection).not.toContain("UserTweets");
    expect(releaseSection).not.toContain("SearchTimeline");

    const nextIncidentStart = changelog.indexOf("\n## ", incidentStart + incidentHeader.length);
    expect(nextIncidentStart).toBeGreaterThan(incidentStart);
    const incidentSection = changelog.slice(incidentStart, nextIncidentStart);
    const normalizedIncidentSection = incidentSection.replace(/\s+/gu, " ");
    for (const retainedFact of [
      "stale-source npm-only",
      "npm published it on 2026-09-03",
      "no matching Git tag, GitHub Release, or production promotion",
      "not a completed Wrench release",
      "CreateTweet",
      "UserTweets",
      "SearchTimeline",
      "cleanup-required",
    ] as const) {
      expect(normalizedIncidentSection).toContain(retainedFact);
    }
    expect(incidentSection).not.toContain("Apple Photos");
    expect(incidentSection).not.toContain("WhatsApp Message Like Me");
  });

  test("separates read-only classification and verification from checkout-free terminal staging", async () => {
    const workflow = await readFile(stageWorkflowUrl, "utf8");
    const classifyStart = workflow.indexOf("\n  classify:\n");
    const verifyStart = workflow.indexOf("\n  verify:\n");
    const stageStart = workflow.indexOf("\n  stage:\n");

    expect(classifyStart).toBeGreaterThan(-1);
    expect(verifyStart).toBeGreaterThan(classifyStart);
    expect(verifyStart).toBeGreaterThan(-1);
    expect(stageStart).toBeGreaterThan(verifyStart);

    const classifyJob = workflow.slice(classifyStart, verifyStart);
    const verifyJob = workflow.slice(verifyStart, stageStart);
    const stageJob = workflow.slice(stageStart);

    expect(workflow.match(/actions\/checkout@/gu) ?? []).toHaveLength(2);
    expect(workflow.match(/fetch-depth: 1/gu) ?? []).toHaveLength(2);
    expect(workflow.match(/fetch-tags: false/gu) ?? []).toHaveLength(2);
    expect(workflow.match(/persist-credentials: false/gu) ?? []).toHaveLength(2);
    expect(workflow).not.toContain("fetch-depth: 0");
    expect(workflow).not.toContain("/immutable-releases");
    expect(workflow).not.toContain("git fetch --force");
    expect(workflow).not.toContain("git fetch --tags");

    for (const required of [
      "push:\n    branches:\n      - main\n    paths:\n      - package.json",
      "workflow_dispatch:",
      "contents: read",
    ] as const) {
      expect(workflow).toContain(required);
    }

    for (const required of [
      "name: Classify staging request",
      "permissions:\n      contents: read",
      "runs-on: ubuntu-latest",
      "timeout-minutes: 5",
      "should_stage: ${{ steps.request.outputs.should_stage }}",
      "source_sha: ${{ steps.request.outputs.source_sha }}",
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "persist-credentials: false",
      "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
      "node-version: \"24\"",
      "package-manager-cache: false",
      "name: Classify event-source package",
      "BEFORE_SHA: ${{ github.event.before }}",
      "github.event.repository.default_branch",
      "fetch-depth: 1",
      "fetch-tags: false",
      "ref: ${{ github.sha }}",
      './scripts/release-ref-authority.ts stage-current "$GITHUB_SHA"',
      './scripts/release-ref-authority.ts stage-push "$GITHUB_SHA" "$BEFORE_SHA"',
      'git show "$source_sha:package.json"',
      "read_manifest_version",
      "Current package manifest must name @hraness/wrench and use a stable semantic version",
      'case "$GITHUB_EVENT_NAME" in',
      "workflow_dispatch)",
      "push)",
      'git show "$previous_sha:package.json"',
      '[[ "$current_version" == "$previous_version" ]]',
      "package.json changed without a version change; npm staging is not required",
      'OLD_VERSION="$previous_version" NEW_VERSION="$current_version" node -e',
      "Automatic npm staging requires a version newer than $previous_version",
      "Unsupported npm staging event $GITHUB_EVENT_NAME",
      "should_stage=%s\\nsource_sha=%s\\n",
    ] as const) {
      expect(classifyJob).toContain(required);
    }

    expect(classifyJob).not.toContain("id-token: write");
    expect(classifyJob).not.toContain("npm stage publish");
    expect(classifyJob).not.toContain("npm view");

    for (const required of [
      "name: Verify exact package",
      "needs: classify",
      "if: needs.classify.outputs.should_stage == 'true'",
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
      "EXPECTED_SOURCE_SHA: ${{ needs.classify.outputs.source_sha }}",
      "fetch-depth: 1",
      "fetch-tags: false",
      "ref: ${{ needs.classify.outputs.source_sha }}",
      './scripts/release-ref-authority.ts stage-current "$EXPECTED_SOURCE_SHA"',
      "name: Verify unpublished package identity\n        env:\n          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}",
      'tag-absent "v$package_version" "$GITHUB_SHA"',
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
    expect(verifyJob).not.toContain("git fetch");
    expect(verifyJob.match(/npm view /gu) ?? []).toHaveLength(2);

    for (const required of [
      "name: Stage exact package",
      "needs: verify",
      "permissions:\n      contents: read\n      id-token: write",
      "environment: npm-stage",
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
      "EXPECTED_VERSION: ${{ steps.package_identity.outputs.version }}",
      "GH_TOKEN: ${{ github.token }}",
      "TARBALL: ${{ steps.artifact.outputs.tarball }}",
      '"$GITHUB_REPOSITORY" != "hraness/wrench"',
      '"$DEFAULT_BRANCH" != "main"',
      'repository_url="https://github.com/hraness/wrench.git"',
      'git ls-remote --sort=refname --refs "$repository_url"',
      '"refs/heads/main"',
      '"refs/tags/v$EXPECTED_VERSION"',
      "value.byteLength > 64 * 1024 || rows > 500",
      'const match = /^([0-9a-f]{40})\\trefs\\/heads\\/main\\n$/u.exec(snapshot);',
      'if [[ "$advertised_main" != "$EXPECTED_SOURCE_SHA" ]]',
      'compare/$EXPECTED_SOURCE_SHA...$advertised_main',
      'status !== "ahead"',
      'behind !== "0"',
      'base !== ancestor',
      'mergeBase !== ancestor',
      'terminal !== descendant',
      "cmp --silent",
      '"$GITHUB_SHA" != "$EXPECTED_SOURCE_SHA"',
      "Tag ${expectedTag} exists at the terminal staging boundary",
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
    expect(workflow.match(/environment: npm-stage/gu) ?? []).toHaveLength(1);
    expect(classifyJob).not.toContain("environment:");
    expect(verifyJob).not.toContain("environment:");
    expect(stageJob).not.toContain("actions/checkout@");
    expect(stageJob).toContain("contents: read");
    expect(stageJob).not.toContain("setup-bun@");
    expect(stageJob).not.toMatch(/\bbun\b/u);
    expect(stageJob).not.toContain("./scripts/");
    expect(stageJob).not.toContain("git init");
    expect(stageJob).not.toContain("git fetch");
    expect(stageJob).not.toContain("FETCH_HEAD");
    expect(stageJob.match(/git ls-remote --sort=refname --refs/gu) ?? []).toHaveLength(2);
    expect(stageJob).not.toContain("git ls-remote --sort=refname --refs --tags");
    expect(stageJob.match(/npm stage publish/gu) ?? []).toHaveLength(1);

    expect(workflow).not.toContain("secrets.NPM_TOKEN");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow.match(/\n  push:/gu) ?? []).toHaveLength(1);
    expect(workflow).not.toContain("pull_request:");
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
    const firstSnapshotIndex = stageJob.indexOf('git ls-remote --sort=refname --refs "$repository_url"');
    const secondSnapshotIndex = stageJob.indexOf(
      'git ls-remote --sort=refname --refs "$repository_url"',
      firstSnapshotIndex + 1,
    );
    const snapshotCheckIndex = stageJob.indexOf("value.byteLength > 64 * 1024 || rows > 500");
    const snapshotEqualityIndex = stageJob.indexOf("cmp --silent");
    const secondHashIndex = stageJob.indexOf('current_tarball_sha256="$(sha256sum "$TARBALL"');
    const stageIndex = stageJob.indexOf('npm stage publish "$TARBALL"');
    expect(firstHashIndex).toBeGreaterThan(downloadIndex);
    expect(secondHashIndex).toBeGreaterThan(firstHashIndex);
    expect(firstSnapshotIndex).toBeGreaterThan(secondHashIndex);
    expect(secondSnapshotIndex).toBeGreaterThan(firstSnapshotIndex);
    expect(snapshotCheckIndex).toBeGreaterThan(firstSnapshotIndex);
    expect(snapshotCheckIndex).toBeLessThan(secondSnapshotIndex);
    expect(snapshotEqualityIndex).toBeGreaterThan(secondSnapshotIndex);
    expect(stageIndex).toBeGreaterThan(snapshotEqualityIndex);
  });

  test("classifies only increasing stable versions for automatic staging", async () => {
    const workflow = await readFile(stageWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Classify event-source package");
    const directory = await mkdtemp(join(tmpdir(), "wrench-stage-classify-"));
    const binaryDirectory = join(directory, "bin");
    const gitStub = join(binaryDirectory, "git");
    const nodeStub = join(binaryDirectory, "node");
    const githubOutput = join(directory, "github-output.txt");
    const beforeSha = "b".repeat(40);
    const currentSha = "c".repeat(40);

    try {
      await mkdir(binaryDirectory, { recursive: true });
      await writeFile(nodeStub, `#!/bin/bash
set -euo pipefail
if [[ "\${1-}" == "--experimental-strip-types" && \
      "\${2-}" == "./scripts/release-ref-authority.ts" ]]; then
  case "\${3-}" in
    stage-current)
      [[ "\${4-}" == "$CURRENT_SHA" ]]
      printf 'source_sha=%s\n' "$CURRENT_SHA"
      ;;
    stage-push)
      if [[ "\${4-}" != "$CURRENT_SHA" || ! "\${5-}" =~ ^[a-f0-9]{40}$ || \
            "\${5-}" == "0000000000000000000000000000000000000000" ]]; then
        echo 'Push event has an invalid prior default-branch commit' >&2
        exit 1
      fi
      if [[ "$BEFORE_STATUS" != "ancestor" ]]; then
        echo "Push base \${5-} is not an available ancestor of $CURRENT_SHA" >&2
        exit 1
      fi
      printf 'source_sha=%s\nprevious_sha=%s\n' "$CURRENT_SHA" "\${5-}"
      ;;
    *)
      echo "unexpected authority mode: \${3-}" >&2
      exit 1
      ;;
  esac
else
  PATH="$ORIGINAL_PATH" exec node "$@"
fi
`, "utf8");
      await writeFile(gitStub, `#!/bin/bash
set -euo pipefail
case "\${1-}" in
  check-ref-format)
    [[ "\${2-}" == "refs/heads/main" ]]
    ;;
  fetch)
    exit 0
    ;;
  rev-parse)
    case "\${2-}" in
      origin/main|HEAD) printf '%s\\n' "$CURRENT_SHA" ;;
      *) echo "unexpected rev-parse target: \${2-}" >&2; exit 1 ;;
    esac
    ;;
  show)
    case "\${2-}" in
      "$CURRENT_SHA:package.json") printf '%s\\n' "$CURRENT_MANIFEST" ;;
      "$BEFORE_SHA:package.json") printf '%s\\n' "$PREVIOUS_MANIFEST" ;;
      *) echo "unexpected show target: \${2-}" >&2; exit 1 ;;
    esac
    ;;
  cat-file)
    [[ "$BEFORE_STATUS" == "ancestor" && "\${2-}" == "-e" && \
       "\${3-}" == "$BEFORE_SHA^{commit}" ]]
    ;;
  merge-base)
    [[ "$BEFORE_STATUS" == "ancestor" && "\${2-}" == "--is-ancestor" && \
       "\${3-}" == "$BEFORE_SHA" && "\${4-}" == "$CURRENT_SHA" ]]
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 1
    ;;
esac
`, "utf8");
      await Promise.all([chmod(gitStub, 0o755), chmod(nodeStub, 0o755)]);

      const manifest = (version: string): string => JSON.stringify({
        name: "@hraness/wrench",
        version,
      });
      const baseEnvironment = Object.freeze({
        BEFORE_SHA: beforeSha,
        BEFORE_STATUS: "ancestor",
        CURRENT_MANIFEST: manifest("0.16.1"),
        CURRENT_SHA: currentSha,
        DEFAULT_BRANCH: "main",
        GITHUB_EVENT_NAME: "push",
        GITHUB_OUTPUT: githubOutput,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: "hraness/wrench",
        GITHUB_SHA: currentSha,
        ORIGINAL_PATH: process.env.PATH ?? "",
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        PREVIOUS_MANIFEST: manifest("0.16.0"),
        RUNNER_TEMP: directory,
      });
      const runCase = async (
        overrides: Readonly<Record<string, string>>,
      ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
        await rm(githubOutput, { force: true });
        return runWorkflowScript(script, { ...baseEnvironment, ...overrides });
      };

      const automatic = await runCase({});
      if (automatic.exitCode !== 0) {
        throw new Error(`Automatic classification failed:\n${automatic.stdout}${automatic.stderr}`);
      }
      expect(automatic.exitCode).toBe(0);
      expect(await readFile(githubOutput, "utf8")).toBe(
        `should_stage=true\nsource_sha=${currentSha}\n`,
      );

      const unchanged = await runCase({ PREVIOUS_MANIFEST: manifest("0.16.1") });
      expect(unchanged.exitCode).toBe(0);
      expect(unchanged.stdout).toContain(
        "package.json changed without a version change; npm staging is not required",
      );
      expect(await readFile(githubOutput, "utf8")).toBe(
        `should_stage=false\nsource_sha=${currentSha}\n`,
      );

      const recovery = await runCase({
        GITHUB_EVENT_NAME: "workflow_dispatch",
        PREVIOUS_MANIFEST: manifest("0.16.1"),
      });
      expect(recovery.exitCode).toBe(0);
      expect(await readFile(githubOutput, "utf8")).toBe(
        `should_stage=true\nsource_sha=${currentSha}\n`,
      );

      for (const [overrides, message] of [
        [
          { CURRENT_MANIFEST: manifest("0.15.9") },
          "Automatic npm staging requires a version newer than 0.16.0",
        ],
        [
          { CURRENT_MANIFEST: manifest("0.16.1-beta.1") },
          "Current package manifest must name @hraness/wrench and use a stable semantic version",
        ],
        [
          { CURRENT_MANIFEST: manifest("0.16.1\nignored") },
          "Current package manifest must name @hraness/wrench and use a stable semantic version",
        ],
        [
          { PREVIOUS_MANIFEST: manifest("0.16.0-beta.1") },
          "Previous package manifest must name @hraness/wrench and use a stable semantic version",
        ],
        [
          { BEFORE_STATUS: "missing" },
          `Push base ${beforeSha} is not an available ancestor of ${currentSha}`,
        ],
        [
          { BEFORE_SHA: "0".repeat(40) },
          "Push event has an invalid prior default-branch commit",
        ],
        [
          { GITHUB_REF: "refs/heads/not-main" },
          "npm staging must run from main",
        ],
      ] as const) {
        const rejected = await runCase(overrides);
        expect(rejected.exitCode).not.toBe(0);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain(message);
        expect(await Bun.file(githubOutput).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
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

  type TerminalAdvertisementScenario =
    | "publication"
    | "governed-ref-rejection"
    | "non-descendant-comparison"
    | "malformed-comparison"
    | "malformed-ref-set"
    | "malformed-ref-row"
    | "excessive-advertisement";

  async function assertTerminalAdvertisementScenario(
    scenario: TerminalAdvertisementScenario,
  ): Promise<void> {
    const workflow = await readFile(stageWorkflowUrl, "utf8");
    const script = workflowStepScript(
      workflow,
      "Revalidate protected-main ancestry and stage exact package",
    );
    const directory = await mkdtemp(join(tmpdir(), "wrench-stage-tag-"));
    const binaryDirectory = join(directory, "bin");
    const commandLog = join(directory, "commands.log");
    const publishMarker = join(directory, "published.txt");
    const tarball = join(directory, "hraness-wrench-0.15.1.tgz");
    const sourceSha = "b".repeat(40);
    const driftSha = "d".repeat(40);
    const tarballSha256 = "c".repeat(64);
    const gitCallCount = join(directory, "git-call-count.txt");
    const gitStub = join(binaryDirectory, "git");
    const ghStub = join(binaryDirectory, "gh");
    const npmStub = join(binaryDirectory, "npm");
    const sha256Stub = join(binaryDirectory, "sha256sum");

    try {
      await mkdir(binaryDirectory, { recursive: true });
      await writeFile(tarball, "reviewed tarball fixture\n", "utf8");
      await writeFile(gitStub, `#!/bin/bash
set -euo pipefail
printf 'git %s\n' "$*" >> "$COMMAND_LOG"
if [[ "$*" != "ls-remote --sort=refname --refs https://github.com/hraness/wrench.git refs/heads/main refs/tags/v0.15.1" ]]; then
  echo "unexpected git command: $*" >&2
  exit 1
fi
call_count=0
if [[ -f "$GIT_CALL_COUNT" ]]; then read -r call_count < "$GIT_CALL_COUNT"; fi
call_count=$((call_count + 1))
printf '%s\n' "$call_count" > "$GIT_CALL_COUNT"
case "$GIT_SNAPSHOT_STATUS" in
  absent) printf '%s\trefs/heads/main\n' "$GITHUB_SHA" ;;
  present)
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    printf '%s\trefs/tags/v0.15.1\n' "$GITHUB_SHA"
    ;;
  failure) echo 'simulated remote lookup failure' >&2; exit 128 ;;
  main-drift)
    if [[ "$call_count" == "1" ]]; then
      printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    else
      printf '%s\trefs/heads/main\n' "$DRIFT_SHA"
    fi
    ;;
  descendant) printf '%s\trefs/heads/main\n' "$DRIFT_SHA" ;;
  tag-drift)
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    if [[ "$call_count" == "2" ]]; then
      printf '%s\trefs/tags/v0.15.1\n' "$GITHUB_SHA"
    fi
    ;;
  empty) ;;
  missing-main) printf '%s\trefs/tags/v0.15.0\n' "$GITHUB_SHA" ;;
  duplicate-main-same)
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    ;;
  duplicate-main-different)
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    printf '%s\trefs/heads/main\n' "$DRIFT_SHA"
    ;;
  duplicate-tag)
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    printf '%s\trefs/tags/v0.15.1\n' "$GITHUB_SHA"
    printf '%s\trefs/tags/v0.15.1\n' "$GITHUB_SHA"
    ;;
  unexpected-ref)
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    printf '%s\trefs/heads/unexpected\n' "$GITHUB_SHA"
    ;;
  short-sha) printf '%s\trefs/heads/main\n' "\${GITHUB_SHA%?}" ;;
  uppercase-sha) printf '%s\trefs/heads/main\n' "\${GITHUB_SHA^^}" ;;
  bad-sha) printf '%040d\trefs/heads/main\n' 0 | tr '0' z ;;
  space-row) printf '%s refs/heads/main\n' "$GITHUB_SHA" ;;
  no-tab) printf '%srefs/heads/main\n' "$GITHUB_SHA" ;;
  crlf) printf '%s\trefs/heads/main\r\n' "$GITHUB_SHA" ;;
  nul) printf '%s\trefs/heads/main\\0\n' "$GITHUB_SHA" ;;
  invalid-utf8) printf '\\377\n' ;;
  no-final-newline) printf '%s\trefs/heads/main' "$GITHUB_SHA" ;;
  too-large)
    printf '%s\trefs/heads/main\n' "$GITHUB_SHA"
    head -c 65537 /dev/zero | tr '\\0' x
    ;;
  too-many)
    for ((index = 0; index < 501; index += 1)); do
      printf '%s\trefs/heads/main-%03d\n' "$GITHUB_SHA" "$index"
    done
    ;;
  *) echo "unexpected snapshot status: $GIT_SNAPSHOT_STATUS" >&2; exit 1 ;;
esac
`, "utf8");
      await writeFile(ghStub, `#!/bin/bash
set -euo pipefail
printf 'gh %s\n' "$*" >> "$COMMAND_LOG"
expected="api /repos/$GITHUB_REPOSITORY/compare/$EXPECTED_SOURCE_SHA...$DRIFT_SHA --jq [.status, .ahead_by, .behind_by, .base_commit.sha, .merge_base_commit.sha, .commits[-1].sha] | @tsv"
if [[ "$*" != "$expected" ]]; then
  echo "unexpected gh command: $*" >&2
  exit 1
fi
case "$COMPARISON_STATUS" in
  valid) printf 'ahead\t1\t0\t%s\t%s\t%s\n' "$EXPECTED_SOURCE_SHA" "$EXPECTED_SOURCE_SHA" "$DRIFT_SHA" ;;
  behind) printf 'behind\t0\t1\t%s\t%s\t%s\n' "$DRIFT_SHA" "$DRIFT_SHA" "$EXPECTED_SOURCE_SHA" ;;
  divergent) printf 'diverged\t1\t1\t%s\t%s\t%s\n' "$EXPECTED_SOURCE_SHA" "$EXPECTED_SOURCE_SHA" "$DRIFT_SHA" ;;
  zero-ahead) printf 'ahead\t0\t0\t%s\t%s\t%s\n' "$EXPECTED_SOURCE_SHA" "$EXPECTED_SOURCE_SHA" "$DRIFT_SHA" ;;
  wrong-base) printf 'ahead\t1\t0\t%s\t%s\t%s\n' "$DRIFT_SHA" "$EXPECTED_SOURCE_SHA" "$DRIFT_SHA" ;;
  wrong-merge-base) printf 'ahead\t1\t0\t%s\t%s\t%s\n' "$EXPECTED_SOURCE_SHA" "$DRIFT_SHA" "$DRIFT_SHA" ;;
  wrong-terminal) printf 'ahead\t1\t0\t%s\t%s\t%s\n' "$EXPECTED_SOURCE_SHA" "$EXPECTED_SOURCE_SHA" "$EXPECTED_SOURCE_SHA" ;;
  malformed) printf 'ahead\tnot-a-count\t0\t%s\t%s\t%s\n' "$EXPECTED_SOURCE_SHA" "$EXPECTED_SOURCE_SHA" "$DRIFT_SHA" ;;
  failure) echo 'simulated comparison failure' >&2; exit 1 ;;
  *) echo "unexpected comparison status: $COMPARISON_STATUS" >&2; exit 1 ;;
esac
`, "utf8");
      await writeFile(sha256Stub, `#!/bin/bash\nset -euo pipefail\nprintf 'sha256sum %s\\n' "$*" >> "$COMMAND_LOG"\nprintf '%s  %s\\n' "$EXPECTED_TARBALL_SHA256" "$1"\n`, "utf8");
      await writeFile(npmStub, `#!/bin/bash\nset -euo pipefail\nprintf 'npm %s\\n' "$*" >> "$COMMAND_LOG"\nprintf 'published\\n' > "$PUBLISH_MARKER"\n`, "utf8");
      await Promise.all([
        chmod(ghStub, 0o755),
        chmod(gitStub, 0o755),
        chmod(npmStub, 0o755),
        chmod(sha256Stub, 0o755),
      ]);

      const baseEnvironment = Object.freeze({
        COMMAND_LOG: commandLog,
        COMPARISON_STATUS: "valid",
        DEFAULT_BRANCH: "main",
        DRIFT_SHA: driftSha,
        EXPECTED_SOURCE_SHA: sourceSha,
        EXPECTED_TARBALL_SHA256: tarballSha256,
        EXPECTED_VERSION: "0.15.1",
        GITHUB_REPOSITORY: "hraness/wrench",
        GITHUB_SHA: sourceSha,
        GH_TOKEN: "read-only-token",
        GIT_CALL_COUNT: gitCallCount,
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        PUBLISH_MARKER: publishMarker,
        RUNNER_TEMP: directory,
        TARBALL: tarball,
      });

      if (scenario === "publication") {
        const absent = await runWorkflowScript(script, {
          ...baseEnvironment,
          GIT_SNAPSHOT_STATUS: "absent",
        });
        expect(absent.exitCode, `${absent.stdout}\n${absent.stderr}`).toBe(0);
        expect(await readFile(publishMarker, "utf8")).toBe("published\n");
        const commands = await readFile(commandLog, "utf8");
        const combinedCommand = "git ls-remote --sort=refname --refs https://github.com/hraness/wrench.git refs/heads/main refs/tags/v0.15.1";
        const combinedIndexes = [...commands.matchAll(new RegExp(combinedCommand, "gu"))]
          .map((match) => match.index);
        const hashIndex = commands.indexOf("sha256sum");
        const publishIndex = commands.indexOf("npm stage publish");
        expect(combinedIndexes).toHaveLength(2);
        expect(combinedIndexes[0]).toBeGreaterThan(-1);
        expect(combinedIndexes[1]).toBeGreaterThan(combinedIndexes[0] ?? -1);
        expect(hashIndex).toBeLessThan(combinedIndexes[0] ?? -1);
        expect(publishIndex).toBeGreaterThan(combinedIndexes[1] ?? -1);

        await rm(commandLog, { force: true });
        await rm(gitCallCount, { force: true });
        await rm(publishMarker, { force: true });
        const descendant = await runWorkflowScript(script, {
          ...baseEnvironment,
          GIT_SNAPSHOT_STATUS: "descendant",
        });
        expect(descendant.exitCode, `${descendant.stdout}\n${descendant.stderr}`).toBe(0);
        expect(await readFile(publishMarker, "utf8")).toBe("published\n");
        expect(await readFile(commandLog, "utf8")).toContain(
          `gh api /repos/hraness/wrench/compare/${sourceSha}...${driftSha}`,
        );
      }

      if (scenario === "governed-ref-rejection") {
        for (const snapshotStatus of ["present", "failure", "main-drift", "tag-drift"] as const) {
          await rm(commandLog, { force: true });
          await rm(gitCallCount, { force: true });
          await rm(publishMarker, { force: true });
          const rejected = await runWorkflowScript(script, {
            ...baseEnvironment,
            GIT_SNAPSHOT_STATUS: snapshotStatus,
          });
          expect(rejected.exitCode).not.toBe(0);
          const output = `${rejected.stdout}${rejected.stderr}`;
          if (snapshotStatus === "present") {
            expect(output).toContain("Tag v0.15.1 exists at the terminal staging boundary");
          } else if (snapshotStatus === "failure") {
            expect(output).toContain("simulated remote lookup failure");
          } else {
            expect(output).toContain("Governed refs changed between terminal staging advertisements");
          }
          expect(await Bun.file(publishMarker).exists()).toBe(false);
        }
      }

      if (scenario === "non-descendant-comparison") {
        for (const comparisonStatus of [
          "behind",
          "divergent",
          "zero-ahead",
        ] as const) {
          await rm(commandLog, { force: true });
          await rm(gitCallCount, { force: true });
          await rm(publishMarker, { force: true });
          const rejected = await runWorkflowScript(script, {
            ...baseEnvironment,
            COMPARISON_STATUS: comparisonStatus,
            GIT_SNAPSHOT_STATUS: "descendant",
          });
          expect(rejected.exitCode).not.toBe(0);
          expect(await Bun.file(publishMarker).exists()).toBe(false);
        }
      }

      if (scenario === "malformed-comparison") {
        for (const comparisonStatus of [
          "wrong-base",
          "wrong-merge-base",
          "wrong-terminal",
          "malformed",
          "failure",
        ] as const) {
          await rm(commandLog, { force: true });
          await rm(gitCallCount, { force: true });
          await rm(publishMarker, { force: true });
          const rejected = await runWorkflowScript(script, {
            ...baseEnvironment,
            COMPARISON_STATUS: comparisonStatus,
            GIT_SNAPSHOT_STATUS: "descendant",
          });
          expect(rejected.exitCode).not.toBe(0);
          expect(await Bun.file(publishMarker).exists()).toBe(false);
        }
      }

      if (scenario === "malformed-ref-set") {
        for (const snapshotStatus of [
          "empty",
          "missing-main",
          "duplicate-main-same",
          "duplicate-main-different",
          "duplicate-tag",
          "unexpected-ref",
        ] as const) {
          await rm(commandLog, { force: true });
          await rm(gitCallCount, { force: true });
          await rm(publishMarker, { force: true });
          const rejected = await runWorkflowScript(script, {
            ...baseEnvironment,
            GIT_SNAPSHOT_STATUS: snapshotStatus,
          });
          expect(rejected.exitCode).not.toBe(0);
          expect(await Bun.file(publishMarker).exists()).toBe(false);
        }
      }

      if (scenario === "malformed-ref-row") {
        for (const snapshotStatus of [
          "short-sha",
          "uppercase-sha",
          "bad-sha",
          "space-row",
          "no-tab",
          "crlf",
          "nul",
          "invalid-utf8",
          "no-final-newline",
        ] as const) {
          await rm(commandLog, { force: true });
          await rm(gitCallCount, { force: true });
          await rm(publishMarker, { force: true });
          const rejected = await runWorkflowScript(script, {
            ...baseEnvironment,
            GIT_SNAPSHOT_STATUS: snapshotStatus,
          });
          expect(rejected.exitCode).not.toBe(0);
          expect(await Bun.file(publishMarker).exists()).toBe(false);
        }
      }

      if (scenario === "excessive-advertisement") {
        for (const snapshotStatus of [
          "too-large",
          "too-many",
        ] as const) {
          await rm(commandLog, { force: true });
          await rm(gitCallCount, { force: true });
          await rm(publishMarker, { force: true });
          const rejected = await runWorkflowScript(script, {
            ...baseEnvironment,
            GIT_SNAPSHOT_STATUS: snapshotStatus,
          });
          expect(rejected.exitCode).not.toBe(0);
          expect(await Bun.file(publishMarker).exists()).toBe(false);
        }
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  test.each([
    { label: "successful publication", scenario: "publication" },
    { label: "governed-ref rejection", scenario: "governed-ref-rejection" },
    { label: "non-descendant protected-main rejection", scenario: "non-descendant-comparison" },
    { label: "malformed protected-main comparison rejection", scenario: "malformed-comparison" },
    { label: "malformed ref-set rejection", scenario: "malformed-ref-set" },
    { label: "malformed ref-row rejection", scenario: "malformed-ref-row" },
    { label: "excessive advertisement rejection", scenario: "excessive-advertisement" },
  ] as const)(
    "rechecks main and exact-tag authority through two combined terminal advertisements: $label",
    ({ scenario }) => assertTerminalAdvertisementScenario(scenario),
  );

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

  test("accepts only exact tag pushes in the immutable Release workflow", async () => {
    const workflow = await readFile(releaseWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Resolve release request");
    const directory = await mkdtemp(join(tmpdir(), "wrench-release-request-"));
    const output = join(directory, "github-output.txt");

    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("ref: refs/tags/${{ steps.request.outputs.tag }}");
    expect(workflow).toContain("fetch-depth: 1");
    expect(workflow).toContain("persist-credentials: false");

    try {
      const runCase = async (
        overrides: Readonly<Record<string, string>>,
      ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
        await rm(output, { force: true });
        return runWorkflowScript(script, {
          EVENT_NAME: "push",
          EVENT_REF: "refs/tags/v0.16.2",
          EVENT_REF_NAME: "v0.16.2",
          EVENT_REF_TYPE: "tag",
          GITHUB_OUTPUT: output,
          ...overrides,
        });
      };

      const pushed = await runCase({});
      expect(pushed.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe("tag=v0.16.2\n");

      for (const rejectedEnvironment of [
        {
          EVENT_NAME: "workflow_dispatch",
          EVENT_REF: "refs/heads/main",
          EVENT_REF_NAME: "main",
          EVENT_REF_TYPE: "branch",
        },
        { EVENT_REF: "refs/heads/main", EVENT_REF_NAME: "main", EVENT_REF_TYPE: "branch" },
        { EVENT_REF_NAME: "v0.16.2\npoison", EVENT_REF: "refs/tags/v0.16.2\npoison" },
        { EVENT_NAME: "schedule" },
      ] as const) {
        const rejected = await runCase(rejectedEnvironment);
        expect(rejected.exitCode).not.toBe(0);
        expect(await Bun.file(output).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("routes recovery through the reviewed main-origin website workflow", async () => {
    const [releaseWorkflow, websiteWorkflow] = await Promise.all([
      readFile(releaseWorkflowUrl, "utf8"),
      readFile(websiteProductionWorkflowUrl, "utf8"),
    ]);
    const requestScript = workflowStepScript(
      websiteWorkflow,
      "Bind dispatch to reviewed main workflow source",
    );

    expect(releaseWorkflow).not.toContain("workflow_dispatch:");
    expect(releaseWorkflow).not.toContain("release-provider-outcome.mjs promote");
    expect(releaseWorkflow).not.toMatch(/release-provider-outcome\.mjs wait(?:\s|$)/u);
    expect(releaseWorkflow).not.toContain("/rulesets");
    expect(websiteWorkflow).toContain("workflow_run:");
    expect(websiteWorkflow).toContain("workflow_dispatch:");
    expect(websiteWorkflow).toContain("UPSTREAM_WORKFLOW_ID");
    expect(requestScript).toContain('"$UPSTREAM_WORKFLOW_ID" != "323493609"');
    expect(requestScript).toContain('"$EVENT_REPOSITORY_ID" != "1316443113"');
    for (const hostileField of [
      "UPSTREAM_CONCLUSION",
      "UPSTREAM_EVENT",
      "UPSTREAM_HEAD_BRANCH",
      "UPSTREAM_HEAD_REPOSITORY",
      "UPSTREAM_HEAD_SHA",
      "UPSTREAM_PATH",
      "UPSTREAM_RUN_ATTEMPT",
      "UPSTREAM_WORKFLOW_ID",
      "UPSTREAM_WORKFLOW_NAME",
    ] as const) {
      expect(requestScript).toContain(hostileField);
    }
    expect(requestScript).toContain('repository_default="$(gh api');
    expect(requestScript).toContain('current_main_sha="$(gh api');
    expect(requestScript).toContain('! "$current_main_sha" =~ ^[0-9a-f]{40}$');
    expect(requestScript).not.toContain('"$current_main_sha" != "$EVENT_SHA"');

    const directory = await mkdtemp(join(tmpdir(), "wrench-website-request-"));
    const binaryDirectory = join(directory, "bin");
    const ghStub = join(binaryDirectory, "gh");
    const output = join(directory, "github-output.txt");
    const sourceSha = providerWorkflowSha;
    try {
      await mkdir(binaryDirectory, { recursive: true });
      await writeFile(ghStub, `#!/bin/bash
set -euo pipefail
case "$*" in
  "api /repos/hraness/wrench --jq .default_branch") printf 'main\\n' ;;
  "api /repos/hraness/wrench/git/ref/heads/main --jq .object.sha") printf '%s\\n' "$CURRENT_MAIN_SHA" ;;
  *) echo "unexpected gh command: $*" >&2; exit 1 ;;
esac
`, "utf8");
      await chmod(ghStub, 0o755);
      const baseEnvironment = Object.freeze({
        CURRENT_MAIN_SHA: sourceSha,
        DEFAULT_BRANCH: "main",
        EVENT_NAME: "workflow_run",
        EVENT_REF: "refs/heads/main",
        EVENT_REPOSITORY: providerRepository,
        EVENT_REPOSITORY_ID: String(WRENCH_REPOSITORY_ID),
        EVENT_SHA: sourceSha,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: providerRepository,
        INPUT_RELEASE_TAG: "",
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        UPSTREAM_CONCLUSION: "success",
        UPSTREAM_EVENT: "push",
        UPSTREAM_HEAD_BRANCH: "v0.16.2",
        UPSTREAM_HEAD_REPOSITORY: providerRepository,
        UPSTREAM_HEAD_SHA: providerVerifiedSha,
        UPSTREAM_PATH: ".github/workflows/release.yml",
        UPSTREAM_RUN_ATTEMPT: "1",
        UPSTREAM_WORKFLOW_ID: "323493609",
        UPSTREAM_WORKFLOW_NAME: "Release",
      });
      const runCase = async (overrides: Readonly<Record<string, string>>) => {
        await rm(output, { force: true });
        return runWorkflowScript(requestScript, { ...baseEnvironment, ...overrides });
      };

      const automatic = await runCase({});
      expect(automatic.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe(
        `sha=${sourceSha}\ntag=v0.16.2\nrelease_sha=${providerVerifiedSha}\n`,
      );
      const manual = await runCase({
        EVENT_NAME: "workflow_dispatch",
        INPUT_RELEASE_TAG: "v0.16.2",
        UPSTREAM_CONCLUSION: "",
        UPSTREAM_EVENT: "",
        UPSTREAM_HEAD_BRANCH: "",
        UPSTREAM_HEAD_REPOSITORY: "",
        UPSTREAM_HEAD_SHA: "",
        UPSTREAM_PATH: "",
        UPSTREAM_RUN_ATTEMPT: "",
        UPSTREAM_WORKFLOW_ID: "",
        UPSTREAM_WORKFLOW_NAME: "",
      });
      expect(manual.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe(
        `sha=${sourceSha}\ntag=v0.16.2\nrelease_sha=\n`,
      );

      for (const rejected of [
        { UPSTREAM_WORKFLOW_ID: "1" },
        { UPSTREAM_WORKFLOW_NAME: "Copied Release" },
        { UPSTREAM_PATH: ".github/workflows/copied.yml" },
        { UPSTREAM_EVENT: "workflow_dispatch" },
        { UPSTREAM_RUN_ATTEMPT: "2" },
        { UPSTREAM_CONCLUSION: "failure" },
        { UPSTREAM_HEAD_REPOSITORY: "hraness/copied" },
        { UPSTREAM_HEAD_SHA: "not-a-sha" },
        { UPSTREAM_HEAD_BRANCH: "main" },
        { EVENT_REF: "refs/tags/v0.16.2" },
        { EVENT_REPOSITORY_ID: "1" },
        { CURRENT_MAIN_SHA: "not-a-sha" },
      ] as const) {
        const result = await runCase(rejected);
        expect(result.exitCode).not.toBe(0);
        expect(await Bun.file(output).exists()).toBe(false);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("separates reviewed main-origin workflow authority from the immutable release commit", async () => {
    const workflow = await readFile(websiteProductionWorkflowUrl, "utf8");
    const identityScript = workflowStepScript(
      workflow,
      "Verify exact immutable release coordinate",
    );

    expect(workflow.match(/actions\/checkout@/gu) ?? []).toHaveLength(5);
    expect(workflow.match(/fetch-depth: 1/gu) ?? []).toHaveLength(5);
    expect(workflow.match(/fetch-tags: false/gu) ?? []).toHaveLength(5);
    expect(workflow.match(/persist-credentials: false/gu) ?? []).toHaveLength(5);
    expect(workflow).not.toContain("fetch-depth: 0");
    expect(identityScript).not.toContain("git tag --list");
    expect(identityScript).not.toContain("FETCH_HEAD");

    expect(identityScript).toContain('"$head_commit" != "$RECOVERY_WORKFLOW_SHA"');
    expect(identityScript).toContain('"$REQUESTED_RELEASE_SHA" != "$tag_commit"');
    expect(identityScript).toContain(
      './scripts/release-ref-authority.ts promotion "$REQUESTED_TAG"',
    );
    expect(identityScript).not.toContain("git merge-base");
    expect(identityScript).toContain('git show "${tag_commit}:package.json"');
    expect(identityScript).toContain("printf 'sha=%s\\n' \"$tag_commit\"");
    expect(identityScript).toContain(
      'VERIFIED_SHA="$tag_commit" VERIFIED_TAG="$REQUESTED_TAG"',
    );
    expect(identityScript).not.toContain('"$tag_commit" != "$head_commit"');

    const api = new ProviderApiFixture({
      defaultBranchShaSnapshots: [
        providerWorkflowSha,
        providerWorkflowSha,
        providerWorkflowSha,
        providerWorkflowSha,
      ],
      releaseSnapshots: [
        providerRelease({ target_commitish: "main" }),
        providerRelease({ target_commitish: providerVerifiedSha }),
      ],
    });
    await expect(revalidateReleaseAuthority({
      api,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerWorkflowSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).resolves.toBeUndefined();
    expect(api.calls.filter((call) => call === `GET ${providerTagCommitEndpoint}`))
      .toHaveLength(2);

    const releaseIdentityDrift = new ProviderApiFixture({
      defaultBranchShaSnapshots: [
        providerWorkflowSha,
        providerWorkflowSha,
        providerWorkflowSha,
        providerWorkflowSha,
      ],
      releaseSnapshots: [
        providerRelease({ id: 10, target_commitish: "main" }),
        providerRelease({ id: 11, target_commitish: providerVerifiedSha }),
      ],
    });
    await expect(revalidateReleaseAuthority({
      api: releaseIdentityDrift,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerWorkflowSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("changed during authority verification");

    const directory = await mkdtemp(join(tmpdir(), "wrench-promotion-identity-"));
    const output = join(directory, "github-output.txt");
    const helperDirectory = join(directory, "scripts");
    const binaryDirectory = join(directory, "bin");
    const nodeStub = join(binaryDirectory, "node");
    const checkedGit = (arguments_: readonly string[]): string => {
      const result = Bun.spawnSync(["git", ...arguments_], {
        cwd: directory,
        stderr: "pipe",
        stdout: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      checkedGit(["init", "--initial-branch=main"]);
      checkedGit(["config", "user.name", "Wrench promotion test"]);
      checkedGit(["config", "user.email", "test@example.invalid"]);
      await mkdir(helperDirectory, { recursive: true });
      await mkdir(binaryDirectory, { recursive: true });
      await writeFile(nodeStub, `#!/bin/bash
set -euo pipefail
if [[ "\${1-}" == "--experimental-strip-types" && \
      "\${2-}" == "./scripts/release-ref-authority.ts" && \
      "\${3-}" == "promotion" ]]; then
  [[ "$GITHUB_REPOSITORY" == "hraness/wrench" && "$DEFAULT_BRANCH" == "main" ]]
  tag="\${4-}"
  workflow_sha="\${5-}"
  expected_release_sha="\${6-}"
  head_sha="$(PATH="$ORIGINAL_PATH" git rev-parse --verify 'HEAD^{commit}')"
  tag_sha="$(PATH="$ORIGINAL_PATH" git rev-parse --verify "refs/tags/$tag^{commit}")"
  [[ "$head_sha" == "$workflow_sha" ]]
  PATH="$ORIGINAL_PATH" git merge-base --is-ancestor "$tag_sha" "$workflow_sha"
  if [[ -n "$expected_release_sha" && "$expected_release_sha" != "$tag_sha" ]]; then
    exit 1
  fi
  printf 'sha=%s\ntag=%s\nmain_sha=%s\n' "$tag_sha" "$tag" "$workflow_sha"
else
  PATH="$ORIGINAL_PATH" exec node "$@"
fi
`, "utf8");
      await chmod(nodeStub, 0o755);
      await writeFile(
        join(directory, "package.json"),
        '{"name":"@hraness/wrench","version":"0.16.2"}\n',
        "utf8",
      );
      await writeFile(
        join(helperDirectory, "release-provider-outcome.mjs"),
        "process.exit(0);\n",
        "utf8",
      );
      checkedGit(["add", "package.json", "scripts/release-provider-outcome.mjs"]);
      checkedGit(["commit", "-m", "immutable release"]);
      const releaseSha = checkedGit(["rev-parse", "HEAD"]);
      checkedGit(["tag", providerTag]);
      await writeFile(
        join(directory, "package.json"),
        '{"name":"@hraness/wrench","version":"9.9.9"}\n',
        "utf8",
      );
      await writeFile(join(directory, "control.txt"), "reviewed main workflow\n", "utf8");
      checkedGit(["add", "package.json", "control.txt"]);
      checkedGit(["commit", "-m", "post-release control fix"]);
      const workflowSha = checkedGit(["rev-parse", "HEAD"]);

      const runIdentity = async (
        eventName: "workflow_dispatch" | "workflow_run",
        requestedReleaseSha: string,
        recoveryWorkflowSha = workflowSha,
      ) => {
        await rm(output, { force: true });
        return runWorkflowScript(identityScript, {
          DEFAULT_BRANCH: "main",
          EVENT_NAME: eventName,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "hraness/wrench",
          ORIGINAL_PATH: process.env.PATH ?? "",
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          RECOVERY_WORKFLOW_SHA: recoveryWorkflowSha,
          REQUESTED_RELEASE_SHA: requestedReleaseSha,
          REQUESTED_TAG: providerTag,
        }, directory);
      };

      for (const [eventName, requestedReleaseSha] of [
        ["workflow_dispatch", ""],
        ["workflow_run", releaseSha],
      ] as const) {
        const result = await runIdentity(eventName, requestedReleaseSha);
        expect(result.exitCode).toBe(0);
        expect(await readFile(output, "utf8")).toBe(
          `sha=${releaseSha}\ntag=${providerTag}\n`,
        );
      }

      checkedGit(["checkout", "--detach", releaseSha]);
      const immediate = await runIdentity("workflow_dispatch", "", releaseSha);
      expect(immediate.exitCode).toBe(0);
      expect(await readFile(output, "utf8")).toBe(
        `sha=${releaseSha}\ntag=${providerTag}\n`,
      );
      checkedGit(["switch", "main"]);

      for (const [eventName, requestedReleaseSha] of [
        ["workflow_dispatch", releaseSha],
        ["workflow_run", "5".repeat(40)],
      ] as const) {
        const result = await runIdentity(eventName, requestedReleaseSha);
        expect(result.exitCode).not.toBe(0);
        expect(await Bun.file(output).exists()).toBe(false);
      }

      checkedGit(["switch", "--orphan", "unrelated"]);
      await writeFile(
        join(directory, "package.json"),
        '{"name":"@hraness/wrench","version":"0.16.2"}\n',
        "utf8",
      );
      checkedGit(["add", "package.json"]);
      checkedGit(["commit", "-m", "unrelated release"]);
      checkedGit(["tag", "--force", providerTag]);
      checkedGit(["switch", "main"]);
      const unrelated = await runIdentity("workflow_dispatch", "");
      expect(unrelated.exitCode).not.toBe(0);
      expect(await Bun.file(output).exists()).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("gates the immutable GitHub Release on canonical public npm content", async () => {
    const [workflow, ciWorkflow, artifact, identity] = await Promise.all([
      readFile(releaseWorkflowUrl, "utf8"),
      readFile(ciWorkflowUrl, "utf8"),
      readFile(packageArtifactUrl, "utf8"),
      readFile(packageIdentityUrl, "utf8"),
    ]);

    expect(workflow.match(/actions\/checkout@/gu) ?? []).toHaveLength(2);
    expect(workflow.match(/fetch-depth: 1/gu) ?? []).toHaveLength(2);
    expect(workflow.match(/fetch-tags: false/gu) ?? []).toHaveLength(2);
    expect(workflow.match(/persist-credentials: false/gu) ?? []).toHaveLength(2);
    expect(workflow).not.toContain("fetch-depth: 0");
    expect(workflow).toContain(
      './scripts/release-ref-authority.ts release "$REQUESTED_TAG"',
    );
    expect(workflow).not.toContain("git tag --list");
    expect(workflow).not.toContain("/immutable-releases");

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
    const publishScript = workflowStepScript(workflow, "Publish verified GitHub Release");
    expect(publishScript).toContain("verify_publication_authority() {");
    expect(publishScript).toContain(
      './scripts/release-ref-authority.ts "publication-$phase"',
    );
    expect(publishScript).not.toContain("/commits/tags/");
    expect(publishScript.indexOf('verify_publication_authority prewrite "$current_main_sha"'))
      .toBeLessThan(publishScript.indexOf("--method POST"));
    expect(publishScript.match(/verify_publication_authority (?:pre|post)write/gu) ?? [])
      .toHaveLength(2);
    expect(publishScript.match(/git\/ref\/heads\/\$DEFAULT_BRANCH/gu) ?? []).toHaveLength(3);
    expect(publishScript.match(/commits\/refs%2Ftags%2F\$VERIFIED_TAG/gu) ?? [])
      .toHaveLength(3);
    const releaseOrderIndex = publishScript.indexOf(
      "node ./scripts/release-provider-outcome.mjs release-order",
    );
    const authenticatedMainIndex = publishScript.indexOf(
      'current_main_sha="$(gh api',
      releaseOrderIndex,
    );
    const authenticatedTagIndex = publishScript.indexOf(
      'remote_tag_sha="$(gh api',
      authenticatedMainIndex,
    );
    const prePublicationAdvertisementIndex = publishScript.indexOf(
      'verify_publication_authority prewrite "$current_main_sha"',
      authenticatedTagIndex,
    );
    const releasePostIndex = publishScript.indexOf("--method POST");
    expect(releaseOrderIndex).toBeGreaterThan(-1);
    expect(authenticatedMainIndex).toBeGreaterThan(releaseOrderIndex);
    expect(authenticatedTagIndex).toBeGreaterThan(authenticatedMainIndex);
    expect(prePublicationAdvertisementIndex).toBeGreaterThan(authenticatedTagIndex);
    expect(releasePostIndex).toBeGreaterThan(prePublicationAdvertisementIndex);
    expect(publishScript).not.toContain("GITHUB_REF_NAME");
    expect(publishScript).toContain('gh api --include "$release_endpoint"');
    expect(publishScript).toContain("inspect-release-response");
    expect(publishScript).toContain("validate-release");
    expect(publishScript).toContain("validate-latest-predecessor");
    expect(publishScript).toContain('wait-latest-release "$predecessor_release_file"');
    expect(publishScript).toContain("require-latest-release");
    expect(publishScript).toContain('validate-created-release "$created_release_file"');
    expect(publishScript).toContain("revalidate-latest-release");
    expect(publishScript).toContain("--method POST");
    expect(publishScript).toContain("-F generate_release_notes=true");
    expect(publishScript).toContain("-f make_latest=legacy");
    expect(publishScript).not.toContain("-f make_latest=true");
    expect(publishScript).not.toContain("gh release view");
    expect(publishScript).not.toContain("gh release create");
    const predecessorIndex = publishScript.indexOf("validate-latest-predecessor");
    const postIndex = publishScript.indexOf("--method POST");
    const convergenceIndex = publishScript.indexOf("wait-latest-release");
    const postwriteIndex = publishScript.indexOf(
      'verify_publication_authority postwrite "$terminal_main_sha"',
    );
    const terminalProjectionIndex = publishScript.indexOf("revalidate-latest-release");
    expect(predecessorIndex).toBeGreaterThan(-1);
    expect(predecessorIndex).toBeLessThan(postIndex);
    expect(convergenceIndex).toBeGreaterThan(postIndex);
    expect(postwriteIndex).toBeGreaterThan(convergenceIndex);
    expect(terminalProjectionIndex).toBeGreaterThan(postwriteIndex);
    for (const checkedSurface of publicDistEntrypoints) {
      expect(ciWorkflow).toContain(checkedSurface);
      expect(workflow).toContain(checkedSurface);
      expect(artifact).toContain(`"${checkedSurface}"`);
    }
    expect(artifact).toContain(
      '"src/providers/imessage-direct-install.ts"',
    );
    expect(await readFile(packageSmokeUrl, "utf8")).toContain(
      "private-missing-reviewed-imsg-canary",
    );

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

  test("idempotently publishes the immutable Latest release below protected main", async () => {
    const workflow = await readFile(releaseWorkflowUrl, "utf8");
    const script = workflowStepScript(workflow, "Publish verified GitHub Release");
    const directory = await mkdtemp(join(tmpdir(), "wrench-release-recovery-publish-"));
    const binaryDirectory = join(directory, "bin");
    const ghStub = join(binaryDirectory, "gh");
    const gitStub = join(binaryDirectory, "git");
    const commandLog = join(directory, "commands.log");
    const gitCommandLog = join(directory, "git-commands.log");
    const gitCallCount = join(directory, "git-call-count.txt");
    const peeledCommitSha = "2".repeat(40);
    const tagObjectSha = "3".repeat(40);
    expect(tagObjectSha).not.toBe(peeledCommitSha);

    try {
      await mkdir(binaryDirectory, { recursive: true });
      await mkdir(join(directory, "git-admin"), { recursive: true });
      await writeFile(gitStub, `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$GIT_COMMAND_LOG"
args="$*"
current_remote_main="$REMOTE_MAIN_SHA"
if [[ -f "$RELEASE_CREATED_STATE" && -n "$POST_CREATE_MAIN_SHA" ]]; then
  current_remote_main="$POST_CREATE_MAIN_SHA"
fi
if [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null rev-parse --verify HEAD^{commit}" ]]; then
  printf '%s\n' "$CHECKED_HEAD_SHA"
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null ls-remote --sort=refname --refs https://github.com/hraness/wrench.git refs/heads/main refs/tags/v*" ]]; then
  call_count=0
  if [[ -f "$GIT_CALL_COUNT" ]]; then read -r call_count < "$GIT_CALL_COUNT"; fi
  call_count=$((call_count + 1))
  printf '%s\n' "$call_count" > "$GIT_CALL_COUNT"
  main_sha="$current_remote_main"
  tag_oid="$REMOTE_TAG_OID"
  if [[ "$REMOTE_ADVERTISEMENT_MODE" == "main-drift" && "$call_count" == "2" ]]; then
    main_sha="$DRIFT_SHA"
  fi
  if [[ "$REMOTE_ADVERTISEMENT_MODE" == "tag-drift" && "$call_count" == "2" ]]; then
    tag_oid="$TAG_OBJECT_SHA"
  fi
  printf '%s\trefs/heads/main\n' "$main_sha"
  printf '%s\trefs/tags/%s\n' "$tag_oid" "$VERIFIED_TAG"
  if [[ "$REMOTE_ADVERTISEMENT_MODE" == "higher-stable" ]]; then
    printf '%s\trefs/tags/v0.16.3\n' "$REMOTE_MAIN_SHA"
  fi
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null for-each-ref --format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)" ]]; then
  if [[ -f "$IMPORTED_MAIN_STATE" ]]; then
    printf 'refs/wrench-release/publication-main\\0%s\\0commit\\0\\0\n' "$current_remote_main"
  fi
  if [[ -f "$IMPORTED_TAG_STATE" ]]; then
    printf 'refs/wrench-release/publication-tag\\0%s\\0commit\\0\\0\n' "$REMOTE_TAG_OID"
  fi
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null rev-parse --absolute-git-dir" ]]; then
  printf '%s\n' "$GIT_ADMIN_DIRECTORY"
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null rev-parse --git-path FETCH_HEAD" ]]; then
  printf '%s/FETCH_HEAD\n' "$GIT_ADMIN_DIRECTORY"
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null rev-parse --is-shallow-repository" ]]; then
  printf 'false\n'
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null fetch --no-tags --no-write-fetch-head --no-recurse-submodules https://github.com/hraness/wrench.git refs/heads/main:refs/wrench-release/publication-main refs/tags/$VERIFIED_TAG:refs/wrench-release/publication-tag" ]]; then
  : > "$IMPORTED_MAIN_STATE"
  : > "$IMPORTED_TAG_STATE"
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null merge-base --is-ancestor $VERIFIED_SHA refs/wrench-release/publication-main" ]]; then
  [[ "$ANCESTRY_MODE" == "valid" ]]
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null diff --quiet --no-ext-diff --no-textconv $VERIFIED_SHA refs/wrench-release/publication-main -- .github/workflows scripts/release-ref-authority.ts scripts/release-provider-outcome.mjs scripts/release-app-token.mjs scripts/release-ref-writer.mjs" ]]; then
  if [[ "$WORKFLOW_DRIFT_MODE" == "always" ||
        ( "$WORKFLOW_DRIFT_MODE" == "postwrite" && -f "$RELEASE_CREATED_STATE" ) ]]; then
    exit 1
  fi
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null update-ref -d refs/wrench-release/publication-main $current_remote_main" ]]; then
  rm -f "$IMPORTED_MAIN_STATE"
elif [[ "$args" == "-c credential.helper= -c core.hooksPath=/dev/null update-ref -d refs/wrench-release/publication-tag $REMOTE_TAG_OID" ]]; then
  rm -f "$IMPORTED_TAG_STATE"
else
  echo "unexpected git command: $args" >&2
  exit 1
fi
`, "utf8");
      await writeFile(ghStub, `#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$COMMAND_LOG"
args="$*"
current_authenticated_main="$AUTHENTICATED_MAIN_SHA"
current_latest_tag="$LATEST_TAG"
if [[ -f "$RELEASE_CREATED_STATE" ]]; then
  if [[ -n "$POST_CREATE_MAIN_SHA" ]]; then
    current_authenticated_main="$POST_CREATE_MAIN_SHA"
  fi
  current_latest_tag="\${POST_CREATE_LATEST_TAG:-$VERIFIED_TAG}"
elif [[ "$LOOKUP_MODE" == "missing" ]]; then
  current_latest_tag="$PRE_CREATE_LATEST_TAG"
fi
release_json() {
  printf '{"assets":[],"draft":false,"id":%s,"immutable":%s,"prerelease":false,"published_at":"2026-08-29T14:00:00Z","tag_name":"%s","target_commitish":"main"}' "$1" "$RELEASE_IMMUTABLE" "$VERIFIED_TAG"
}
latest_json() {
  local latest_id=9
  local published_at="2026-08-28T14:00:00Z"
  if [[ "$1" == "$VERIFIED_TAG" ]]; then
    latest_id="$RELEASE_ID"
    published_at="2026-08-29T14:00:00Z"
  fi
  printf '{"assets":[],"draft":false,"id":%s,"immutable":true,"prerelease":false,"published_at":"%s","tag_name":"%s","target_commitish":"main"}\n' "$latest_id" "$published_at" "$1"
}
if [[ "$args" == "api /repos/$GITHUB_REPOSITORY/commits/$VERIFIED_TAG --jq .sha" ||
     "$args" == "api /repos/$GITHUB_REPOSITORY/commits/tags/$VERIFIED_TAG --jq .sha" ||
     "$args" == "api /repos/$GITHUB_REPOSITORY/commits/refs/tags/$VERIFIED_TAG --jq .sha" ]]; then
  printf '%s\n' "$TAG_OBJECT_SHA"
elif [[ "$args" == "api /repos/$GITHUB_REPOSITORY/commits/refs%2Ftags%2F$VERIFIED_TAG --jq .sha" ]]; then
  printf '%s\n' "$AUTHENTICATED_TAG_SHA"
elif [[ "$args" == "api /repos/$GITHUB_REPOSITORY/git/ref/heads/$DEFAULT_BRANCH --jq .object.sha" ]]; then
  printf '%s\n' "$current_authenticated_main"
elif [[ "$args" == "api --include /repos/$GITHUB_REPOSITORY/releases/tags/$VERIFIED_TAG" ]]; then
  case "$LOOKUP_MODE" in
    existing)
      printf 'HTTP/2.0 200 OK\r\ndate: Sat, 29 Aug 2026 14:01:00 GMT\r\ncontent-type: application/json\r\n\r\n'
      release_json "$RELEASE_ID"
      ;;
    missing)
      printf 'HTTP/2.0 404 Not Found\r\ndate: Sat, 29 Aug 2026 14:01:00 GMT\r\ncontent-type: application/json\r\n\r\n{"message":"Not Found"}\n'
      exit 1
      ;;
    api-failure)
      printf 'HTTP/2.0 500 Internal Server Error\r\ndate: Sat, 29 Aug 2026 14:01:00 GMT\r\ncontent-type: application/json\r\n\r\n{"message":"failure"}\n'
      exit 1
      ;;
    malformed-404)
      printf 'HTTP/2.0 404 Not Found\r\ndate: Sat, 29 Aug 2026 14:01:00 GMT\r\ncontent-type: application/json\r\n\r\n{"message":"Forbidden"}\n'
      exit 1
      ;;
  esac
elif [[ "$args" == "api /repos/$GITHUB_REPOSITORY/releases/tags/$VERIFIED_TAG" ]]; then
  read_count=0
  if [[ -f "$RELEASE_READ_COUNT" ]]; then read -r read_count < "$RELEASE_READ_COUNT"; fi
  read_count=$((read_count + 1))
  printf '%s\n' "$read_count" > "$RELEASE_READ_COUNT"
  if [[ "$read_count" -ge 2 ]]; then : > "$TERMINAL_RELEASE_READ_STATE"; fi
  release_json "$RELEASE_ID"
elif [[ "$args" == *"/releases?per_page=100&page="* ]]; then
  page="\${args##*page=}"
  if [[ "$RELEASE_SCAN_MODE" == "max" && "$page" -le 5 ]]; then
    node -e 'const page = Number(process.argv[1]); process.stdout.write(JSON.stringify(Array.from({ length: 100 }, (_, index) => { const id = (page - 1) * 100 + index + 1; return { draft: true, id, prerelease: false, tag_name: "draft-" + String(id) }; })))' "$page"
  else
    printf '[]\n'
  fi
elif [[ "$args" == *"/releases/latest"* ]]; then
  if [[ -f "$TERMINAL_RELEASE_READ_STATE" && -n "$TERMINAL_LATEST_TAG" ]]; then
    current_latest_tag="$TERMINAL_LATEST_TAG"
  fi
  latest_json "$current_latest_tag"
elif [[ "$args" == *"api --method POST /repos/$GITHUB_REPOSITORY/releases"* ]]; then
  if [[ "$ALLOW_CREATE" != "true" ]]; then
    echo "recovery attempted to recreate an existing release" >&2
    exit 91
  fi
  : > "$RELEASE_CREATED_STATE"
  release_json "$CREATED_RELEASE_ID"
else
  echo "unexpected gh command: $args" >&2
  exit 1
fi
`, "utf8");
      await Promise.all([chmod(ghStub, 0o755), chmod(gitStub, 0o755)]);

      const baseEnvironment = Object.freeze({
        ANCESTRY_MODE: "valid",
        AUTHENTICATED_MAIN_SHA: peeledCommitSha,
        AUTHENTICATED_TAG_SHA: peeledCommitSha,
        COMMAND_LOG: commandLog,
        CHECKED_HEAD_SHA: peeledCommitSha,
        DEFAULT_BRANCH: "main",
        DRIFT_SHA: "4".repeat(40),
        GIT_CALL_COUNT: gitCallCount,
        GIT_ADMIN_DIRECTORY: join(directory, "git-admin"),
        GIT_COMMAND_LOG: gitCommandLog,
        GITHUB_REPOSITORY: "hraness/wrench",
        LATEST_TAG: "v0.16.2",
        PRE_CREATE_LATEST_TAG: "v0.16.1",
        LOOKUP_MODE: "existing",
        IMPORTED_MAIN_STATE: join(directory, "imported-main"),
        IMPORTED_TAG_STATE: join(directory, "imported-tag"),
        ALLOW_CREATE: "false",
        PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        POST_CREATE_LATEST_TAG: "",
        POST_CREATE_MAIN_SHA: "",
        CREATED_RELEASE_ID: "10",
        RELEASE_ID: "10",
        RELEASE_READ_COUNT: join(directory, "release-read-count"),
        RELEASE_IMMUTABLE: "true",
        RELEASE_CREATED_STATE: join(directory, "release-created"),
        RELEASE_SCAN_MODE: "empty",
        REMOTE_ADVERTISEMENT_MODE: "stable",
        REMOTE_MAIN_SHA: peeledCommitSha,
        REMOTE_TAG_OID: peeledCommitSha,
        TAG_OBJECT_SHA: tagObjectSha,
        TERMINAL_LATEST_TAG: "",
        TERMINAL_RELEASE_READ_STATE: join(directory, "terminal-release-read"),
        VERIFIED_SHA: peeledCommitSha,
        VERIFIED_TAG: "v0.16.2",
        WORKFLOW_DRIFT_MODE: "stable",
      });
      const runCase = async (
        overrides: Readonly<Record<string, string>>,
      ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
        await rm(commandLog, { force: true });
        await rm(gitCommandLog, { force: true });
        await rm(gitCallCount, { force: true });
        await rm(baseEnvironment.IMPORTED_MAIN_STATE, { force: true });
        await rm(baseEnvironment.IMPORTED_TAG_STATE, { force: true });
        await rm(baseEnvironment.RELEASE_CREATED_STATE, { force: true });
        await rm(baseEnvironment.RELEASE_READ_COUNT, { force: true });
        await rm(baseEnvironment.TERMINAL_RELEASE_READ_STATE, { force: true });
        return runWorkflowScript(script, { ...baseEnvironment, ...overrides });
      };

      const existing = await runCase({});
      expect(existing.exitCode, `${existing.stdout}\n${existing.stderr}`).toBe(0);
      const existingCommands = await readFile(commandLog, "utf8");
      for (const ambiguousEndpoint of providerAmbiguousTagCommitEndpoints) {
        expect(existingCommands).not.toContain(`api ${ambiguousEndpoint} --jq .sha`);
      }
      expect(existingCommands).not.toContain("--method POST");
      expect(existingCommands.match(/\/releases\/latest/gu) ?? []).toHaveLength(2);
      expect((await readFile(gitCommandLog, "utf8")).match(/ls-remote --sort=refname --refs/gu) ?? [])
        .toHaveLength(2);

      const created = await runCase({ ALLOW_CREATE: "true", LOOKUP_MODE: "missing" });
      expect(created.exitCode).toBe(0);
      const createCommands = await readFile(commandLog, "utf8");
      expect(createCommands).toContain("--method POST");
      expect(createCommands).toContain("generate_release_notes=true");
      expect(createCommands).toContain("target_commitish=2222222222222222222222222222222222222222");
      expect(createCommands.match(/\/releases\/latest/gu) ?? []).toHaveLength(3);
      expect((await readFile(gitCommandLog, "utf8")).match(/ls-remote --sort=refname --refs/gu) ?? [])
        .toHaveLength(4);
      const createdAtAuditCap = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        RELEASE_SCAN_MODE: "max",
      });
      expect(createdAtAuditCap.exitCode).toBe(0);
      const maxCreateCommands = (await readFile(commandLog, "utf8")).trim().split("\n");
      expect(maxCreateCommands).toHaveLength(19);
      for (let page = 1; page <= 6; page += 1) {
        expect(maxCreateCommands.filter((command) =>
          command === `api /repos/${providerRepository}/releases?per_page=100&page=${String(page)}`
        )).toHaveLength(1);
      }
      expect(maxCreateCommands.filter((command) => command.includes("--method POST")))
        .toHaveLength(1);
      const movedMain = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        REMOTE_MAIN_SHA: "4".repeat(40),
      });
      expect(movedMain.exitCode).not.toBe(0);
      expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");

      const descendantMain = await runCase({
        ALLOW_CREATE: "true",
        AUTHENTICATED_MAIN_SHA: "4".repeat(40),
        LOOKUP_MODE: "missing",
        REMOTE_MAIN_SHA: "4".repeat(40),
      });
      expect(descendantMain.exitCode, `${descendantMain.stdout}\n${descendantMain.stderr}`)
        .toBe(0);
      expect(await readFile(commandLog, "utf8")).toContain("--method POST");

      const postPrewriteDescendant = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        POST_CREATE_MAIN_SHA: "4".repeat(40),
      });
      expect(
        postPrewriteDescendant.exitCode,
        `${postPrewriteDescendant.stdout}\n${postPrewriteDescendant.stderr}`,
      ).toBe(0);
      const postPrewriteCommands = await readFile(commandLog, "utf8");
      const postPrewriteGitCommands = await readFile(gitCommandLog, "utf8");
      expect(postPrewriteCommands).toContain("--method POST");
      expect(postPrewriteGitCommands).toContain(
        `update-ref -d refs/wrench-release/publication-main ${"4".repeat(40)}`,
      );
      expect(postPrewriteGitCommands.match(/ls-remote --sort=refname --refs/gu) ?? [])
        .toHaveLength(4);
      expect(postPrewriteGitCommands.match(
        /diff --quiet --no-ext-diff --no-textconv .* refs\/wrench-release\/publication-main -- \.github\/workflows scripts\/release-ref-authority\.ts scripts\/release-provider-outcome\.mjs scripts\/release-app-token\.mjs scripts\/release-ref-writer\.mjs/gu,
      ) ?? []).toHaveLength(2);

      const prewriteWorkflowDrift = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        WORKFLOW_DRIFT_MODE: "always",
      });
      expect(prewriteWorkflowDrift.exitCode).not.toBe(0);
      expect(`${prewriteWorkflowDrift.stdout}\n${prewriteWorkflowDrift.stderr}`)
        .toContain("different release-control definitions at prewrite");
      expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");

      const postwriteWorkflowDrift = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        WORKFLOW_DRIFT_MODE: "postwrite",
      });
      expect(postwriteWorkflowDrift.exitCode).not.toBe(0);
      expect(`${postwriteWorkflowDrift.stdout}\n${postwriteWorkflowDrift.stderr}`)
        .toContain("different release-control definitions at postwrite");
      const postwriteDriftCommands = await readFile(commandLog, "utf8");
      expect(postwriteDriftCommands).toContain("--method POST");
      expect(postwriteDriftCommands).not.toContain("--method DELETE");
      expect(postwriteDriftCommands).not.toContain("--method PATCH");

      const concurrentSupersession = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        POST_CREATE_LATEST_TAG: "v0.16.3",
      });
      expect(concurrentSupersession.exitCode).not.toBe(0);
      expect(`${concurrentSupersession.stdout}\n${concurrentSupersession.stderr}`)
        .toContain("changed from the pinned predecessor");
      const supersessionCommands = await readFile(commandLog, "utf8");
      expect(supersessionCommands).toContain("--method POST");
      expect(supersessionCommands).not.toContain("--method DELETE");
      expect(supersessionCommands).not.toContain("--method PATCH");

      const arbitraryOlderLatest = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        POST_CREATE_LATEST_TAG: "v0.16.0",
      });
      expect(arbitraryOlderLatest.exitCode).not.toBe(0);
      expect(`${arbitraryOlderLatest.stdout}\n${arbitraryOlderLatest.stderr}`)
        .toContain("changed from the pinned predecessor");

      const createdReleaseDrift = await runCase({
        ALLOW_CREATE: "true",
        CREATED_RELEASE_ID: "11",
        LOOKUP_MODE: "missing",
      });
      expect(createdReleaseDrift.exitCode).not.toBe(0);
      expect(`${createdReleaseDrift.stdout}\n${createdReleaseDrift.stderr}`)
        .toContain("does not bind the immutable target Release");

      const terminalLatestDrift = await runCase({ TERMINAL_LATEST_TAG: "v0.16.3" });
      expect(terminalLatestDrift.exitCode).not.toBe(0);
      expect(`${terminalLatestDrift.stdout}\n${terminalLatestDrift.stderr}`)
        .toContain("is no longer Latest");

      const divergentMain = await runCase({
        ALLOW_CREATE: "true",
        ANCESTRY_MODE: "invalid",
        AUTHENTICATED_MAIN_SHA: "4".repeat(40),
        LOOKUP_MODE: "missing",
        REMOTE_MAIN_SHA: "4".repeat(40),
      });
      expect(divergentMain.exitCode).not.toBe(0);
      expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");

      for (const overrides of [
        { AUTHENTICATED_MAIN_SHA: "4".repeat(40) },
        { AUTHENTICATED_TAG_SHA: "4".repeat(40) },
      ] as const) {
        const rejected = await runCase({
          ...overrides,
          ALLOW_CREATE: "true",
          LOOKUP_MODE: "missing",
        });
        expect(rejected.exitCode).not.toBe(0);
        expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");
      }

      const lookupFailure = await runCase({ LOOKUP_MODE: "api-failure" });
      expect(lookupFailure.exitCode).not.toBe(0);
      expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");

      const falseAbsence = await runCase({ LOOKUP_MODE: "malformed-404" });
      expect(falseAbsence.exitCode).not.toBe(0);
      expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");

      const tagObjectTarget = await runCase({ REMOTE_TAG_OID: tagObjectSha });
      expect(tagObjectTarget.exitCode).not.toBe(0);
      expect(`${tagObjectTarget.stdout}${tagObjectTarget.stderr}`)
        .toContain("direct lightweight release tag");
      expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");

      for (const remoteAdvertisementMode of [
        "main-drift",
        "tag-drift",
      ] as const) {
        const rejected = await runCase({
          ALLOW_CREATE: "true",
          LOOKUP_MODE: "missing",
          REMOTE_ADVERTISEMENT_MODE: remoteAdvertisementMode,
        });
        expect(rejected.exitCode).not.toBe(0);
        expect(await readFile(commandLog, "utf8")).not.toContain("--method POST");
      }

      const queuedHigherTag = await runCase({
        ALLOW_CREATE: "true",
        LOOKUP_MODE: "missing",
        REMOTE_ADVERTISEMENT_MODE: "higher-stable",
      });
      expect(queuedHigherTag.exitCode, `${queuedHigherTag.stdout}\n${queuedHigherTag.stderr}`)
        .toBe(0);
      expect(await readFile(commandLog, "utf8")).toContain("--method POST");

      for (const [overrides, message] of [
        [{ RELEASE_IMMUTABLE: "false" }, "is not exact, published, immutable, and asset-free"],
        [{ LATEST_TAG: "v0.16.1" }, "is no longer Latest"],
        [{ VERIFIED_TAG: "v0.16.2\npoison" }, "no verified stable release tag"],
      ] as const) {
        const rejected = await runCase(overrides);
        expect(rejected.exitCode).not.toBe(0);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain(message);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  test("keeps provider verification read-only, terminal, and release-authoritative", async () => {
    const [releaseWorkflow, workflow, helper, appHelper, writerHelper, codeowners] = await Promise.all([
      readFile(releaseWorkflowUrl, "utf8"),
      readFile(websiteProductionWorkflowUrl, "utf8"),
      readFile(providerOutcomeHelperUrl, "utf8"),
      readFile(releaseAppTokenHelperUrl, "utf8"),
      readFile(releaseRefWriterHelperUrl, "utf8"),
      readFile(codeownersUrl, "utf8"),
    ]);
    const job = (name: string): string => {
      const start = workflow.indexOf(`\n  ${name}:\n`);
      if (start < 0) throw new Error(`Workflow job not found: ${name}`);
      const nextJob = /\n  [a-z][a-z_]*:\n/gu;
      nextJob.lastIndex = start + `\n  ${name}:\n`.length;
      const next = nextJob.exec(workflow)?.index ?? -1;
      return workflow.slice(start, next < 0 ? undefined : next);
    };
    const baselineJob = job("provider_baseline");
    const advanceJob = job("advance_production_ref");
    const existingJob = job("confirm_existing_production_ref");
    const selectionJob = job("select_promotion");
    const providerJob = job("provider_outcome");
    const permissions = (jobText: string): readonly string[] => {
      const match = /\n    permissions:\n((?:      [a-z-]+: (?:read|write)\n)+)/u.exec(jobText);
      if (match?.[1] === undefined) throw new Error("Workflow job has no exact permission block");
      return match[1].trim().split("\n").map((line) => line.trim()).sort();
    };

    for (const exactNodeJob of [baselineJob, advanceJob, existingJob, providerJob]) {
      expect(exactNodeJob).toContain("node-version: \"24\"");
      expect(exactNodeJob).toContain("package-manager-cache: false");
    }

    expect(workflow.indexOf("\n  provider_baseline:\n"))
      .toBeLessThan(workflow.indexOf("\n  advance_production_ref:\n"));
    expect(workflow.indexOf("\n  select_promotion:\n"))
      .toBeLessThan(workflow.indexOf("\n  provider_outcome:\n"));
    expect(baselineJob).toContain("needs: verify");
    expect(permissions(baselineJob)).toEqual(["contents: read", "deployments: read"]);
    expect(baselineJob).not.toContain("contents: write");
    expect(baselineJob).toContain("release-provider-outcome.mjs baseline");
    expect(baselineJob).toContain("advance_required:");
    expect(permissions(advanceJob)).toEqual(["contents: read"]);
    expect(advanceJob).toContain("environment: { name: production-ref-writer-key, deployment: false }");
    expect(advanceJob).toContain("needs.provider_baseline.outputs.advance_required == 'true'");
    expect(advanceJob).toContain("WRENCH_RELEASE_APP_PRIVATE_KEY");
    expect(advanceJob).toContain("PROMOTION_EXPECTED_MODE: advanced");
    expect(advanceJob).toContain("release-provider-outcome.mjs promote");
    expect(permissions(existingJob)).toEqual(["contents: read"]);
    expect(existingJob).toContain("needs.provider_baseline.outputs.advance_required == 'false'");
    expect(existingJob).toContain("PROMOTION_EXPECTED_MODE: already-exact");
    expect(existingJob).not.toContain("environment:");
    expect(existingJob).not.toContain("WRENCH_RELEASE_APP_");
    expect(selectionJob).toContain("Bind exactly one promotion path");
    expect(selectionJob).toContain("ADVANCE_RESULT");
    expect(selectionJob).toContain("EXISTING_RESULT");
    expect(providerJob).toContain("timeout-minutes: 30");
    expect(providerJob).toContain(
      "if: >-\n" +
        "      ${{ !cancelled() &&\n" +
        "          needs.verify.result == 'success' &&\n" +
        "          needs.provider_baseline.result == 'success' &&\n" +
        "          needs.select_promotion.result == 'success' }}",
    );
    expect(providerJob).not.toContain("always()");
    expect(permissions(providerJob)).toEqual(["contents: read", "deployments: read"]);
    expect(providerJob).not.toContain("contents: write");
    expect(providerJob).not.toContain("continue-on-error");
    expect(providerJob).toContain("release-provider-outcome.mjs wait");
    expect(providerJob).toContain("needs.select_promotion.outputs.receipt");
    expect(providerJob).toContain("VERIFIED_SHA: ${{ needs.verify.outputs.verified_sha }}");
    expect(providerJob).toContain("VERIFIED_TAG: ${{ needs.verify.outputs.verified_tag }}");
    expect(providerJob).toContain("DEFAULT_BRANCH: main");
    expect(providerJob).toContain("EVENT_NAME: ${{ github.event_name }}");
    expect(providerJob).toContain(
      "RECOVERY_WORKFLOW_SHA: ${{ needs.verify.outputs.workflow_sha }}",
    );
    expect(helper).toContain("defaultBranch: process.env.DEFAULT_BRANCH");
    expect(helper).toContain("eventName: process.env.EVENT_NAME");
    expect(helper).toContain("recoveryWorkflowSha: process.env.RECOVERY_WORKFLOW_SHA");
    expect(workflow.match(/ref: \$\{\{ needs\.verify\.outputs\.workflow_sha \}\}/gu)).toHaveLength(4);
    expect(releaseWorkflow).not.toContain("provider_baseline:");
    expect(releaseWorkflow).not.toContain("provider_outcome:");
    expect(releaseWorkflow).not.toContain("release-provider-outcome.mjs promote");
    expect(releaseWorkflow).not.toContain("website-production");
    expect(releaseWorkflow).not.toContain("WRENCH_RELEASE_APP_");
    expect(releaseWorkflow.match(/contents: write/gu) ?? []).toHaveLength(1);
    const workflowWriters: string[] = [];
    let contentsWriteOccurrences = 0;
    for (const filename of (await readdir(workflowsUrl)).filter((name) => name.endsWith(".yml")).sort()) {
      const source = await readFile(new URL(filename, workflowsUrl), "utf8");
      contentsWriteOccurrences += source.match(/contents:\s*write/gu)?.length ?? 0;
      expect(source).not.toMatch(/permissions:\s*write-all/u);
      const jobsStart = source.indexOf("\njobs:\n");
      expect(jobsStart).toBeGreaterThan(0);
      const workflowHeader = source.slice(0, jobsStart);
      expect(workflowHeader.match(/^  contents: (?:read|write)$/gmu) ?? [])
        .toEqual(["  contents: read"]);
      const jobs = source.slice(jobsStart + "\njobs:\n".length);
      const markers = [...jobs.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):$/gmu)];
      const jobNames = markers.map((marker) => marker[1]);
      expect(new Set(jobNames).size).toBe(jobNames.length);
      for (const [index, marker] of markers.entries()) {
        const name = marker[1];
        if (name === undefined || marker.index === undefined) continue;
        const next = markers[index + 1]?.index ?? jobs.length;
        const jobSource = jobs.slice(marker.index, next);
        const writes = jobSource.match(/^      contents: write$/gmu) ?? [];
        expect(writes.length).toBeLessThanOrEqual(1);
        if (writes.length === 1) workflowWriters.push(`${filename}:${name}`);
      }
    }
    expect(workflowWriters).toEqual(["release.yml:publish"]);
    expect(contentsWriteOccurrences).toBe(1);
    expect(workflow).not.toContain("VERCEL_TOKEN");
    expect(workflow).not.toContain("projectSettings");
    expect(workflow).not.toContain("redeploy");
    expect(workflow).not.toContain("api.vercel.com");
    expect(workflow).not.toContain("autoAssignCustomDomains");
    expect(workflow).not.toContain("vercel alias");
    expect(workflow).not.toContain("vercel promote");
    expect(helper).not.toContain("--jq");
    expect(helper).not.toContain("@tsv");
    expect(helper).toContain("MAX_ITEMS = 500");
    expect(helper).toContain("MAX_GRAPHQL_DEPLOYMENT_PAGES = 5");
    expect(helper).toContain("MAX_GRAPHQL_COST_PER_REQUEST = 2");
    expect(helper).toContain("rateLimit { cost remaining resetAt }");
    expect(helper).toContain("totalCount");
    expect(helper).toContain("MAX_PROVIDER_POLLS = 20");
    expect(helper).toContain("PROVIDER_POLL_INTERVAL_MILLISECONDS = 60_000");
    expect(helper).toContain("PROVIDER_OBSERVATION_DEADLINE_MILLISECONDS = 20 * 60_000");
    expect(helper).toContain("PROVIDER_API_CALL_TIMEOUT_MILLISECONDS = 60_000");
    expect(helper).toContain("MAX_SLEEP_ATTEMPTS_PER_INTERVAL = 16");
    expect(helper).toContain("timeout: timeoutMilliseconds");
    expect(helper).toContain("state.remainingMilliseconds < 1");
    expect(helper).toContain("after.now <= before.now");
    expect(helper).toContain('deadline.begin("begin provider success confirmation")');
    expect(helper).toContain("deadline.startedAt + nextObservationIndex * pollIntervalMilliseconds");
    expect(helper).toContain("if (poll < maxPolls)");
    expect(helper).toContain("{ allowDeadlineTarget: true }");
    expect(helper).not.toContain('deadline.complete("complete provider success confirmation")');
    expect(helper).not.toContain("Date.now");
    expect(helper).toContain("performance.now()");
    expect(helper).toContain('this.#runRaw(["--include", endpoint]');
    expect(releaseWorkflow).toContain("release-provider-outcome.mjs release-order");
    expect(workflow).not.toContain("gh api --paginate");
    expect(helper).toContain('mode = "already-exact"');
    expect(helper).toContain('mode = "advanced"');
    expect(helper).toContain("35613825");
    expect(helper).toContain("encodeURIComponent(`refs/tags/${tag}`)");
    expect(helper).not.toContain("/commits/tags/");
    expect(helper).not.toContain("head_commit");
    expect(helper).not.toContain("target_commitish");
    expect(helper).toContain("advanceWebsiteProductionRefFromEnvironment");
    expect(helper).toContain('key.startsWith("WRENCH_RELEASE_APP_")');
    expect(scrubReadOnlyGithubEnvironment({
      GH_TOKEN: "read-token",
      PATH: "/usr/bin:/bin",
      WRENCH_RELEASE_APP_ID: "123",
      WRENCH_RELEASE_APP_PRIVATE_KEY: "private",
      WRENCH_RELEASE_APP_TOKEN: "installation-token",
    })).toEqual({ GH_TOKEN: "read-token", PATH: "/usr/bin:/bin" });
    expect(helper).toContain("/git/ref/heads/website-production");
    expect(helper).not.toContain("/git/refs/heads/website-production");
    expect(helper).not.toContain('async patch(');
    expect(helper).not.toContain("matching-refs");
    expect(helper).not.toContain("api.post");
    expect(helper).not.toContain('["--method", "POST"');
    for (const forbiddenControlEndpoint of ["/rulesets", "/rule-suites"] as const) {
      expect(`${workflow}\n${helper}\n${appHelper}\n${writerHelper}`)
        .not.toContain(forbiddenControlEndpoint);
    }
    expect(workflow).not.toContain("WRENCH_RELEASE_APP_RULESET");
    expect(appHelper).toContain("repository_ids: Object.freeze([WRENCH_REPOSITORY_ID])");
    expect(appHelper).toContain('["contents", "metadata", "workflows"]');
    expect(appHelper).toContain('workflows: "write"');
    expect(appHelper).toContain("MAX_RESPONSE_BYTES = 1024 * 1024");
    expect(appHelper).toContain("response.body.getReader()");
    expect(appHelper).not.toContain("response.arrayBuffer()");
    expect(appHelper).not.toContain("administration");
    expect(writerHelper).toContain(
      '`--force-with-lease=${PRODUCTION_REF}:${expectedOld}`',
    );
    expect(writerHelper).toContain("verifiedReleaseFetchArguments");
    expect(writerHelper).toContain('`refs/tags/${tag}`');
    expect(writerHelper).toContain('"FETCH_HEAD^{commit}"');
    expect(writerHelper).toContain('resolved.stdout !== `${verifiedSha}\\n`');
    expect(writerHelper).toContain("does not peel to the verified release SHA");
    expect(writerHelper).toContain('const FIXED_REMOTE = "https://github.com/hraness/wrench.git"');
    expect(writerHelper).toContain('GIT_ASKPASS_REQUIRE: "force"');
    expect(writerHelper).not.toContain("--force\"");
    expect(codeowners.trim().split("\n")).toEqual([
      "/.github/workflows/** @0thernet",
      "/.github/CODEOWNERS @0thernet",
      "/scripts/release-* @0thernet",
      "/docs/publishing.md @0thernet",
    ]);
    expect(releaseRestRequestBudget).toEqual({
      githubTokenLimit: 1_000,
      headroom: 656,
      immutableRelease: 30,
      maxPolls: 20,
      observationDeadlineMilliseconds: 1_200_000,
      perCallTimeoutMilliseconds: 60_000,
      pollIntervalMilliseconds: 60_000,
      providerBaseline: 2,
      providerOutcome: 209,
      providerPromotion: 21,
      surroundingRelease: 112,
      total: 344,
      websiteAuthority: 82,
    });
    expect(releaseGraphqlRequestBudget).toEqual({
      githubPointLimit: 1_000,
      headroom: 760,
      maxCostPerRequest: 2,
      maxPoints: 240,
      providerBaseline: 10,
      providerOutcome: 110,
      totalRequests: 120,
    });
    expect(releaseRestRequestBudget.total).toBeLessThan(400);
    expect(releaseGraphqlRequestBudget.maxPoints).toBeLessThanOrEqual(250);
  });

  test("mints only one exact Wrench release-App token and always revokes it", async () => {
    const releaseAppTokenSource = await readFile(releaseAppTokenHelperUrl, "utf8");
    expect(createHash("sha256").update(releaseAppTokenSource).digest("hex")).toBe(
      "56c89960c6cdfadd7e34cd2b64bfa022a3884aedf73187016f9e5b7cd6ac3cb6",
    );
    const revokeWithFetchSource = `async function revokeWithFetch(input) {
  return revokeReleaseAppTokenWithConvergence({
    apiUrl: input.apiUrl,
    expiresAt: input.expiresAt,
    token: input.token,
  });
}`;
    expect(releaseAppTokenSource.match(/^async function revokeWithFetch\(input\) \{$/gmu) ?? [])
      .toHaveLength(1);
    expect(releaseAppTokenSource.match(/return revokeReleaseAppTokenWithConvergence\(/gu) ?? [])
      .toHaveLength(1);
    expect(releaseAppTokenSource).toContain(revokeWithFetchSource);
    const environmentWrapperStart = releaseAppTokenSource.indexOf(
      "export function withReleaseAppTokenFromEnvironment",
    );
    expect(environmentWrapperStart).toBeGreaterThan(0);
    const environmentWrapperSource = releaseAppTokenSource.slice(environmentWrapperStart);
    expect(environmentWrapperSource.trimEnd()).toBe(`export function withReleaseAppTokenFromEnvironment(environment, operation, onRevoked) {
  return withReleaseAppToken({
    environment,
    inspect: inspectWithFetch,
    inspectInstallation: inspectInstallationWithFetch,
    mask(token) {
      process.stdout.write(\`::add-mask::\${token}\\n\`);
    },
    mint: mintWithFetch,
    nowMilliseconds: Date.now,
    onRevoked,
    revoke: revokeWithFetch,
  }, operation);
}`);
    expect(withReleaseAppTokenFromEnvironment.length).toBe(3);
    expect(releaseAppTokenSource.match(/^    revoke: revokeWithFetch,$/gmu) ?? [])
      .toHaveLength(1);
    const revocationImplementationStart = releaseAppTokenSource.indexOf(
      "function revocationIndeterminate",
    );
    const revocationImplementationEnd = releaseAppTokenSource.indexOf(
      "\nasync function revokeWithFetch",
      revocationImplementationStart,
    );
    expect(revocationImplementationStart).toBeGreaterThan(0);
    expect(revocationImplementationEnd).toBeGreaterThan(revocationImplementationStart);
    const revocationImplementationSource = releaseAppTokenSource.slice(
      revocationImplementationStart,
      revocationImplementationEnd,
    );
    expect(createHash("sha256").update(revocationImplementationSource).digest("hex")).toBe(
      "d33def2bf83f6166d0048e5715eec79076c25ef92af602729a9e4d1bc3410cb4",
    );
    expect(revocationImplementationSource.match(/input\.fetchImplementation/gu) ?? [])
      .toHaveLength(3);
    expect(revocationImplementationSource).toContain(
      "const fetchImplementation = input.fetchImplementation ?? fetch;",
    );

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" },
    });
    const environment = Object.freeze({
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: providerRepository,
      GITHUB_REPOSITORY_ID: String(WRENCH_REPOSITORY_ID),
      GITHUB_REPOSITORY_OWNER: "hraness",
      WRENCH_RELEASE_APP_CLIENT_ID: "Iv23liWrenchWriter",
      WRENCH_RELEASE_APP_ID: "123456",
      WRENCH_RELEASE_APP_INSTALLATION_ID: "654321",
      WRENCH_RELEASE_APP_PRIVATE_KEY: privateKey,
      WRENCH_RELEASE_APP_SLUG: "wrench-prod-ref-writer-1316443113",
    });
    const configuration = parseReleaseAppConfiguration(environment);
    expect(configuration.repositoryId).toBe(1_316_443_113);
    expect(releaseAppTokenRequestBody()).toEqual({
      permissions: { contents: "write", metadata: "read", workflows: "write" },
      repository_ids: [1_316_443_113],
    });

    const jwt = createReleaseAppJwt({
      clientId: configuration.clientId,
      nowMilliseconds: Date.parse("2026-08-30T01:00:00Z"),
      privateKey,
    });
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))).toEqual({
      exp: 1_788_052_080,
      iat: 1_788_051_540,
      iss: "Iv23liWrenchWriter",
    });
    expect(verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`, "ascii"),
      publicKey,
      Buffer.from(signature ?? "", "base64url"),
    )).toBe(true);

    const appIdentity = {
      client_id: configuration.clientId,
      id: configuration.appId,
      owner: { login: "hraness", type: "Organization" },
      permissions: { contents: "write", metadata: "read", workflows: "write" },
      slug: configuration.appSlug,
    };
    const installation = {
      account: { login: "hraness", type: "Organization" },
      app_id: configuration.appId,
      app_slug: configuration.appSlug,
      id: configuration.installationId,
      permissions: { contents: "write", metadata: "read", workflows: "write" },
      repository_selection: "selected",
      target_type: "Organization",
    };
    const token = "ghs_exact-wrench-release-token";
    const response = {
      expires_at: "2026-08-30T02:00:00Z",
      permissions: { contents: "write", metadata: "read", workflows: "write" },
      repositories: [{
        full_name: providerRepository,
        id: WRENCH_REPOSITORY_ID,
        name: "wrench",
        owner: { login: "hraness" },
      }],
      repository_selection: "selected",
      token,
    };
    const firstTwoDenialsReceipt = Object.freeze({
      converged: true,
      observationCount: 2,
      propagationObserved: false,
      stableDenials: 2,
    });
    expect(() => parseReleaseAppIdentity(appIdentity, configuration)).not.toThrow();
    expect(() => parseReleaseAppInstallation(installation, configuration)).not.toThrow();
    for (const permissions of [
      { contents: "write", metadata: "read" },
      { contents: "write", metadata: "read", workflows: "read" },
      {
        administration: "write",
        contents: "write",
        metadata: "read",
        workflows: "write",
      },
    ] as const) {
      expect(() => parseReleaseAppIdentity(
        { ...appIdentity, permissions },
        configuration,
      )).toThrow();
      expect(() => parseReleaseAppInstallation(
        { ...installation, permissions },
        configuration,
      )).toThrow();
    }
    expect(parseReleaseAppTokenResponse(
      response,
      "Sun, 30 Aug 2026 01:00:00 GMT",
    )).toEqual({
      expiresAt: "2026-08-30T02:00:00Z",
      permissions: { contents: "write", metadata: "read", workflows: "write" },
      repositoryId: WRENCH_REPOSITORY_ID,
      token,
    });
    expect(parseReleaseAppTokenResponse({
      ...response,
      has_multiple_single_files: false,
      single_file: null,
      single_file_paths: [],
    }, "Sun, 30 Aug 2026 01:00:00 GMT")).toEqual({
      expiresAt: "2026-08-30T02:00:00Z",
      permissions: { contents: "write", metadata: "read", workflows: "write" },
      repositoryId: WRENCH_REPOSITORY_ID,
      token,
    });

    const events: string[] = [];
    const result = await withReleaseAppToken({
      environment,
      async inspect() {
        events.push("inspect");
        return appIdentity;
      },
      async inspectInstallation() {
        events.push("installation");
        return installation;
      },
      mask(value: string) {
        events.push(`mask:${value}`);
      },
      async mint(input: Readonly<{ body: unknown }>) {
        events.push(`mint:${JSON.stringify(input.body)}`);
        return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" };
      },
      nowMilliseconds() {
        return Date.parse("2026-08-30T01:00:00Z");
      },
      async revoke(input: Readonly<{ token: string }>) {
        events.push(`revoke:${input.token}`);
        return firstTwoDenialsReceipt;
      },
    }, async (value: string, receipt: Readonly<{ repositoryId: number }>) => {
      events.push(`operate:${value}`);
      expect(receipt.repositoryId).toBe(WRENCH_REPOSITORY_ID);
      return "advanced";
    });
    expect(result).toBe("advanced");
    expect(events).toEqual([
      "inspect",
      "installation",
      `mint:${JSON.stringify(releaseAppTokenRequestBody())}`,
      `mask:${token}`,
      `operate:${token}`,
      `revoke:${token}`,
    ]);

    const repositoryBody = Object.freeze({
      repositories: [{
        full_name: providerRepository,
        id: WRENCH_REPOSITORY_ID,
        name: "wrench",
        owner: { login: "hraness" },
      }],
      repository_selection: "selected",
      total_count: 1,
    });
    type RevocationObservation = Readonly<{
      body?: "binary" | "empty" | "invalid-json" | "json" | "overflow" | "pending" | "text" | "wrong-repo";
      bodyText?: string;
      bodyLatencyMilliseconds?: number;
      contentLength?: string;
      date?: string;
      fetchLatencyMilliseconds?: number;
      location?: string;
      networkFailure?: "abort" | "pending" | true;
      omitDate?: boolean;
      redirected?: boolean;
      requestId?: string;
      status: number;
    }>;
    const observation = (
      status: number,
      overrides: Omit<RevocationObservation, "status"> = {},
    ): RevocationObservation => Object.freeze({ status, ...overrides });
    const stableDenials = [observation(401, { body: "empty" }), observation(401, { body: "json" })];

    function createRevocationHarness(
      observations: readonly RevocationObservation[],
      overrides: Readonly<{
        auditEvents?: string[];
        deleteObservation?: RevocationObservation;
        initialClock?: number;
        nowSamples?: readonly number[];
        sleepMode?: "frozen" | "overflow" | "partial" | "regress" | "reject";
      }> = {},
    ) {
      let clock = overrides.initialClock ?? 0;
      let nowSampleIndex = 0;
      let deleted = false;
      let observationIndex = 0;
      const calls: string[] = [];
      const callTimes: number[] = [];
      let cancelledBodies = 0;
      const sourceChunks: Uint8Array[] = [];
      const sleepCalls: number[] = [];
      const timeouts: number[] = [];
      const encoder = new TextEncoder();
      const defaultDate = "Sun, 30 Aug 2026 01:00:01 GMT";
      const responseFor = async (item: RevocationObservation, signal?: AbortSignal | null): Promise<Response> => {
        if (item.networkFailure === "abort") {
          throw new DOMException(`aborted ${token}`, "AbortError");
        }
        if (item.networkFailure === "pending") {
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new DOMException(`aborted ${token}`, "AbortError"));
            if (signal?.aborted === true) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        if (item.networkFailure === true) {
          throw new Error(`network leaked ${token}`);
        }
        clock += item.fetchLatencyMilliseconds ?? 1;
        let bytes: Uint8Array;
        switch (item.body) {
          case "empty":
            bytes = new Uint8Array();
            break;
          case "text":
            bytes = encoder.encode(item.bodyText ?? "denied");
            break;
          case "binary":
            bytes = new Uint8Array([0xff, 0xfe, 0xfd]);
            break;
          case "invalid-json":
            bytes = encoder.encode("{");
            break;
          case "overflow":
            bytes = encoder.encode("bounded");
            break;
          case "pending":
            bytes = new Uint8Array();
            break;
          case "json":
            bytes = encoder.encode(JSON.stringify({ message: "Bad credentials" }));
            break;
          case "wrong-repo":
            bytes = encoder.encode(JSON.stringify({
              ...repositoryBody,
              repositories: [{
                ...repositoryBody.repositories[0],
                full_name: "hraness/other",
                id: 1,
                name: "other",
              }],
            }));
            break;
          default:
            bytes = item.status === 200
              ? encoder.encode(JSON.stringify(repositoryBody))
              : encoder.encode(JSON.stringify({ message: "Bad credentials" }));
            break;
        }
        const headers: Record<string, string> = {};
        if (item.omitDate !== true) headers.Date = item.date ?? defaultDate;
        if (item.contentLength !== undefined) headers["Content-Length"] = item.contentLength;
        else if (item.body === "overflow") headers["Content-Length"] = String(1024 * 1024 + 1);
        if (item.location !== undefined) headers.Location = item.location;
        if (item.requestId !== undefined) headers["X-GitHub-Request-Id"] = item.requestId;
        const hasForbidden204Body = item.status === 204 && item.body !== undefined && item.body !== "empty";
        const body = item.status === 204 && !hasForbidden204Body ? null : new ReadableStream<Uint8Array>({
          cancel() { cancelledBodies += 1; },
          start(controller) {
            clock += item.bodyLatencyMilliseconds ?? 0;
            if (item.body === "pending") {
              const abort = () => controller.error(new DOMException(`aborted ${token}`, "AbortError"));
              if (signal?.aborted === true) abort();
              else signal?.addEventListener("abort", abort, { once: true });
              return;
            }
            if (bytes.byteLength > 0) {
              sourceChunks.push(bytes);
              controller.enqueue(bytes);
            }
            controller.close();
          },
        });
        const result = new Response(body, {
          headers,
          status: hasForbidden204Body ? 200 : item.status,
        });
        if (overrides.auditEvents !== undefined) {
          const responseHeaders = result.headers;
          Object.defineProperty(result, "headers", {
            value: Object.freeze({
              get(name: string) {
                overrides.auditEvents?.push(`header:${name.toLowerCase()}`);
                return responseHeaders.get(name);
              },
            }),
          });
        }
        if (hasForbidden204Body) Object.defineProperty(result, "status", { value: 204 });
        if (item.redirected === true) {
          Object.defineProperty(result, "redirected", { value: true });
        }
        return result;
      };
      const fetchImplementation = async (request: URL | RequestInfo, init?: RequestInit) => {
        expect(request).toBeInstanceOf(URL);
        expect(Object.keys(init ?? {}).sort()).toEqual([
          "headers",
          "method",
          "redirect",
          "signal",
        ]);
        const url = new URL(String(request));
        const method = init?.method ?? "GET";
        const headers = init?.headers as Readonly<Record<string, string>> | undefined;
        expect(url.origin).toBe("https://api.github.com");
        expect(url.href).toBe(`https://api.github.com${url.pathname}`);
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
        expect(url.username).toBe("");
        expect(url.password).toBe("");
        expect(init?.body).toBeUndefined();
        expect(Object.keys(headers ?? {}).sort()).toEqual([
          "Accept",
          "Authorization",
          "User-Agent",
          "X-GitHub-Api-Version",
        ]);
        expect(headers).toEqual({
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "wrench-release-writer",
          "X-GitHub-Api-Version": "2022-11-28",
        });
        expect(init?.redirect).toBe("error");
        calls.push(`${method} ${url.pathname}`);
        callTimes.push(clock);
        if (url.pathname === "/installation/token") {
          expect(method).toBe("DELETE");
          expect(deleted).toBe(false);
          deleted = true;
          return responseFor(
            overrides.deleteObservation ?? observation(204, { body: "empty" }),
            init?.signal,
          );
        }
        expect(url.pathname).toBe("/installation/repositories");
        expect(method).toBe("GET");
        expect(deleted).toBe(true);
        const item = observations[observationIndex];
        observationIndex += 1;
        if (item === undefined) throw new Error("revocation fixture exhausted");
        return responseFor(item, init?.signal);
      };
      return Object.freeze({
        advanceClock(milliseconds: number) { clock += milliseconds; },
        calls,
        cancelledBodies() { return cancelledBodies; },
        callTimes,
        createTimeoutSignal(milliseconds: number) {
          timeouts.push(milliseconds);
          return new AbortController().signal;
        },
        fetchImplementation,
        currentClock() { return clock; },
        now() {
          overrides.auditEvents?.push("clock");
          const sample = overrides.nowSamples?.[nowSampleIndex];
          nowSampleIndex += 1;
          if (sample !== undefined) clock = sample;
          return clock;
        },
        observationCount() { return observationIndex; },
        async sleep(milliseconds: number) {
          sleepCalls.push(milliseconds);
          if (overrides.sleepMode === "reject") throw new Error(`sleep leaked ${token}`);
          if (overrides.sleepMode === "frozen") return;
          if (overrides.sleepMode === "regress") {
            clock -= 1;
            return;
          }
          if (overrides.sleepMode === "overflow") {
            clock = Number.MAX_SAFE_INTEGER + 1;
            return;
          }
          clock += overrides.sleepMode === "partial"
            ? Math.max(1, Math.floor(milliseconds / 2))
            : milliseconds;
        },
        sourceChunks,
        sleepCalls,
        timeouts,
      });
    }

    async function runRevocationCase(
      observations: readonly RevocationObservation[],
      overrides: Parameters<typeof createRevocationHarness>[1] = {},
    ) {
      const harness = createRevocationHarness(observations, overrides);
      const receipt = await revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: harness.createTimeoutSignal,
        expiresAt: response.expires_at,
        fetchImplementation: harness.fetchImplementation,
        now: harness.now,
        sleep: harness.sleep,
        token,
      });
      return Object.freeze({ harness, receipt });
    }

    const environmentWrapperHarness = createRevocationHarness(stableDenials);
    const environmentWrapperEvents: string[] = [];
    const environmentWrapperFetch = async (request: URL | RequestInfo, init?: RequestInit) => {
      expect(request).toBeInstanceOf(URL);
      const url = new URL(String(request));
      const method = init?.method ?? "GET";
      environmentWrapperEvents.push(`${method} ${url.pathname}`);
      if (
        url.pathname === "/installation/token" ||
        url.pathname === "/installation/repositories"
      ) {
        return environmentWrapperHarness.fetchImplementation(request, init);
      }
      expect(url.origin).toBe("https://api.github.com");
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      const headers = init?.headers as Readonly<Record<string, string>> | undefined;
      expect(headers?.Accept).toBe("application/vnd.github+json");
      expect(headers?.Authorization).toBe(`Bearer ${jwt}`);
      expect(headers?.["User-Agent"]).toBe("wrench-release-writer");
      expect(headers?.["X-GitHub-Api-Version"]).toBe("2022-11-28");
      const jsonResponse = (body: unknown, status: number, date?: string) => new Response(
        JSON.stringify(body),
        { headers: date === undefined ? undefined : { Date: date }, status },
      );
      if (url.pathname === "/app") {
        expect(method).toBe("GET");
        expect(Object.keys(init ?? {}).sort()).toEqual([
          "headers",
          "method",
          "redirect",
          "signal",
        ]);
        expect(Object.keys(headers ?? {}).sort()).toEqual([
          "Accept",
          "Authorization",
          "User-Agent",
          "X-GitHub-Api-Version",
        ]);
        return jsonResponse(appIdentity, 200);
      }
      if (url.pathname === `/app/installations/${String(configuration.installationId)}`) {
        expect(method).toBe("GET");
        expect(Object.keys(init ?? {}).sort()).toEqual([
          "headers",
          "method",
          "redirect",
          "signal",
        ]);
        expect(Object.keys(headers ?? {}).sort()).toEqual([
          "Accept",
          "Authorization",
          "User-Agent",
          "X-GitHub-Api-Version",
        ]);
        return jsonResponse(installation, 200);
      }
      expect(url.pathname).toBe(
        `/app/installations/${String(configuration.installationId)}/access_tokens`,
      );
      expect(method).toBe("POST");
      expect(Object.keys(init ?? {}).sort()).toEqual([
        "body",
        "headers",
        "method",
        "redirect",
        "signal",
      ]);
      expect(Object.keys(headers ?? {}).sort()).toEqual([
        "Accept",
        "Authorization",
        "Content-Type",
        "User-Agent",
        "X-GitHub-Api-Version",
      ]);
      expect(headers?.["Content-Type"]).toBe("application/json");
      expect(init?.body).toBe(JSON.stringify(releaseAppTokenRequestBody()));
      return jsonResponse(response, 201, "Sun, 30 Aug 2026 01:00:00 GMT");
    };
    const originalFetch = globalThis.fetch;
    const originalDateNow = Date.now;
    const originalStdoutWrite = process.stdout.write;
    let environmentWrapperResult: string | undefined;
    try {
      globalThis.fetch = environmentWrapperFetch as typeof fetch;
      Date.now = () => Date.parse("2026-08-30T01:00:00Z");
      process.stdout.write = ((chunk: string | Uint8Array) => {
        expect(String(chunk)).toBe(`::add-mask::${token}\n`);
        environmentWrapperEvents.push(`mask:${token}`);
        return true;
      }) as typeof process.stdout.write;
      environmentWrapperResult = await withReleaseAppTokenFromEnvironment(
        environment,
        async (value, receipt) => {
          environmentWrapperEvents.push(`operation:${value}`);
          expect(receipt).toEqual({
            appId: configuration.appId,
            appSlug: configuration.appSlug,
            clientId: configuration.clientId,
            expiresAt: response.expires_at,
            installationId: configuration.installationId,
            repositoryId: WRENCH_REPOSITORY_ID,
          });
          return "environment-wrapper-advanced";
        },
        async (receipt) => {
          environmentWrapperEvents.push(`revoked:${JSON.stringify(receipt)}`);
        },
      );
    } finally {
      process.stdout.write = originalStdoutWrite;
      Date.now = originalDateNow;
      globalThis.fetch = originalFetch;
    }
    environmentWrapperEvents.push(`return:${environmentWrapperResult}`);
    expect(environmentWrapperEvents).toEqual([
      "GET /app",
      `GET /app/installations/${String(configuration.installationId)}`,
      `POST /app/installations/${String(configuration.installationId)}/access_tokens`,
      `mask:${token}`,
      `operation:${token}`,
      "DELETE /installation/token",
      "GET /installation/repositories",
      "GET /installation/repositories",
      `revoked:${JSON.stringify(firstTwoDenialsReceipt)}`,
      "return:environment-wrapper-advanced",
    ]);
    expect(environmentWrapperHarness.calls).toEqual([
      "DELETE /installation/token",
      "GET /installation/repositories",
      "GET /installation/repositories",
    ]);
    expect(environmentWrapperHarness.timeouts).toEqual([]);

    expect(RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS).toEqual([
      0,
      250,
      500,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      24_000,
      29_000,
    ]);
    for (const bodies of [
      ["empty", "text"],
      ["json", "binary"],
    ] as const) {
      const direct = await runRevocationCase([
        observation(401, { body: bodies[0] }),
        observation(401, { body: bodies[1] }),
      ]);
      expect(direct.receipt).toEqual({
        converged: true,
        observationCount: 2,
        propagationObserved: false,
        stableDenials: 2,
      });
      expect(direct.harness.calls).toEqual([
        "DELETE /installation/token",
        "GET /installation/repositories",
        "GET /installation/repositories",
      ]);
      expect(direct.harness.sourceChunks.every((chunk) =>
        chunk.every((value) => value === 0))).toBe(true);
    }
    const canonicalEmptyDelete = await runRevocationCase(stableDenials, {
      deleteObservation: observation(204, { body: "empty", contentLength: "0" }),
    });
    expect(canonicalEmptyDelete.receipt).toEqual(firstTwoDenialsReceipt);
    expect(canonicalEmptyDelete.harness.calls).toEqual([
      "DELETE /installation/token",
      "GET /installation/repositories",
      "GET /installation/repositories",
    ]);

    const propagated = await runRevocationCase([
      observation(200),
      observation(401, { body: "text" }),
      observation(401, { body: "empty" }),
    ], { sleepMode: "partial" });
    expect(propagated.receipt).toEqual({
      converged: true,
      observationCount: 3,
      propagationObserved: true,
      stableDenials: 2,
    });

    const observedHarness = createRevocationHarness(stableDenials);
    const observedEvents: string[] = [];
    const observedResult = await withReleaseAppToken({
      environment,
      async inspect() { observedEvents.push("inspect"); return appIdentity; },
      async inspectInstallation() { observedEvents.push("installation"); return installation; },
      mask() { observedEvents.push("mask"); },
      async mint() {
        observedEvents.push("mint");
        return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" };
      },
      nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
      async onRevoked(receipt: Readonly<Record<string, unknown>>) {
        observedEvents.push(`observed:${JSON.stringify(receipt)}`);
      },
      async revoke(input: Readonly<{ apiUrl: URL; expiresAt: string; token: string }>) {
        observedEvents.push("revoke:start");
        const receipt = await revokeReleaseAppTokenWithConvergence({
          ...input,
          createTimeoutSignal: observedHarness.createTimeoutSignal,
          fetchImplementation: observedHarness.fetchImplementation,
          now: observedHarness.now,
          sleep: observedHarness.sleep,
        });
        observedEvents.push("revoke:converged");
        return receipt;
      },
    }, async () => {
      observedEvents.push("operate");
      return "advanced";
    });
    expect(observedResult).toBe("advanced");
    expect(observedEvents).toEqual([
      "inspect",
      "installation",
      "mint",
      "mask",
      "operate",
      "revoke:start",
      "revoke:converged",
      'observed:{"converged":true,"observationCount":2,"propagationObserved":false,"stableDenials":2}',
    ]);

    const observerFailure = withReleaseAppToken({
      environment,
      async inspect() { return appIdentity; },
      async inspectInstallation() { return installation; },
      mask() {},
      async mint() { return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" }; },
      nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
      async onRevoked() { throw new Error("simulated sanitized observer failure"); },
      async revoke() {
        return {
          converged: true,
          observationCount: 2,
          propagationObserved: false,
          stableDenials: 2,
        };
      },
    }, async () => {
      throw new Error("simulated operation failure before observer");
    });
    try {
      await observerFailure;
      throw new Error("operation and observer unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map((item) => String(item))).toEqual([
        "Error: simulated operation failure before observer",
        "Error: simulated sanitized observer failure",
      ]);
    }

    for (const invalidReceipt of [
      undefined,
      { ...firstTwoDenialsReceipt, observationCount: 3 },
      { ...firstTwoDenialsReceipt, observationCount: 2, propagationObserved: true },
      { ...firstTwoDenialsReceipt, observationCount: 11, propagationObserved: true },
      { ...firstTwoDenialsReceipt, stableDenials: 1 },
      { ...firstTwoDenialsReceipt, extra: true },
    ] as const) {
      let invalidObserverCalls = 0;
      await expect(withReleaseAppToken({
        environment,
        async inspect() { return appIdentity; },
        async inspectInstallation() { return installation; },
        mask() {},
        async mint() { return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" }; },
        nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
        async onRevoked() { invalidObserverCalls += 1; },
        async revoke() { return invalidReceipt; },
      }, async () => "advanced")).rejects.toThrow("revocation receipt");
      expect(invalidObserverCalls).toBe(0);
    }
    await expect(withReleaseAppToken({
      environment,
      async inspect() { return appIdentity; },
      async inspectInstallation() { return installation; },
      mask() {},
      async mint() {
        return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" };
      },
      nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
      async revoke() { return undefined; },
    }, async () => "advanced")).rejects.toThrow("revocation receipt");

    const deferredEvents: string[] = [];
    let settleRevocation: ((value: typeof firstTwoDenialsReceipt) => void) | undefined;
    const deferredRevocation = new Promise<typeof firstTwoDenialsReceipt>((resolve) => {
      settleRevocation = resolve;
    });
    const deferredProductionFlow = (async () => {
      await withReleaseAppToken({
        environment,
        async inspect() { return appIdentity; },
        async inspectInstallation() { return installation; },
        mask() {},
        async mint() { return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" }; },
        nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
        async onRevoked() { deferredEvents.push("revocation-receipt"); },
        async revoke() {
          deferredEvents.push("revocation-pending");
          return deferredRevocation;
        },
      }, async () => {
        deferredEvents.push("leased-write");
      });
      deferredEvents.push("post-ref-read");
    })();
    for (let attempt = 0; attempt < 16 && deferredEvents.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(deferredEvents).toEqual(["leased-write", "revocation-pending"]);
    settleRevocation?.(firstTwoDenialsReceipt);
    await deferredProductionFlow;
    expect(deferredEvents).toEqual([
      "leased-write",
      "revocation-pending",
      "revocation-receipt",
      "post-ref-read",
    ]);

    const deferredFailureEvents: string[] = [];
    let rejectDeferredRevocation: ((reason: Error) => void) | undefined;
    const deferredRevocationFailure = new Promise<typeof firstTwoDenialsReceipt>(
      (_resolve, reject) => { rejectDeferredRevocation = reject; },
    );
    const deferredFailureFlow = (async () => {
      await withReleaseAppToken({
        environment,
        async inspect() { return appIdentity; },
        async inspectInstallation() { return installation; },
        mask() {},
        async mint() {
          return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" };
        },
        nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
        async onRevoked() { deferredFailureEvents.push("revocation-receipt"); },
        async revoke() {
          deferredFailureEvents.push("revocation-pending");
          return deferredRevocationFailure;
        },
      }, async () => { deferredFailureEvents.push("leased-write"); });
      deferredFailureEvents.push("post-ref-read");
    })();
    for (let attempt = 0; attempt < 16 && deferredFailureEvents.length < 2; attempt += 1) {
      await Promise.resolve();
    }
    expect(deferredFailureEvents).toEqual(["leased-write", "revocation-pending"]);
    rejectDeferredRevocation?.(new Error("simulated deferred convergence failure"));
    await expect(deferredFailureFlow).rejects.toThrow("simulated deferred convergence failure");
    expect(deferredFailureEvents).toEqual(["leased-write", "revocation-pending"]);

    const failedDeferredEvents: string[] = [];
    await expect((async () => {
      await withReleaseAppToken({
        environment,
        async inspect() { return appIdentity; },
        async inspectInstallation() { return installation; },
        mask() {},
        async mint() { return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" }; },
        nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
        async revoke() { throw new Error("simulated convergence failure"); },
      }, async () => { failedDeferredEvents.push("leased-write"); });
      failedDeferredEvents.push("post-ref-read");
    })()).rejects.toThrow("simulated convergence failure");
    expect(failedDeferredEvents).toEqual(["leased-write"]);

    const persistentHarness = createRevocationHarness(
      Array.from({ length: 10 }, () => observation(200)),
    );
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: persistentHarness.createTimeoutSignal,
      expiresAt: response.expires_at,
      fetchImplementation: persistentHarness.fetchImplementation,
      now: persistentHarness.now,
      sleep: persistentHarness.sleep,
      token,
    })).rejects.toThrow("did not converge within the bounded operational window");
    expect(persistentHarness.observationCount()).toBe(10);
    expect(persistentHarness.calls).toEqual([
      "DELETE /installation/token",
      ...Array.from({ length: 10 }, () => "GET /installation/repositories"),
    ]);
    expect(3 + persistentHarness.calls.length).toBe(14);
    expect(persistentHarness.timeouts.slice(1)).toEqual([
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      10_000,
      6_000,
      1_000,
    ]);

    for (const authoritativeBegin of [250, 251] as const) {
      const closedBoundary = createRevocationHarness(stableDenials, {
        nowSamples: [0, 1, 2, authoritativeBegin, 30_002],
      });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: closedBoundary.createTimeoutSignal,
        expiresAt: response.expires_at,
        fetchImplementation: closedBoundary.fetchImplementation,
        now: closedBoundary.now,
        sleep: closedBoundary.sleep,
        token,
      })).rejects.toThrow("did not converge within the bounded operational window");
      expect(closedBoundary.calls).toEqual(["DELETE /installation/token"]);
      expect(closedBoundary.observationCount()).toBe(0);
      expect(closedBoundary.sleepCalls).toEqual([]);
      expect(closedBoundary.timeouts).toEqual([10_000]);
    }

    for (const authoritativeBegin of [30_000, 30_001] as const) {
      const finalSlotBoundary = createRevocationHarness(stableDenials, {
        nowSamples: [
          0,
          250,
          500,
          1_000,
          2_000,
          4_000,
          8_000,
          16_000,
          24_000,
          29_000,
          29_000,
          29_000,
          authoritativeBegin,
        ],
      });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: finalSlotBoundary.createTimeoutSignal,
        expiresAt: response.expires_at,
        fetchImplementation: finalSlotBoundary.fetchImplementation,
        now: finalSlotBoundary.now,
        sleep: finalSlotBoundary.sleep,
        token,
      })).rejects.toThrow("did not converge within the bounded operational window");
      expect(finalSlotBoundary.calls).toEqual(["DELETE /installation/token"]);
      expect(finalSlotBoundary.observationCount()).toBe(0);
      expect(finalSlotBoundary.sleepCalls).toEqual([]);
      expect(finalSlotBoundary.timeouts).toEqual([10_000]);
    }

    for (const authoritativeBegin of [30_000, 30_001] as const) {
      const finalSlotAfterObservations = createRevocationHarness(
        Array.from({ length: 9 }, () => observation(200)),
        {
          deleteObservation: observation(204, {
            body: "empty",
            fetchLatencyMilliseconds: 0,
          }),
        },
      );
      let finalSlotClockReads = 0;
      const finalSlotNow = () => {
        if (
          finalSlotAfterObservations.observationCount() === 9 &&
          finalSlotAfterObservations.currentClock() === 29_000
        ) {
          finalSlotClockReads += 1;
          if (finalSlotClockReads === 2) {
            finalSlotAfterObservations.advanceClock(authoritativeBegin - 29_000);
          }
        }
        return finalSlotAfterObservations.currentClock();
      };
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: finalSlotAfterObservations.createTimeoutSignal,
        expiresAt: response.expires_at,
        fetchImplementation: finalSlotAfterObservations.fetchImplementation,
        now: finalSlotNow,
        sleep: finalSlotAfterObservations.sleep,
        token,
      })).rejects.toThrow("did not converge within the bounded operational window");
      expect(finalSlotAfterObservations.calls).toEqual([
        "DELETE /installation/token",
        ...Array.from({ length: 9 }, () => "GET /installation/repositories"),
      ]);
      expect(finalSlotAfterObservations.observationCount()).toBe(9);
      expect(finalSlotAfterObservations.sleepCalls).toEqual([
        249,
        249,
        499,
        999,
        1_999,
        3_999,
        7_999,
        7_999,
        4_999,
      ]);
      expect(finalSlotAfterObservations.timeouts).toEqual([
        ...Array.from({ length: 9 }, () => 10_000),
        6_000,
      ]);
    }

    const boundaryTimeoutHarness = createRevocationHarness(
      Array.from({ length: 10 }, () => observation(200)),
    );
    let finalSlotSamples = 0;
    const boundaryTimeoutNow = () => {
      if (
        boundaryTimeoutHarness.observationCount() === 9 &&
        boundaryTimeoutHarness.currentClock() === 29_001
      ) {
        finalSlotSamples += 1;
        if (finalSlotSamples === 2) boundaryTimeoutHarness.advanceClock(500);
      }
      return boundaryTimeoutHarness.currentClock();
    };
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: boundaryTimeoutHarness.createTimeoutSignal,
      expiresAt: response.expires_at,
      fetchImplementation: boundaryTimeoutHarness.fetchImplementation,
      now: boundaryTimeoutNow,
      sleep: boundaryTimeoutHarness.sleep,
      token,
    })).rejects.toThrow("did not converge within the bounded operational window");
    expect(boundaryTimeoutHarness.observationCount()).toBe(10);
    expect(boundaryTimeoutHarness.callTimes.at(-1)).toBe(29_501);
    expect(boundaryTimeoutHarness.timeouts.at(-1)).toBe(500);
    expect(
      (boundaryTimeoutHarness.callTimes.at(-1) ?? 0) +
      (boundaryTimeoutHarness.timeouts.at(-1) ?? 0),
    ).toBe(30_001);

    const loneDenial = [
      ...Array.from({ length: 9 }, () => observation(200)),
      observation(401, { body: "empty" }),
    ];
    await expect(runRevocationCase(loneDenial)).rejects.toThrow("only one denial");
    await expect(runRevocationCase([
      observation(401, { body: "empty" }),
      observation(200),
    ])).rejects.toThrow("authorization returned after a denial");

    const observationFailureCases: readonly Readonly<{
      message: string;
      observations: readonly RevocationObservation[];
      overrides?: Parameters<typeof createRevocationHarness>[1];
      sensitive?: readonly string[];
    }>[] = [
      {
        message: "unexpected authorization state",
        observations: [observation(403, {
          body: "text",
          bodyText: "observation-403-body-secret",
          requestId: "observation-403-request-secret",
        })],
        sensitive: ["403", "observation-403-body-secret", "observation-403-request-secret"],
      },
      {
        message: "unexpected authorization state",
        observations: [observation(404, {
          body: "text",
          bodyText: "observation-404-body-secret",
          requestId: "observation-404-request-secret",
        })],
        sensitive: ["404", "observation-404-body-secret", "observation-404-request-secret"],
      },
      {
        message: "unexpected authorization state",
        observations: [observation(429, {
          body: "text",
          bodyText: "observation-429-body-secret",
          requestId: "observation-429-request-secret",
        })],
        sensitive: ["429", "observation-429-body-secret", "observation-429-request-secret"],
      },
      {
        message: "unexpected authorization state",
        observations: [observation(500, {
          body: "text",
          bodyText: "observation-500-body-secret",
          requestId: "observation-500-request-secret",
        })],
        sensitive: ["500", "observation-500-body-secret", "observation-500-request-secret"],
      },
      {
        message: "authorized revocation observation is malformed",
        observations: [observation(200, { body: "wrong-repo" })],
      },
      {
        message: "authorized revocation observation is malformed",
        observations: [observation(200, { body: "binary" })],
      },
      {
        message: "authorized revocation observation is malformed",
        observations: [observation(200, { body: "overflow" })],
      },
      {
        message: "redirected",
        observations: [observation(200, {
          body: "text",
          bodyText: "observation-200-location-body-secret",
          location: "https://observation-location-secret.invalid/",
          requestId: "observation-200-location-request-secret",
        })],
        sensitive: [
          "observation-200-location-body-secret",
          "observation-200-location-request-secret",
          "https://observation-location-secret.invalid/",
        ],
      },
      {
        message: "redirected",
        observations: [observation(401, {
          body: "json",
          redirected: true,
          requestId: "observation-401-redirect-request-secret",
        })],
        sensitive: ["Bad credentials", "observation-401-redirect-request-secret"],
      },
      {
        message: "redirected",
        observations: [observation(401, {
          body: "text",
          bodyText: "observation-401-location-body-secret",
          location: "https://observation-401-location-secret.invalid/",
          requestId: "observation-401-location-request-secret",
        })],
        sensitive: [
          "observation-401-location-body-secret",
          "observation-401-location-request-secret",
          "https://observation-401-location-secret.invalid/",
        ],
      },
      {
        message: "transport failed",
        observations: [observation(401, { networkFailure: true })],
      },
      {
        message: "transport failed",
        observations: [observation(401, { networkFailure: "abort" })],
      },
      {
        message: "authorized revocation observation is malformed",
        observations: [observation(200, { body: "invalid-json" })],
      },
      {
        message: "denied revocation observation is malformed",
        observations: [observation(401, { body: "overflow" })],
      },
      {
        message: "sleep failed",
        observations: [observation(200), ...stableDenials],
        overrides: { sleepMode: "reject" },
      },
      {
        message: "did not advance the clock",
        observations: [observation(200), ...stableDenials],
        overrides: { sleepMode: "frozen" },
      },
      {
        message: "clock regressed",
        observations: [observation(200), ...stableDenials],
        overrides: { sleepMode: "regress" },
      },
      {
        message: "clock is invalid",
        observations: [observation(200), ...stableDenials],
        overrides: { sleepMode: "overflow" },
      },
      {
        message: "clock regressed",
        observations: [
          observation(401, { fetchLatencyMilliseconds: -1 }),
          observation(401),
        ],
      },
    ];
    for (const failureCase of observationFailureCases) {
      const failureHarness = createRevocationHarness(
        failureCase.observations,
        failureCase.overrides,
      );
      let caught: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: failureHarness.createTimeoutSignal,
          expiresAt: response.expires_at,
          fetchImplementation: failureHarness.fetchImplementation,
          now: failureHarness.now,
          sleep: failureHarness.sleep,
          token,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain(failureCase.message);
      for (const sensitive of [
        token,
        "Bad credentials",
        "/installation/repositories",
        "/installation/token",
        ...(failureCase.sensitive ?? []),
      ]) {
        expect(String(caught)).not.toContain(sensitive);
      }
      if (failureCase.observations.some((item) => item.body === "overflow")) {
        expect(failureHarness.cancelledBodies()).toBe(1);
      } else {
        expect(failureHarness.sourceChunks.every((chunk) =>
          chunk.every((value) => value === 0))).toBe(true);
      }
    }

    for (const invalidDateObservation of [
      observation(200, {
        date: "invalid-authorized-date-secret",
        requestId: "authorized-date-request-secret",
      }),
      observation(200, { omitDate: true }),
      observation(401, {
        body: "text",
        bodyText: "denied-date-body-secret",
        date: "invalid-denied-date-secret",
        requestId: "denied-date-request-secret",
      }),
      observation(401, { body: "text", omitDate: true }),
    ] as const) {
      const invalidDateHarness = createRevocationHarness([invalidDateObservation]);
      let caught: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: invalidDateHarness.createTimeoutSignal,
          expiresAt: response.expires_at,
          fetchImplementation: invalidDateHarness.fetchImplementation,
          now: invalidDateHarness.now,
          sleep: invalidDateHarness.sleep,
          token,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain(
        invalidDateObservation.status === 200
          ? "authorized revocation observation is malformed"
          : "denied revocation observation is malformed",
      );
      for (const sensitive of [
        token,
        invalidDateObservation.date ?? "",
        String(invalidDateObservation.requestId),
        invalidDateObservation.bodyText ?? "",
        "/installation/repositories",
      ].filter((value) => value.length > 0)) {
        expect(String(caught)).not.toContain(sensitive);
      }
      expect(invalidDateHarness.sourceChunks.length).toBeGreaterThan(0);
      expect(invalidDateHarness.sourceChunks.every((chunk) =>
        chunk.every((value) => value === 0))).toBe(true);
    }

    const rejectedDeleteCases: readonly Readonly<{
      observation: RevocationObservation;
      sensitive?: readonly string[];
    }>[] = [
      {
        observation: observation(403, {
          body: "text",
          bodyText: "delete-403-body-secret",
          requestId: "delete-403-request-secret",
        }),
        sensitive: ["403", "delete-403-body-secret", "delete-403-request-secret"],
      },
      {
        observation: observation(401, {
          body: "json",
          requestId: "delete-401-request-secret",
        }),
        sensitive: ["401", "Bad credentials", "delete-401-request-secret"],
      },
      {
        observation: observation(204, {
          body: "text",
          bodyText: "delete-redirect-body-secret",
          contentLength: "27",
          location: "https://delete-location-secret.invalid/",
          requestId: "delete-redirect-request-secret",
        }),
        sensitive: [
          "delete-redirect-body-secret",
          "delete-redirect-request-secret",
          "https://delete-location-secret.invalid/",
        ],
      },
      {
        observation: observation(204, {
          body: "text",
          bodyText: "delete-nonempty-body-secret",
          contentLength: "27",
        }),
        sensitive: ["delete-nonempty-body-secret"],
      },
      {
        observation: observation(204, { body: "empty", contentLength: "1" }),
      },
      {
        observation: observation(204, { body: "empty", contentLength: "00" }),
      },
      { observation: observation(204, { body: "overflow" }) },
      { observation: observation(204, { body: "empty", networkFailure: true }) },
    ];
    for (const rejectedDeleteCase of rejectedDeleteCases) {
      const deleteObservation = rejectedDeleteCase.observation;
      const rejectedDelete = createRevocationHarness(stableDenials, { deleteObservation });
      let caught: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: rejectedDelete.createTimeoutSignal,
          expiresAt: response.expires_at,
          fetchImplementation: rejectedDelete.fetchImplementation,
          now: rejectedDelete.now,
          sleep: rejectedDelete.sleep,
          token,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("indeterminate");
      for (const sensitive of [
        token,
        "Bad credentials",
        "/installation/repositories",
        "/installation/token",
        ...(rejectedDeleteCase.sensitive ?? []),
      ]) {
        expect(String(caught)).not.toContain(sensitive);
      }
      expect(rejectedDelete.calls).toEqual(["DELETE /installation/token"]);
      if (deleteObservation.body !== "overflow") {
        expect(rejectedDelete.sourceChunks.every((chunk) =>
          chunk.every((value) => value === 0))).toBe(true);
      } else {
        expect(rejectedDelete.cancelledBodies()).toBe(1);
      }
    }

    for (const deleteObservation of [
      observation(204, { body: "empty", networkFailure: "pending" }),
      observation(204, { body: "pending" }),
    ] as const) {
      const pendingHarness = createRevocationHarness(stableDenials, { deleteObservation });
      let caught: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: () => AbortSignal.timeout(1),
          expiresAt: response.expires_at,
          fetchImplementation: pendingHarness.fetchImplementation,
          now: pendingHarness.now,
          sleep: pendingHarness.sleep,
          token,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("indeterminate");
      expect(String(caught)).not.toContain(token);
      expect(pendingHarness.calls).toEqual(["DELETE /installation/token"]);
    }
    for (const observations of [
      [observation(401, { networkFailure: "pending" })],
      [observation(401, { body: "pending" })],
    ] as const) {
      const pendingHarness = createRevocationHarness(observations, {
        deleteObservation: observation(204, { body: "empty" }),
      });
      let caught: unknown;
      try {
        await revokeReleaseAppTokenWithConvergence({
          apiUrl: new URL("https://api.github.com/"),
          createTimeoutSignal: () => AbortSignal.timeout(1),
          expiresAt: response.expires_at,
          fetchImplementation: pendingHarness.fetchImplementation,
          now: pendingHarness.now,
          sleep: pendingHarness.sleep,
          token,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("indeterminate");
      expect(String(caught)).not.toContain(token);
      expect(pendingHarness.calls).toEqual([
        "DELETE /installation/token",
        "GET /installation/repositories",
      ]);
    }

    const missedSlots = await runRevocationCase([
      observation(200, { fetchLatencyMilliseconds: 9_000 }),
      observation(401, { body: "empty" }),
      observation(401, { body: "text" }),
    ]);
    expect(missedSlots.receipt.observationCount).toBe(3);
    expect(missedSlots.harness.callTimes.slice(1)).toEqual([1, 16_001, 24_001]);

    for (const invalidClock of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ] as const) {
      const clockHarness = createRevocationHarness(stableDenials, {
        nowSamples: [invalidClock],
      });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: clockHarness.createTimeoutSignal,
        expiresAt: response.expires_at,
        fetchImplementation: clockHarness.fetchImplementation,
        now: clockHarness.now,
        sleep: clockHarness.sleep,
        token,
      })).rejects.toThrow("clock is invalid");
      expect(clockHarness.calls).toEqual(["DELETE /installation/token"]);
    }
    const throwingClock = createRevocationHarness(stableDenials);
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: throwingClock.createTimeoutSignal,
      expiresAt: response.expires_at,
      fetchImplementation: throwingClock.fetchImplementation,
      now() { throw new Error(`clock leaked ${token}`); },
      sleep: throwingClock.sleep,
      token,
    })).rejects.toThrow("clock read failed");
    expect(throwingClock.calls).toEqual(["DELETE /installation/token"]);

    const deletionCompletionEvents: string[] = [];
    const deletionCompletionHarness = createRevocationHarness(stableDenials, {
      auditEvents: deletionCompletionEvents,
      deleteObservation: observation(204, { body: "empty", date: "malformed" }),
      nowSamples: [0],
    });
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: deletionCompletionHarness.createTimeoutSignal,
      expiresAt: response.expires_at,
      fetchImplementation: deletionCompletionHarness.fetchImplementation,
      now: deletionCompletionHarness.now,
      sleep: deletionCompletionHarness.sleep,
      token,
    })).rejects.toThrow("revocation authority time proof is malformed");
    expect(deletionCompletionHarness.calls).toEqual(["DELETE /installation/token"]);
    expect(deletionCompletionEvents).toEqual([
      "header:location",
      "header:content-length",
      "header:content-length",
      "clock",
      "header:date",
    ]);

    const boundary = await runRevocationCase([
      ...Array.from({ length: 8 }, () => observation(200)),
      observation(401, { body: "text" }),
      observation(401, { body: "empty", bodyLatencyMilliseconds: 1_000, fetchLatencyMilliseconds: 0 }),
    ]);
    expect(boundary.receipt).toEqual({
      converged: true,
      observationCount: 10,
      propagationObserved: true,
      stableDenials: 2,
    });
    await expect(runRevocationCase([
      ...Array.from({ length: 8 }, () => observation(200)),
      observation(401),
      observation(401, { bodyLatencyMilliseconds: 1_001, fetchLatencyMilliseconds: 0 }),
    ])).rejects.toThrow("completed outside its deadline");
    await expect(runRevocationCase([
      observation(401, { date: "Sun, 30 Aug 2026 02:00:00 GMT" }),
      observation(401),
    ])).rejects.toThrow("denied revocation observation is malformed");

    const oneSecondBeforeExpiry = "Sun, 30 Aug 2026 01:59:59 GMT";
    const acceptedDeleteDate = await runRevocationCase(stableDenials, {
      deleteObservation: observation(204, {
        body: "empty",
        date: oneSecondBeforeExpiry,
      }),
    });
    expect(acceptedDeleteDate.receipt).toEqual(firstTwoDenialsReceipt);
    const acceptedAuthorizedDate = await runRevocationCase([
      observation(200, { date: oneSecondBeforeExpiry }),
      observation(401, { body: "empty", date: oneSecondBeforeExpiry }),
      observation(401, { body: "text", date: oneSecondBeforeExpiry }),
    ]);
    expect(acceptedAuthorizedDate.receipt).toEqual({
      converged: true,
      observationCount: 3,
      propagationObserved: true,
      stableDenials: 2,
    });
    const acceptedDeniedDate = await runRevocationCase([
      observation(401, { body: "empty", date: oneSecondBeforeExpiry }),
      observation(401, { body: "text", date: oneSecondBeforeExpiry }),
    ]);
    expect(acceptedDeniedDate.receipt).toEqual(firstTwoDenialsReceipt);
    for (const [label, observations, overrides] of [
      [
        "revocation authority time proof is malformed",
        stableDenials,
        {
          deleteObservation: observation(204, {
            body: "empty",
            date: "Sun, 30 Aug 2026 02:00:00 GMT",
          }),
        },
      ],
      [
        "authorized revocation observation is malformed",
        [observation(200, { date: "Sun, 30 Aug 2026 02:00:00 GMT" })],
        {},
      ],
      [
        "denied revocation observation is malformed",
        [observation(401, {
          body: "empty",
          date: "Sun, 30 Aug 2026 02:00:00 GMT",
        })],
        {},
      ],
    ] as const) {
      const equalityBoundary = createRevocationHarness(observations, overrides);
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: equalityBoundary.createTimeoutSignal,
        expiresAt: response.expires_at,
        fetchImplementation: equalityBoundary.fetchImplementation,
        now: equalityBoundary.now,
        sleep: equalityBoundary.sleep,
        token,
      })).rejects.toThrow(label);
    }

    for (const [expiresAt, deleteObservation] of [
      ["malformed", observation(204, { body: "empty" })],
      [response.expires_at, observation(204, { body: "empty", date: "malformed" })],
      [response.expires_at, observation(204, { body: "empty", omitDate: true })],
    ] as const) {
      const invalidAuthority = createRevocationHarness(stableDenials, { deleteObservation });
      await expect(revokeReleaseAppTokenWithConvergence({
        apiUrl: new URL("https://api.github.com/"),
        createTimeoutSignal: invalidAuthority.createTimeoutSignal,
        expiresAt,
        fetchImplementation: invalidAuthority.fetchImplementation,
        now: invalidAuthority.now,
        sleep: invalidAuthority.sleep,
        token,
      })).rejects.toThrow("revocation authority time proof is malformed");
      expect(invalidAuthority.calls).toEqual(["DELETE /installation/token"]);
    }

    const impreciseDeadline = createRevocationHarness(stableDenials, {
      initialClock: Number.MAX_SAFE_INTEGER - 30_000,
    });
    await expect(revokeReleaseAppTokenWithConvergence({
      apiUrl: new URL("https://api.github.com/"),
      createTimeoutSignal: impreciseDeadline.createTimeoutSignal,
      expiresAt: response.expires_at,
      fetchImplementation: impreciseDeadline.fetchImplementation,
      now: impreciseDeadline.now,
      sleep: impreciseDeadline.sleep,
      token,
    })).rejects.toThrow("outside the precise clock range");
    expect(impreciseDeadline.calls).toEqual(["DELETE /installation/token"]);

    const revokedAfterFailure: string[] = [];
    await expect(withReleaseAppToken({
      environment,
      async inspect() { return appIdentity; },
      async inspectInstallation() { return installation; },
      mask() {},
      async mint() { return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" }; },
      nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
      async revoke(input: Readonly<{ token: string }>) {
        revokedAfterFailure.push(input.token);
        return firstTwoDenialsReceipt;
      },
    }, async () => {
      throw new Error("simulated leased push failure");
    })).rejects.toThrow("simulated leased push failure");
    expect(revokedAfterFailure).toEqual([token]);

    const malformedTokenRevocations: string[] = [];
    await expect(withReleaseAppToken({
      environment,
      async inspect() { return appIdentity; },
      async inspectInstallation() { return installation; },
      mask() {},
      async mint() {
        return {
          body: {
            ...response,
            permissions: { contents: "read", metadata: "read", workflows: "write" },
          },
          serverDate: "Sun, 30 Aug 2026 01:00:00 GMT",
        };
      },
      nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
      async revoke(input: Readonly<{ token: string }>) {
        malformedTokenRevocations.push(input.token);
        return firstTwoDenialsReceipt;
      },
    }, async () => "unreachable")).rejects.toThrow("permissions are not exactly");
    expect(malformedTokenRevocations).toEqual([token]);

    const operationAndRevocation = withReleaseAppToken({
      environment,
      async inspect() { return appIdentity; },
      async inspectInstallation() { return installation; },
      mask() {},
      async mint() { return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" }; },
      nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
      async revoke() { throw new Error("simulated revoke failure"); },
    }, async () => {
      throw new Error("simulated operation failure");
    });
    try {
      await operationAndRevocation;
      throw new Error("combined App operation unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map((item) => String(item))).toEqual([
        "Error: simulated operation failure",
        "Error: simulated revoke failure",
      ]);
    }

    const convergenceAggregateHarness = createRevocationHarness(
      Array.from({ length: 10 }, () => observation(200)),
    );
    const convergenceAggregateSetupCalls: string[] = [];
    let convergenceAggregateOperations = 0;
    let convergenceAggregateMints = 0;
    try {
      await withReleaseAppToken({
        environment,
        async inspect() {
          convergenceAggregateSetupCalls.push("GET /app");
          return appIdentity;
        },
        async inspectInstallation() {
          convergenceAggregateSetupCalls.push("GET /app/installations/12345");
          return installation;
        },
        mask() {},
        async mint() {
          convergenceAggregateMints += 1;
          convergenceAggregateSetupCalls.push("POST /app/installations/12345/access_tokens");
          return { body: response, serverDate: "Sun, 30 Aug 2026 01:00:00 GMT" };
        },
        nowMilliseconds() { return Date.parse("2026-08-30T01:00:00Z"); },
        async revoke(input: Readonly<{ apiUrl: URL; expiresAt: string; token: string }>) {
          await revokeReleaseAppTokenWithConvergence({
            ...input,
            createTimeoutSignal: convergenceAggregateHarness.createTimeoutSignal,
            fetchImplementation: convergenceAggregateHarness.fetchImplementation,
            now: convergenceAggregateHarness.now,
            sleep: convergenceAggregateHarness.sleep,
          });
        },
      }, async () => {
        convergenceAggregateOperations += 1;
        throw new Error("simulated leased push failure before convergence");
      });
      throw new Error("combined operation and convergence unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map((item) => String(item))).toEqual([
        "Error: simulated leased push failure before convergence",
        "Error: release App token revocation did not converge within the bounded operational window",
      ]);
    }
    expect(convergenceAggregateMints).toBe(1);
    expect(convergenceAggregateOperations).toBe(1);
    expect(convergenceAggregateSetupCalls).toEqual([
      "GET /app",
      "GET /app/installations/12345",
      "POST /app/installations/12345/access_tokens",
    ]);
    expect(convergenceAggregateHarness.calls).toEqual([
      "DELETE /installation/token",
      ...Array.from({ length: 10 }, () => "GET /installation/repositories"),
    ]);
    expect([
      ...convergenceAggregateSetupCalls,
      ...convergenceAggregateHarness.calls,
    ]).toHaveLength(14);
    expect(convergenceAggregateHarness.calls.filter((call) =>
      call === "DELETE /installation/token")).toHaveLength(1);

    const deferredPromotionDeployment = providerDeployment(
      10,
      "2026-08-29T13:00:00Z",
      { sha: providerPreviousSha },
    );
    const deferredPromotionBaselineApi = new ProviderApiFixture({
      deployments: [[deferredPromotionDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerBaselineServerDate, providerBaselineServerDate],
      statuses: terminalBaselineStatus(10, "2026-08-29T13:01:00Z"),
    });
    const deferredPromotionBaseline = await createProviderBaseline({
      api: deferredPromotionBaselineApi,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    });
    const productionRefRead =
      `GET /repos/${providerRepository}/git/ref/heads/website-production`;

    const deferredPromotionApi = new ProviderApiFixture({
      deployments: [[deferredPromotionDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
      statuses: terminalBaselineStatus(10, "2026-08-29T13:01:00Z"),
    });
    const originalDeferredAdvance = deferredPromotionApi.advanceRef.bind(deferredPromotionApi);
    const deferredPromotionEvents: string[] = [];
    let settleDeferredAdvance: (() => void) | undefined;
    const deferredAdvance = new Promise<void>((resolve) => { settleDeferredAdvance = resolve; });
    Object.defineProperty(deferredPromotionApi, "advanceRef", {
      value: async (...args: Parameters<ProviderApiFixture["advanceRef"]>) => {
        deferredPromotionEvents.push("advance-pending");
        await deferredAdvance;
        deferredPromotionEvents.push("advance-settled");
        return originalDeferredAdvance(...args);
      },
    });
    let deferredPromotionSettled = false;
    const deferredPromotionResult = promoteWebsiteProduction({
      api: deferredPromotionApi,
      baselineReceipt: deferredPromotionBaseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    }).finally(() => { deferredPromotionSettled = true; });
    for (let attempt = 0; attempt < 32 && deferredPromotionEvents.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(deferredPromotionEvents).toEqual(["advance-pending"]);
    expect(deferredPromotionSettled).toBe(false);
    expect(deferredPromotionApi.calls.filter((call) => call === productionRefRead)).toHaveLength(2);
    settleDeferredAdvance?.();
    await expect(deferredPromotionResult).resolves.toMatchObject({ mode: "advanced" });
    expect(deferredPromotionEvents).toEqual(["advance-pending", "advance-settled"]);
    expect(deferredPromotionApi.calls.filter((call) => call === productionRefRead)).toHaveLength(3);

    const rejectedPromotionApi = new ProviderApiFixture({
      deployments: [[deferredPromotionDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
      statuses: terminalBaselineStatus(10, "2026-08-29T13:01:00Z"),
    });
    let rejectDeferredAdvance: ((reason: Error) => void) | undefined;
    const rejectedAdvance = new Promise<void>((_resolve, reject) => {
      rejectDeferredAdvance = reject;
    });
    Object.defineProperty(rejectedPromotionApi, "advanceRef", {
      value: async () => rejectedAdvance,
    });
    const rejectedPromotion = promoteWebsiteProduction({
      api: rejectedPromotionApi,
      baselineReceipt: deferredPromotionBaseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    });
    for (let attempt = 0; attempt < 32; attempt += 1) await Promise.resolve();
    expect(rejectedPromotionApi.calls.filter((call) => call === productionRefRead)).toHaveLength(2);
    rejectDeferredAdvance?.(new Error("simulated deferred writer failure"));
    await expect(rejectedPromotion).rejects.toThrow("simulated deferred writer failure");
    expect(rejectedPromotionApi.calls.filter((call) => call === productionRefRead)).toHaveLength(2);

    const providerSource = await readFile(providerOutcomeHelperUrl, "utf8");
    const promotionStart = providerSource.indexOf("export async function promoteWebsiteProduction");
    const promotionEnd = providerSource.indexOf("\nexport ", promotionStart + 1);
    const promotionSource = providerSource.slice(
      promotionStart,
      promotionEnd < 0 ? undefined : promotionEnd,
    );
    expect(promotionSource.indexOf("await api.advanceRef(")).toBeGreaterThan(0);
    expect(promotionSource.indexOf("await api.advanceRef("))
      .toBeLessThan(promotionSource.indexOf("const promotedSha = await readProductionRef("));
    const productionAdvanceStart = providerSource.indexOf("async advanceRef(repository");
    const productionAdvanceEnd = providerSource.indexOf("\n  }\n}", productionAdvanceStart);
    const productionAdvanceSource = providerSource.slice(productionAdvanceStart, productionAdvanceEnd);
    expect(providerSource.match(/from "\.\/release-app-token\.mjs";/gu) ?? []).toHaveLength(1);
    expect(providerSource).toContain(
      "RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS",
    );
    expect(providerSource).toContain("withReleaseAppTokenFromEnvironment");
    expect(providerSource.match(/await withReleaseAppTokenFromEnvironment\(/gu) ?? [])
      .toHaveLength(1);
    expect(productionAdvanceSource.trimEnd()).toBe(`async advanceRef(repository, expectedOldSha, verifiedSha, verifiedTag) {
    let releaseAppRevocation;
    await withReleaseAppTokenFromEnvironment(this.#environment, async (token) => {
      advanceWebsiteProductionRefFromEnvironment({
        environment: Object.freeze({ WRENCH_RELEASE_APP_TOKEN: token }),
        expectedOldSha,
        repository,
        verifiedSha,
        verifiedTag,
      });
    }, async (receipt) => {
      if (releaseAppRevocation !== undefined) {
        fail("release App revocation receipt was emitted more than once");
      }
      releaseAppRevocation = parseReleaseAppRevocationReceipt(receipt);
    });
    if (releaseAppRevocation === undefined) fail("release App revocation receipt is missing");
    return releaseAppRevocation;`);

    for (const overrides of [
      { GITHUB_API_URL: "https://github.example.invalid" },
      { GITHUB_REPOSITORY: "hraness/copied-repository" },
      { GITHUB_REPOSITORY_ID: "1" },
      { GITHUB_REPOSITORY_OWNER: "copied-owner" },
      { WRENCH_RELEASE_APP_CLIENT_ID: "bad client" },
      { WRENCH_RELEASE_APP_ID: "0" },
      { WRENCH_RELEASE_APP_INSTALLATION_ID: "1.5" },
      { WRENCH_RELEASE_APP_PRIVATE_KEY: "" },
      { WRENCH_RELEASE_APP_SLUG: "Bad_Slug" },
    ] as const) {
      expect(() => parseReleaseAppConfiguration({ ...environment, ...overrides })).toThrow();
    }

    for (const invalid of [
      { ...response, permissions: { contents: "write", metadata: "read" } },
      { ...response, permissions: { contents: "write", metadata: "read", workflows: "read" } },
      {
        ...response,
        permissions: {
          administration: "write",
          contents: "write",
          metadata: "read",
          workflows: "write",
        },
      },
      { ...response, repository_selection: "all" },
      { ...response, repositories: [] },
      { ...response, repositories: [{ ...response.repositories[0], id: 1 }] },
      { ...response, repositories: [{ ...response.repositories[0], owner: { login: "other" } }] },
      { ...response, expires_at: "2026-08-30T03:00:00Z" },
    ] as const) {
      expect(() => parseReleaseAppTokenResponse(
        invalid,
        "Sun, 30 Aug 2026 01:00:00 GMT",
      )).toThrow();
    }
    const missingTokenResponse: Record<string, unknown> = { ...response };
    delete missingTokenResponse.token;
    expect(() => parseReleaseAppTokenResponse(
      missingTokenResponse,
      "Sun, 30 Aug 2026 01:00:00 GMT",
    )).toThrow("release App token response is missing token");
  });

  test("fetches the exact release object before one leased production ref write", () => {
    const fetchArguments = verifiedReleaseFetchArguments(providerTag);
    expect(fetchArguments).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "http.extraHeader=",
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=1",
      "https://github.com/hraness/wrench.git",
      `refs/tags/${providerTag}`,
    ]);
    const pushArguments = websiteProductionPushArguments(providerPreviousSha, providerVerifiedSha);
    expect(pushArguments).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "http.extraHeader=",
      "-c",
      "push.followTags=false",
      "-c",
      "push.gpgSign=false",
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/website-production:${providerPreviousSha}`,
      "--no-follow-tags",
      "--no-tags",
      "--no-signed",
      "--no-verify",
      "--recurse-submodules=no",
      "https://github.com/hraness/wrench.git",
      `${providerVerifiedSha}:refs/heads/website-production`,
    ]);
    expect(pushArguments).toContain(
      `--force-with-lease=refs/heads/website-production:${providerPreviousSha}`,
    );
    expect(pushArguments).toContain(
      `${providerVerifiedSha}:refs/heads/website-production`,
    );
    expect(pushArguments).toContain("https://github.com/hraness/wrench.git");
    expect(pushArguments.filter((value) => value === "push")).toHaveLength(1);
    expect(pushArguments).not.toContain("--force");
    expect(pushArguments).not.toContain("--mirror");
    expect(pushArguments).not.toContain("--all");
    expect(pushArguments.join(" ")).not.toContain("*");
    expect(() => verifiedReleaseFetchArguments("main")).toThrow("stable semantic-version tag");
    expect(() => websiteProductionPushArguments(providerPreviousSha, providerPreviousSha))
      .toThrow("already exact");

    const token = "ghs_secret-wrench-release-token";
    let askpassPath = "";
    const calls: string[][] = [];
    advanceWebsiteProductionRef({
      environment: { WRENCH_RELEASE_APP_TOKEN: token },
      expectedOldSha: providerPreviousSha,
      repository: providerRepository,
      spawnImplementation(executable: string, args: readonly string[], options: {
        readonly env: Readonly<Record<string, string>>;
        readonly timeout: number;
      }) {
        expect(executable).toBe("/usr/bin/git");
        calls.push([...args]);
        expect(options.timeout).toBe(60_000);
        expect(options.env.GIT_TERMINAL_PROMPT).toBe("0");
        expect(options.env.GIT_CONFIG_NOSYSTEM).toBe("1");
        const authenticated = args.includes("fetch") || args.includes("push");
        expect(options.env.WRENCH_RELEASE_APP_TOKEN).toBe(authenticated ? token : undefined);
        expect(Object.keys(options.env).sort()).toEqual((authenticated ? [
          "GIT_ASKPASS",
          "GIT_ASKPASS_REQUIRE",
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_CONFIG_SYSTEM",
          "GIT_LFS_SKIP_SMUDGE",
          "GIT_TERMINAL_PROMPT",
          "LC_ALL",
          "PATH",
          "WRENCH_RELEASE_APP_TOKEN",
        ] : [
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_NOSYSTEM",
          "GIT_CONFIG_SYSTEM",
          "GIT_LFS_SKIP_SMUDGE",
          "GIT_TERMINAL_PROMPT",
          "LC_ALL",
          "PATH",
        ]).sort());
        if (authenticated) {
          askpassPath = options.env.GIT_ASKPASS ?? "";
          expect(statSync(askpassPath).mode & 0o777).toBe(0o700);
          const askpass = readFileSync(askpassPath, "utf8");
          expect(askpass).toContain("x-access-token");
          expect(askpass).toContain("$WRENCH_RELEASE_APP_TOKEN");
          expect(askpass).not.toContain(token);
        } else {
          expect(options.env.GIT_ASKPASS).toBeUndefined();
        }
        return {
          status: 0,
          stderr: "",
          stdout: args.includes("rev-parse") ? `${providerVerifiedSha}\n` : "ok",
        };
      },
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    });
    expect(calls).toEqual([
      fetchArguments,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "rev-parse",
        "--verify",
        "FETCH_HEAD^{commit}",
      ],
      pushArguments,
    ]);
    expect(existsSync(askpassPath)).toBe(false);

    let failureAskpass = "";
    expect(() => advanceWebsiteProductionRef({
      environment: { WRENCH_RELEASE_APP_TOKEN: token },
      expectedOldSha: providerPreviousSha,
      repository: providerRepository,
      spawnImplementation(_executable: string, _args: readonly string[], options: {
        readonly env: Readonly<Record<string, string>>;
      }) {
        failureAskpass = options.env.GIT_ASKPASS ?? "";
        return { status: 1, stderr: `remote rejected ${token}`, stdout: "" };
      },
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).toThrow("remote rejected [redacted]");
    expect(existsSync(failureAskpass)).toBe(false);

    let mismatchCalls = 0;
    expect(() => advanceWebsiteProductionRef({
      environment: { WRENCH_RELEASE_APP_TOKEN: token },
      expectedOldSha: providerPreviousSha,
      repository: providerRepository,
      spawnImplementation(_executable: string, args: readonly string[]) {
        mismatchCalls += 1;
        return {
          status: 0,
          stderr: "",
          stdout: args.includes("rev-parse") ? `${providerPreviousSha}\n` : "ok",
        };
      },
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).toThrow("does not peel to the verified release SHA");
    expect(mismatchCalls).toBe(2);
  });

  test("rejects a stale explicit lease without moving the production ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrench-ref-lease-"));
    const remote = join(directory, "remote.git");
    const source = join(directory, "source");
    const runGit = (arguments_: readonly string[], cwd = source) => {
      const result = Bun.spawnSync(["git", ...arguments_], {
        cwd,
        stderr: "pipe",
        stdout: "pipe",
      });
      return Object.freeze({
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      });
    };
    const checkedGit = (arguments_: readonly string[], cwd = source): string => {
      const result = runGit(arguments_, cwd);
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };

    try {
      checkedGit(["init", "--bare", remote], directory);
      checkedGit(["init", source], directory);
      checkedGit(["config", "user.name", "Wrench lease test"]);
      checkedGit(["config", "user.email", "test@example.invalid"]);
      const file = join(source, "value.txt");
      await writeFile(file, "one\n", "utf8");
      checkedGit(["add", "value.txt"]);
      checkedGit(["commit", "-m", "one"]);
      const first = checkedGit(["rev-parse", "HEAD"]);
      checkedGit(["push", remote, `${first}:refs/heads/website-production`]);

      await writeFile(file, "two\n", "utf8");
      checkedGit(["commit", "-am", "two"]);
      const second = checkedGit(["rev-parse", "HEAD"]);
      const firstAdvance = websiteProductionPushArguments(first, second).map((value) =>
        value === "https://github.com/hraness/wrench.git" ? remote : value
      );
      checkedGit(firstAdvance);
      expect(checkedGit([
        "--git-dir",
        remote,
        "rev-parse",
        "refs/heads/website-production",
      ], directory)).toBe(second);

      await writeFile(file, "three\n", "utf8");
      checkedGit(["commit", "-am", "three"]);
      const third = checkedGit(["rev-parse", "HEAD"]);
      const staleAdvance = websiteProductionPushArguments(first, third).map((value) =>
        value === "https://github.com/hraness/wrench.git" ? remote : value
      );
      const stale = runGit(staleAdvance);
      expect(stale.exitCode).not.toBe(0);
      expect(`${stale.stdout}${stale.stderr}`).toContain("failed to push some refs");
      expect(checkedGit([
        "--git-dir",
        remote,
        "rev-parse",
        "refs/heads/website-production",
      ], directory)).toBe(second);
    } finally {
      await chmod(directory, 0o700).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("parses one authenticated GitHub server Date response", () => {
    const body = JSON.stringify(providerRef(providerPreviousSha));
    expect(parseIncludedGitHubResponse(
      `HTTP/2.0 200 OK\r\ndate: Sat, 29 Aug 2026 15:01:00 GMT\r\ncontent-type: application/json\r\n\r\n${body}\n`,
    )).toEqual({
      body: providerRef(providerPreviousSha),
      serverDate: providerPromotionServerDate,
    });

    for (const response of [
      `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${body}`,
      `HTTP/2.0 200 OK\ndate: Sat, 29 Aug 2026 15:01:00 GMT\ndate: Sat, 29 Aug 2026 15:01:01 GMT\n\n${body}`,
      `HTTP/2.0 404 Not Found\ndate: Sat, 29 Aug 2026 15:01:00 GMT\n\n${body}`,
      `HTTP/2.0 200 OK\ndate: Fri, 29 Aug 2026 15:01:00 GMT\n\n${body}`,
      "HTTP/2.0 200 OK\ndate: Sat, 29 Aug 2026 15:01:00 GMT\n\nnot-json",
      body,
    ] as const) {
      expect(() => parseIncludedGitHubResponse(response)).toThrow();
    }

    const oversizedBody = `"${"x".repeat(8 * 1024 * 1024)}"`;
    expect(() => parseIncludedGitHubResponse(
      `HTTP/2.0 200 OK\r\ndate: Sat, 29 Aug 2026 15:01:00 GMT\r\n\r\n${oversizedBody}`,
    )).toThrow("exceeds the bounded response size");

    const canonicalReceipt = encodeProviderReceipt({ a: 1 });
    expect(decodeProviderReceipt(canonicalReceipt)).toEqual({ a: 1 });
    expect(() => decodeProviderReceipt(
      Buffer.from('{ "a": 1 }', "utf8").toString("base64url"),
    )).toThrow("does not contain canonical JSON");
    expect(() => decodeProviderReceipt("A".repeat(64 * 1024 + 1)))
      .toThrow("is not bounded canonical base64url");
  });

  test("bounds the published stable-release ordering scan", async () => {
    const publishedRelease = (
      id: number,
      tagName: string,
      overrides: Readonly<Record<string, ProviderJson>> = {},
    ): ProviderJson => ({
      draft: false,
      id,
      immutable: true,
      prerelease: false,
      published_at: "2026-08-29T14:00:00Z",
      tag_name: tagName,
      ...overrides,
    });
    const releaseApi = (releases: readonly ProviderJson[]) => {
      const calls: string[] = [];
      return {
        calls,
        async get(endpoint: string): Promise<ProviderJson> {
          calls.push(endpoint);
          const match = new RegExp(
            `^/repos/${providerRepository}/releases\\?per_page=100&page=([1-6])$`,
            "u",
          ).exec(endpoint);
          if (match === null) throw new Error(`Unexpected release GET ${endpoint}`);
          const page = Number(match[1]);
          return releases.slice((page - 1) * 100, page * 100);
        },
      };
    };

    const accepted = releaseApi([
      publishedRelease(1, "v0.16.1"),
      publishedRelease(2, "v9.0.0", { draft: true }),
      publishedRelease(3, "v9.0.0", { prerelease: true }),
      publishedRelease(4, "nightly"),
    ]);
    await expect(assertReleaseTagNewerThanPublished({
      api: accepted,
      repository: providerRepository,
      verifiedTag: providerTag,
    })).resolves.toBeUndefined();
    expect(accepted.calls).toHaveLength(6);

    for (const current of ["v0.16.2", "v0.17.0"] as const) {
      await expect(assertReleaseTagNewerThanPublished({
        api: releaseApi([publishedRelease(1, current)]),
        repository: providerRepository,
        verifiedTag: providerTag,
      })).rejects.toThrow(`is not newer than ${current}`);
    }

    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi([publishedRelease(1, "v0.16.1", { immutable: false })]),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("Published stable Release v0.16.1 is not immutable");
    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi([{ draft: false, id: 1, prerelease: false, tag_name: "v0.16.1" }]),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("published releases page 1 item 0 immutable is not a boolean");
    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi([publishedRelease(1, "v0.16.1", { immutable: "true" })]),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("published releases page 1 item 0 immutable is not a boolean");
    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi([{
        draft: false,
        id: 1,
        immutable: true,
        prerelease: false,
        tag_name: "v0.16.1",
      }]),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("published releases page 1 item 0 published_at is not a string");
    for (const publishedAt of [null, "not-a-timestamp"] as const) {
      await expect(assertReleaseTagNewerThanPublished({
        api: releaseApi([publishedRelease(1, "v0.16.1", { published_at: publishedAt })]),
        repository: providerRepository,
        verifiedTag: providerTag,
      })).rejects.toThrow("published releases page 1 item 0 published_at");
    }

    const overCap = Array.from(
      { length: 501 },
      (_, index) => publishedRelease(index + 1, "nightly"),
    );
    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi(overCap),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("exceed the 500-item audit cap");
    await expect(assertReleaseTagNewerThanPublished({
      api: releaseApi([null]),
      repository: providerRepository,
      verifiedTag: providerTag,
    })).rejects.toThrow("is not an object");
  });

  test("exhausts bounded deployment and status pages without trusting API order", async () => {
    const at = (index: number): string =>
      new Date(Date.parse("2026-08-29T13:59:59Z") - index * 1_000)
        .toISOString()
        .replace(".000Z", "Z");
    for (const count of [0, 100, 101, 500] as const) {
      const deployments = Array.from(
        { length: count },
        (_, index) => providerDeployment(10_000 - index, at(index)),
      );
      if (count === 101) {
        deployments[99] = providerDeployment(1, "2026-08-29T12:00:00Z");
        deployments[100] = providerDeployment(20_000, "2026-08-29T12:00:00Z");
      }
      const api = new ProviderApiFixture({ deployments: [deployments] });
      const parsed = await collectProductionDeployments(api, providerRepository);
      expect(parsed).toHaveLength(count);
      expect(api.graphqlCalls).toHaveLength(Math.max(1, Math.ceil(count / 100)));
      if (count === 101) expect(parsed.findIndex((item: { id: number }) => item.id === 20_000))
        .toBeLessThan(parsed.findIndex((item: { id: number }) => item.id === 1));
    }

    const overCap = Array.from(
      { length: 501 },
      (_, index) => providerDeployment(20_000 - index, at(index)),
    );
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({ deployments: [overCap] }),
        providerRepository,
      ),
    ).rejects.toThrow("exceed the 500-item GraphQL audit cap");

    const duplicate = [
      providerDeployment(20, "2026-08-29T13:00:00Z"),
      providerDeployment(20, "2026-08-29T12:00:00Z"),
    ];
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({ deployments: [duplicate] }),
        providerRepository,
      ),
    ).rejects.toThrow("duplicate id");
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({ deployments: [[null]] }),
        providerRepository,
      ),
    ).rejects.toThrow("is not an object");
    await expect(
      collectProductionDeployments(
        new ProviderApiFixture({
          deployments: [[providerDeployment(21, "2026-08-29T13:00:00Z", { sha: null })]],
        }),
        providerRepository,
      ),
    ).rejects.toThrow("is not a string");

    for (const count of [0, 100, 101, 500] as const) {
      const statuses = Array.from(
        { length: count },
        (_, index) => providerStatus(30_000 - index, "pending", at(index)),
      );
      if (count === 101) {
        statuses[99] = providerStatus(2, "pending", "2026-08-29T12:00:00Z");
        statuses[100] = providerStatus(40_000, "pending", "2026-08-29T12:00:00Z");
      }
      const api = new ProviderApiFixture({ statuses: new Map([[10, [statuses]]]) });
      const parsed = await collectDeploymentStatuses(api, providerRepository, 10);
      expect(parsed).toHaveLength(count);
      expect(api.calls.filter((call) => call.includes("/statuses?"))).toHaveLength(6);
      if (count === 101) expect(parsed.findIndex((item: { id: number }) => item.id === 40_000))
        .toBeLessThan(parsed.findIndex((item: { id: number }) => item.id === 2));
    }

    const statusOverCap = Array.from(
      { length: 501 },
      (_, index) => providerStatus(50_000 - index, "pending", at(index)),
    );
    await expect(
      collectDeploymentStatuses(
        new ProviderApiFixture({ statuses: new Map([[10, [statusOverCap]]]) }),
        providerRepository,
        10,
      ),
    ).rejects.toThrow("exceeds the 500-item audit cap");

    await expect(collectDeploymentStatuses(
      new ProviderApiFixture({
        statuses: new Map([[10, [[
          providerStatus(9, "pending", "2026-08-29T13:00:00Z"),
          providerStatus(9, "success", "2026-08-29T12:00:00Z"),
        ]]]]),
      }),
      providerRepository,
      10,
    )).rejects.toThrow("duplicate id");
    await expect(collectDeploymentStatuses(
      new ProviderApiFixture({ statuses: new Map([[10, [[null]]]]) }),
      providerRepository,
      10,
    )).rejects.toThrow("is not an object");

    const oneGraphNode = providerGraphqlDeployment(80_000, "2026-08-29T12:00:00Z");
    for (const response of [
      providerGraphqlResponse([oneGraphNode], { endCursor: null, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { totalCount: 2 }),
      providerGraphqlResponse([], { endCursor: "cursor-1", hasNextPage: true, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { cost: 3, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { remaining: -1, totalCount: 1 }),
      providerGraphqlResponse([oneGraphNode], { totalCount: 501 }),
    ] as const) {
      await expect(collectProductionDeployments(
        new ProviderApiFixture({ graphqlResponses: [response] }),
        providerRepository,
      )).rejects.toThrow();
    }
    for (const deployment of [
      providerGraphqlDeployment(80_000, "2026-08-29T12:00:00Z", {
        ref: { name: "website-production" },
      }),
      providerGraphqlDeployment(80_000, "2026-08-29T12:00:00Z", {
        commitOid: providerVerifiedSha.toUpperCase(),
      }),
    ] as const) {
      await expect(collectProductionDeployments(
        new ProviderApiFixture({
          graphqlResponses: [providerGraphqlResponse([deployment])],
        }),
        providerRepository,
      )).rejects.toThrow();
    }
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [providerGraphqlResponse([oneGraphNode], {
          endCursor: "opaque+/=cursor",
          hasNextPage: true,
          remaining: 8,
          totalCount: 2,
        }), providerGraphqlResponse([
          providerGraphqlDeployment(80_001, "2026-08-29T12:00:01Z"),
        ], {
          endCursor: "done+/=cursor",
          remaining: 7,
          totalCount: 3,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("totalCount changed");

    const graphPageOne = providerGraphqlResponse(
      [providerGraphqlDeployment(80_010, "2026-08-29T12:00:00Z")],
      {
        endCursor: "cursor-repeat",
        hasNextPage: true,
        remaining: 10,
        totalCount: 2,
      },
    );
    const graphPageTwo = providerGraphqlResponse(
      [providerGraphqlDeployment(80_011, "2026-08-29T12:00:01Z")],
      {
        endCursor: "cursor-repeat",
        hasNextPage: true,
        remaining: 9,
        totalCount: 2,
      },
    );
    await expect(collectProductionDeployments(
      new ProviderApiFixture({ graphqlResponses: [graphPageOne, graphPageTwo] }),
      providerRepository,
    )).rejects.toThrow("cursor repeated");
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [graphPageOne, providerGraphqlResponse([
          providerGraphqlDeployment(80_011, "2026-08-29T12:00:01Z"),
        ], {
          endCursor: "cursor-finished",
          remaining: 9,
          resetAt: "2026-08-29T17:00:00Z",
          totalCount: 2,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("crossed a GraphQL rate-limit reset");
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [graphPageOne, providerGraphqlResponse([
          providerGraphqlDeployment(80_011, "2026-08-29T12:00:01Z"),
        ], {
          endCursor: "cursor-finished",
          remaining: 10,
          totalCount: 2,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("remaining points did not decrease monotonically");
    await expect(collectProductionDeployments(
      new ProviderApiFixture({
        graphqlResponses: [providerGraphqlResponse([
          providerGraphqlDeployment(80_012, "2026-08-29T12:00:02Z"),
        ], {
          endCursor: "cursor-1",
          hasNextPage: true,
          remaining: 7,
          totalCount: 2,
        })],
      }),
      providerRepository,
    )).rejects.toThrow("insufficient GraphQL points");
    await expect(collectProductionDeployments({
      async graphql(): Promise<ProviderJson> {
        throw new Error("simulated provider API failure");
      },
    }, providerRepository)).rejects.toThrow("simulated provider API failure");
  });

  test("stabilizes the baseline and records the actual promotion mode", async () => {
    const baselineDeployment = providerDeployment(
      10,
      "2026-08-29T13:00:00Z",
      { sha: providerPreviousSha },
    );
    const baselineApi = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      statuses: terminalBaselineStatus(),
    });
    const baseline = await createProviderBaseline({
      api: baselineApi,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    }) as Readonly<Record<string, unknown>>;
    expect(baseline.schema).toBe("wrench-provider-baseline-v3");
    expect(baseline.verifiedTag).toBe(providerTag);
    expect(baseline.publicMarker).toMatchObject({
      kind: "release",
      marker: {
        deploymentUrl: "https://wrench-10-hraness.vercel.app",
        sourceSha: providerPreviousSha,
        tag: "v0.16.1",
      },
    });
    expect(baseline.refSha).toBe(providerPreviousSha);
    expect(baseline.deploymentIds).toEqual([10]);
    expect(baseline.deploymentFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(baselineApi.calls).toHaveLength(2);
    expect(baselineApi.graphqlCalls).toHaveLength(2);
    expect(baselineApi.includedCalls).toEqual([
      `/repos/${providerRepository}/git/ref/heads/website-production`,
      `/repos/${providerRepository}/git/ref/heads/website-production`,
    ]);

    for (const refValue of [
      null,
      { object: { sha: providerPreviousSha, type: "commit" }, ref: "refs/heads/other" },
      { object: { sha: providerPreviousSha, type: "tag" }, ref: "refs/heads/website-production" },
      { object: { sha: "A".repeat(40), type: "commit" }, ref: "refs/heads/website-production" },
    ] as const) {
      await expect(createProviderBaseline({
        api: new ProviderApiFixture({ refValues: [refValue] }),
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
      })).rejects.toThrow();
    }

    const advanced = await providerReceipts("advanced");
    expect(advanced.promotion).toMatchObject({
      mode: "advanced",
      releaseAppRevocation: providerReleaseAppRevocation,
      schema: "wrench-provider-promotion-v2",
    });
    expect(advanced.promotionCalls.filter((call) => call.includes("/commits/"))).toEqual([
      `GET ${providerTagCommitEndpoint}`,
    ]);
    for (const ambiguousEndpoint of providerAmbiguousTagCommitEndpoints) {
      expect(advanced.promotionCalls).not.toContain(`GET ${ambiguousEndpoint}`);
    }
    expect(advanced.promotionCalls.filter((call) => call.startsWith("GIT CAS "))).toEqual([
      `GIT CAS ${providerRepository} ${providerPreviousSha} ${providerVerifiedSha} ${providerTag}`,
    ]);
    expect(advanced.promotionCalls.some((call) => call.includes("/deployments"))).toBe(false);
    const recovered = await providerReceipts("already-exact");
    expect(recovered.promotion).toMatchObject({
      mode: "already-exact",
      releaseAppRevocation: null,
      schema: "wrench-provider-promotion-v2",
    });
    expect(recovered.promotionCalls.filter((call) => call.includes("/commits/"))).toEqual([
      `GET ${providerTagCommitEndpoint}`,
    ]);
    for (const ambiguousEndpoint of providerAmbiguousTagCommitEndpoints) {
      expect(recovered.promotionCalls).not.toContain(`GET ${ambiguousEndpoint}`);
    }
    expect(recovered.promotionCalls.some((call) => call.startsWith("GIT CAS "))).toBe(false);

    const concurrent = providerDeployment(11, "2026-08-29T15:01:00Z");
    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[concurrent]],
        statuses: terminalBaselineStatus(11, "2026-08-29T15:01:01Z"),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("overlaps the baseline lower bound");

    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[baselineDeployment], [providerDeployment(11, "2026-08-29T14:59:00Z"), baselineDeployment]],
        statuses: terminalBaselineStatus(),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("inventory changed during the baseline");

    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[
          baselineDeployment,
        ], [
          providerDeployment(10, "2026-08-29T13:00:00Z"),
        ]],
        statuses: terminalBaselineStatus(),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("inventory changed during the baseline");

    const relevantBaselineDeployment = providerDeployment(10, "2026-08-29T13:00:00Z");
    const baselineGraph = providerGraphqlDeployment(10, "2026-08-29T13:00:00Z");
    for (const malformedGraph of [
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: null,
        state: "ACTIVE",
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: {
          ...(baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus as object,
          state: "PENDING",
        },
        state: "PENDING",
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: {
          ...(baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus as object,
          state: "FAILURE",
        },
        state: "ACTIVE",
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        creator: { __typename: "Bot", databaseId: 35613825, login: "vercel[bot]" },
      }),
      providerGraphqlDeployment(10, "2026-08-29T13:00:00Z", {
        latestStatus: {
          ...(baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus as object,
          environmentUrl: "https://other-10-hraness.vercel.app",
          logUrl: "https://other-10-hraness.vercel.app",
        },
      }),
    ] as const) {
      await expect(createProviderBaseline({
        api: new ProviderApiFixture({ graphqlDeployments: [[malformedGraph]] }),
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
      })).rejects.toThrow();
    }
    const duplicateGraphStatus = providerGraphqlDeployment(11, "2026-08-29T12:59:00Z", {
      latestStatus: (baselineGraph as Readonly<Record<string, ProviderJson>>).latestStatus,
      updatedAt: "2026-08-29T13:00:00Z",
    });
    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        graphqlDeployments: [[baselineGraph, duplicateGraphStatus]],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("duplicate latest status id");
    await expect(createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [[relevantBaselineDeployment]],
        serverDates: [providerBaselineServerDate, "2026-08-29T14:59:59.000Z"],
        statuses: terminalBaselineStatus(),
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    })).rejects.toThrow("GitHub server Date regressed");

    const auditedDeployments = Array.from(
      { length: 500 },
      (_, index) => providerDeployment(
        1_000 + index,
        new Date(Date.parse("2026-08-28T13:00:00Z") + index * 1_000)
          .toISOString()
          .replace(".000Z", "Z"),
        { sha: index % 2 === 0 ? providerVerifiedSha : providerPreviousSha },
      ),
    );
    const maxBaselineApi = new ProviderApiFixture({
      deployments: [auditedDeployments],
      serverDates: [providerBaselineServerDate, providerBaselineServerDate],
    });
    const maxBaseline = await createProviderBaseline({
      api: maxBaselineApi,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    }) as ProviderJson;
    expect((maxBaseline as Readonly<{ deploymentIds: readonly unknown[] }>).deploymentIds)
      .toHaveLength(500);
    const encodedMaxBaseline = encodeProviderReceipt(maxBaseline);
    expect(Buffer.byteLength(encodedMaxBaseline, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(maxBaselineApi.calls).toHaveLength(releaseRestRequestBudget.providerBaseline);
    expect(maxBaselineApi.graphqlCalls).toHaveLength(releaseGraphqlRequestBudget.providerBaseline);
    const maxPromotionApi = new ProviderApiFixture({
      defaultBranchShaSnapshots: [
        "3".repeat(40),
        "4".repeat(40),
        "5".repeat(40),
        "6".repeat(40),
      ],
      refSha: providerPreviousSha,
      serverDates: [providerPromotionServerDate],
    });
    const maxPromotion = await promoteWebsiteProduction({
      api: maxPromotionApi,
      baselineReceipt: maxBaseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    }) as ProviderJson;
    expect(maxPromotion).toMatchObject({ mode: "advanced" });
    expect(maxPromotionApi.calls.filter((call) => !call.startsWith("GIT CAS ")))
      .toHaveLength(releaseRestRequestBudget.providerPromotion);

    const budgetBaseline = await createProviderBaseline({
      api: new ProviderApiFixture({
        deployments: [auditedDeployments.slice(0, 499)],
        serverDates: [providerBaselineServerDate, providerBaselineServerDate],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
    }) as ProviderJson;
    const budgetPromotion = await promoteWebsiteProduction({
      api: new ProviderApiFixture({
        refSha: providerPreviousSha,
        serverDates: [providerPromotionServerDate],
      }),
      baselineReceipt: budgetBaseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    }) as ProviderJson;

    const budgetCandidate = providerDeployment(20_000, "2026-08-29T15:02:00Z");
    const budgetPending = providerStatus(
      200_000,
      "pending",
      "2026-08-29T15:02:30Z",
      {},
      20_000,
    );
    const budgetSuccess = providerStatus(
      200_001,
      "success",
      "2026-08-29T15:03:00Z",
      {},
      20_000,
    );
    const candidateSnapshots = [
      ...Array.from({ length: releaseRestRequestBudget.maxPolls - 2 }, () => [budgetPending]),
      [budgetSuccess, budgetPending],
      [budgetSuccess, budgetPending],
      [budgetSuccess, budgetPending],
      [budgetSuccess, budgetPending],
    ];
    const budgetApi = new ProviderApiFixture({
      defaultBranchShaSnapshots: [
        "3".repeat(40),
        "4".repeat(40),
        "5".repeat(40),
        "6".repeat(40),
        "7".repeat(40),
        "8".repeat(40),
      ],
      deployments: [[budgetCandidate, ...auditedDeployments.slice(0, 499)]],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [20_000, candidateSnapshots],
      ]),
    });
    await expect(waitForProviderOutcome({
      api: budgetApi,
      baselineReceipt: budgetBaseline,
      maxPolls: releaseRestRequestBudget.maxPolls,
      pollIntervalMilliseconds: 0,
      promotionReceipt: budgetPromotion,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20_000)],
      }),
      recoveryWorkflowSha: providerVerifiedSha,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 20_000, statusId: 200_001 });
    expect(budgetApi.calls).toHaveLength(releaseRestRequestBudget.providerOutcome);
    expect(budgetApi.graphqlCalls).toHaveLength(releaseGraphqlRequestBudget.providerOutcome);

    const auditedBaseline = auditedDeployments.slice(0, 499);
    const lateCandidateInventory = [budgetCandidate, ...auditedBaseline];
    const lateCandidateApi = new ProviderApiFixture({
      deployments: [
        ...Array.from(
          { length: releaseRestRequestBudget.maxPolls - 1 },
          () => auditedBaseline,
        ),
        lateCandidateInventory,
        lateCandidateInventory,
        lateCandidateInventory,
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([[20_000, [
        [budgetSuccess],
        [budgetSuccess],
        [budgetSuccess],
      ]]]),
    });
    await expect(waitForProviderOutcome({
      api: lateCandidateApi,
      baselineReceipt: budgetBaseline,
      maxPolls: releaseRestRequestBudget.maxPolls,
      pollIntervalMilliseconds: 0,
      promotionReceipt: budgetPromotion,
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20_000)],
      }),
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 20_000, statusId: 200_001 });
    expect(lateCandidateApi.graphqlCalls).toHaveLength(
      releaseGraphqlRequestBudget.providerOutcome,
    );
  });

  test("fails public production identity closed across baseline and outcome transitions", async () => {
    const baselineDeployment = providerDeployment(
      10,
      "2026-08-29T13:00:00Z",
      { sha: providerPreviousSha },
    );
    const baselineApi = (): ProviderApiFixture => new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerPreviousSha,
      serverDates: [providerBaselineServerDate, providerBaselineServerDate],
      statuses: terminalBaselineStatus(),
    });
    const missingSite = (): ProviderPublicSiteFixture => new ProviderPublicSiteFixture({
      markerSnapshots: ["missing"],
    });
    await expect(createProviderBaselineRaw({
      api: baselineApi(),
      publicSite: missingSite(),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: "v0.16.5",
    })).resolves.toMatchObject({
      publicMarker: { kind: "missing" },
      schema: "wrench-provider-baseline-v3",
      verifiedTag: "v0.16.5",
    });
    for (const verifiedTag of ["v0.16.4", "v0.16.6"] as const) {
      await expect(createProviderBaselineRaw({
        api: baselineApi(),
        publicSite: missingSite(),
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
        verifiedTag,
      })).rejects.toThrow("may be absent only for first marker-bearing release v0.16.5");
    }

    await expect(createProviderBaselineRaw({
      api: baselineApi(),
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [
          "missing",
          providerMarker(providerPreviousSha, "v0.16.1", 10),
        ],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: "v0.16.5",
    })).rejects.toThrow("changed during the baseline snapshot");
    await expect(createProviderBaselineRaw({
      api: baselineApi(),
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20)],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("does not bind the baseline production ref");
    await expect(createProviderBaselineRaw({
      api: baselineApi(),
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerPreviousSha, "v0.16.1", 11)],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("does not bind the latest baseline deployment URL");

    const newerBaseline = providerDeployment(
      11,
      "2026-08-29T13:01:00Z",
      { sha: providerPreviousSha },
    );
    await expect(createProviderBaselineRaw({
      api: new ProviderApiFixture({
        deployments: [[newerBaseline, baselineDeployment]],
        refSha: providerPreviousSha,
        serverDates: [providerBaselineServerDate, providerBaselineServerDate],
        statuses: new Map([
          [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
          [11, [[providerStatus(110, "success", "2026-08-29T13:02:00Z", {}, 11)]]],
        ]),
      }),
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerPreviousSha, "v0.16.1", 10)],
      }),
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("does not bind the latest baseline deployment URL");

    const { baseline, promotion } = await providerReceipts("advanced");
    const candidate = providerDeployment(20, "2026-08-29T15:02:00Z");
    const pending = providerStatus(200, "pending", "2026-08-29T15:02:30Z", {}, 20);
    const success = providerStatus(201, "success", "2026-08-29T15:03:00Z", {}, 20);
    const outcomeApi = (
      statusSnapshots: ProviderJson[][],
      deployments: ProviderJson[][] = [[candidate, baselineDeployment]],
    ): ProviderApiFixture => new ProviderApiFixture({
      deployments,
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, statusSnapshots],
      ]),
    });
    const wait = (
      api: ProviderApiFixture,
      publicSite: ProviderPublicSiteFixture,
      maxPolls = 2,
    ): Promise<unknown> => waitForProviderOutcomeRaw({
      api,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "push",
      maxPolls,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      publicSite,
      recoveryWorkflowSha: "",
      sleep: async () => {},
      ...providerAuthority,
    });

    await expect(wait(
      outcomeApi([[pending]], [[baselineDeployment]]),
      new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker("3".repeat(40), "v0.15.0", 30)],
      }),
      1,
    )).rejects.toThrow("exposed a third release identity");

    await expect(wait(
      outcomeApi([[pending], [pending]]),
      new ProviderPublicSiteFixture({
        markerSnapshots: [
          providerMarker(providerVerifiedSha, providerTag, 20),
          providerMarker(providerPreviousSha, "v0.16.1", 10),
        ],
      }),
    )).rejects.toThrow("regressed after exposing the target release");

    await expect(wait(
      outcomeApi([[pending], [pending]], [[baselineDeployment]]),
      new ProviderPublicSiteFixture({
        markerSnapshots: [
          providerMarker(providerVerifiedSha, providerTag, 20),
          providerMarker(providerVerifiedSha, providerTag, 21),
        ],
      }),
    )).rejects.toThrow("changed within the target release identity");

    await expect(wait(
      outcomeApi([[success]]),
      new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 21)],
      }),
      1,
    )).rejects.toThrow("does not bind the pinned candidate deployment URL");

    await expect(wait(
      outcomeApi([[success]]),
      new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerPreviousSha, "v0.16.1", 10)],
      }),
      1,
    )).rejects.toThrow("provider observation poll budget exhausted before its monotonic deadline");

    const stablePublic = new ProviderPublicSiteFixture({
      markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20)],
    });
    await expect(wait(outcomeApi([[success], [success], [success]]), stablePublic, 1))
      .resolves.toEqual({ deploymentId: 20, statusId: 201 });
    expect(stablePublic.calls).toEqual([
      "marker",
      "marker",
      "health /",
      "health /providers/beeper/",
      "health /llms.txt",
      "www",
      "marker",
      "health /",
      "health /providers/beeper/",
      "health /llms.txt",
      "www",
    ]);
    expect(stablePublic.timeouts).toHaveLength(11);
    expect(stablePublic.timeouts.every((value) => value > 0 && value <= 10_000)).toBe(true);

    const changingHealth = new ProviderPublicSiteFixture({
      healthDigests: new Map([["/", ["a".repeat(64), "b".repeat(64)]]]),
      markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20)],
    });
    await expect(wait(outcomeApi([[success], [success], [success]]), changingHealth, 1))
      .rejects.toThrow("public production routes changed during terminal verification");
    const changingRedirect = new ProviderPublicSiteFixture({
      markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20)],
      redirectDigests: ["a".repeat(64), "b".repeat(64)],
    });
    await expect(wait(outcomeApi([[success], [success], [success]]), changingRedirect, 1))
      .rejects.toThrow("public production routes changed during terminal verification");
  });

  test("fails promotion closed on comparison, ref, and leased-writer races", async () => {
    const { baseline, baselineDeployment } = await providerReceipts("advanced");
    const tagObjectTarget = new ProviderApiFixture({
      tagSnapshots: [providerTagObjectSha],
    });
    await expect(promoteWebsiteProduction({
      api: tagObjectTarget,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("tag v0.16.2 moved from the verified release commit");
    expect(tagObjectTarget.calls).toEqual([`GET ${providerTagCommitEndpoint}`]);
    expect(tagObjectTarget.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);

    const staleLatest = new ProviderApiFixture({
      latestSnapshots: [providerLatest({ tag_name: "v0.16.1" })],
      refSha: providerPreviousSha,
    });
    await expect(promoteWebsiteProduction({
      api: staleLatest,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("Release v0.16.2 is no longer Latest");
    expect(staleLatest.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);

    const { commits: _omittedCommits, ...missingCommits } = providerCompare() as Readonly<
      Record<string, ProviderJson>
    >;
    for (const compare of [
      providerCompare({ ahead_by: 0 }),
      providerCompare({ ahead_by: 1.5 }),
      providerCompare({ behind_by: 1 }),
      providerCompare({ status: "diverged" }),
      providerCompare({ base_commit: { sha: "3".repeat(40) } }),
      providerCompare({ merge_base_commit: { sha: "3".repeat(40) } }),
      missingCommits,
      providerCompare({ commits: null }),
      providerCompare({ commits: [] }),
      providerCompare({ commits: [null] }),
      providerCompare({ commits: [{ sha: "A".repeat(40) }] }),
      providerCompare({ commits: [{ sha: "3".repeat(40) }] }),
      null,
    ] as const) {
      const api = new ProviderApiFixture({
        deployments: [[baselineDeployment]],
        statuses: terminalBaselineStatus(),
      });
      api.compare = compare;
      await expect(promoteWebsiteProduction({
        api,
        baselineReceipt: baseline,
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
        verifiedTag: providerTag,
      })).rejects.toThrow();
      expect(api.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);
    }

    const refRace = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSnapshots: [providerPreviousSha, "3".repeat(40)],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: refRace,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("moved before promotion");
    expect(refRace.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);

    const patchFailure = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      statuses: terminalBaselineStatus(),
    });
    patchFailure.patchError = new Error("simulated leased push race");
    await expect(promoteWebsiteProduction({
      api: patchFailure,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("simulated leased push race");

    const movedBeforePatch = new ProviderApiFixture({
      defaultBranchShaSnapshots: ["3".repeat(40)],
      deployments: [[baselineDeployment]],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: movedBeforePatch,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).resolves.toMatchObject({ mode: "advanced" });
    expect(movedBeforePatch.calls.filter((call) => call.startsWith("GIT CAS "))).toHaveLength(1);

    const movedAfterPatch = new ProviderApiFixture({
      defaultBranchShaSnapshots: [providerVerifiedSha, "3".repeat(40)],
      deployments: [[baselineDeployment]],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: movedAfterPatch,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).resolves.toMatchObject({ mode: "advanced" });
    expect(movedAfterPatch.calls.filter((call) => call.startsWith("GIT CAS "))).toHaveLength(1);

    const alreadyExact = await providerReceipts("already-exact");
    const alreadyExactSourceDrift = new ProviderApiFixture({
      defaultBranchShaSnapshots: ["3".repeat(40)],
      refSha: providerVerifiedSha,
      serverDates: [providerPromotionServerDate],
    });
    await expect(promoteWebsiteProduction({
      api: alreadyExactSourceDrift,
      baselineReceipt: alreadyExact.baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).resolves.toMatchObject({ mode: "already-exact" });
    const alreadyExactTerminalRefRead = alreadyExactSourceDrift.calls.lastIndexOf(
      `GET /repos/${providerRepository}/git/ref/heads/website-production`,
    );
    const alreadyExactSourceRead = alreadyExactSourceDrift.calls.indexOf(
      `GET /repos/${providerRepository}`,
    );
    expect(alreadyExactTerminalRefRead).toBeGreaterThanOrEqual(0);
    expect(alreadyExactSourceRead).toBeGreaterThan(alreadyExactTerminalRefRead);
    expect(alreadyExactSourceDrift.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);

    for (const sourceCompare of [
      providerCompare({ status: "diverged" }),
      providerCompare({ behind_by: 1 }),
      providerCompare({ base_commit: { sha: "9".repeat(40) } }),
      providerCompare({ merge_base_commit: { sha: "9".repeat(40) } }),
      providerCompare({ commits: [] }),
    ] as const) {
      const invalidSourceAncestry = new ProviderApiFixture({
        defaultBranchShaSnapshots: ["3".repeat(40)],
        deployments: [[baselineDeployment]],
        sourceCompare,
        statuses: terminalBaselineStatus(),
      });
      await expect(promoteWebsiteProduction({
        api: invalidSourceAncestry,
        baselineReceipt: baseline,
        defaultBranch: "main",
        eventName: "workflow_dispatch",
        recoveryWorkflowSha: providerVerifiedSha,
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
        verifiedTag: providerTag,
      })).rejects.toThrow();
      expect(invalidSourceAncestry.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);
    }

    const sourceRollback = new ProviderApiFixture({
      defaultBranchShaSnapshots: ["3".repeat(40), providerVerifiedSha],
      deployments: [[baselineDeployment]],
      sourceCompareSnapshots: [
        providerCompare({
          base_commit: { sha: providerVerifiedSha },
          commits: [{ sha: "3".repeat(40) }],
          merge_base_commit: { sha: providerVerifiedSha },
        }),
        providerCompare({
          base_commit: { sha: "3".repeat(40) },
          commits: [{ sha: providerVerifiedSha }],
          merge_base_commit: { sha: "3".repeat(40) },
          status: "behind",
        }),
      ],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: sourceRollback,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      recoveryWorkflowSha: providerVerifiedSha,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("main sandwich does not preserve protected linear ancestry");
    expect(sourceRollback.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);

    const postPatchMismatch = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSnapshots: [providerPreviousSha, providerPreviousSha, providerPreviousSha],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: postPatchMismatch,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("after promotion");
    expect(postPatchMismatch.calls.filter((call) => call.startsWith("GIT CAS "))).toHaveLength(1);

    const missingRef = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refValues: [null],
      statuses: terminalBaselineStatus(),
    });
    await expect(promoteWebsiteProduction({
      api: missingRef,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("is not an object");
    expect(missingRef.calls.some((call) => call.startsWith("GIT CAS "))).toBe(false);

    await expect(promoteWebsiteProduction({
      api: new ProviderApiFixture({
        deployments: [[baselineDeployment]],
        serverDates: [providerReleasePublishedAt.replace("Z", ".000Z")],
        statuses: terminalBaselineStatus(),
      }),
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    })).rejects.toThrow("promotion boundary");

    const readToWriteRace = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      serverDates: ["2026-08-29T15:02:00.000Z"],
      statuses: terminalBaselineStatus(),
    });
    const racePromotion = await promoteWebsiteProduction({
      api: readToWriteRace,
      baselineReceipt: baseline,
      repository: providerRepository,
      verifiedSha: providerVerifiedSha,
      verifiedTag: providerTag,
    }) as ProviderJson;
    expect((racePromotion as Readonly<Record<string, ProviderJson>>).boundaryAt)
      .toBe("2026-08-29T15:02:00.000Z");
    const prePatchDeployment = providerDeployment(20, "2026-08-29T15:02:00Z");
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture({
        deployments: [[prePatchDeployment, baselineDeployment]],
        refSha: providerVerifiedSha,
        statuses: new Map([
          [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
          [20, [[providerStatus(201, "success", "2026-08-29T15:03:00Z", {}, 20)]]],
        ]),
      }),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: racePromotion,
      sleep: async () => {},
    })).rejects.toThrow("concurrent promotion gap");

  });

  test("waits from pending to one twice-confirmed exact Vercel Production success", async () => {
    const { baseline, baselineDeployment, promotion } = await providerReceipts("advanced");
    const candidate = providerDeployment(20, "2026-08-29T15:02:00Z");
    const candidateAt = "2026-08-29T15:02:00Z";
    const successAt = "2026-08-29T15:03:00Z";
    const pending = providerStatus(200, "pending", "2026-08-29T15:02:30Z", {}, 20);
    const success = providerStatus(201, "success", successAt, {}, 20);
    const api = new ProviderApiFixture({
      deployments: [
        [candidate, baselineDeployment],
        [candidate, baselineDeployment],
        [candidate, baselineDeployment],
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [
          [providerStatus(100, "success", "2026-08-29T13:01:00Z")],
          [providerStatus(100, "success", "2026-08-29T13:01:00Z")],
        ]],
        [20, [[pending], [success, pending], [success, pending]]],
      ]),
    });
    const result = await waitForProviderOutcome({
      api,
      baselineReceipt: baseline,
      maxPolls: 4,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    });
    expect(result).toEqual({ deploymentId: 20, statusId: 201 });
    expect(api.graphqlCalls).toHaveLength(5);
    expect(api.calls.filter((call) => call.includes("/deployments/20/statuses?"))).toHaveLength(30);
    expect(api.calls.filter((call) => call === `GET /repos/${providerRepository}/deployments/20`))
      .toHaveLength(4);

    const baselineStatus = providerStatus(100, "success", "2026-08-29T13:01:00Z");
    const baselineGraph = graphqlDeploymentFromRest(baselineDeployment, [baselineStatus]);
    const pendingGraph = graphqlDeploymentFromRest(candidate, [pending]);
    const successGraph = graphqlDeploymentFromRest(candidate, [success, pending]);
    const graphLagApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [
        [pendingGraph, baselineGraph],
        [successGraph, baselineGraph],
        [successGraph, baselineGraph],
        [successGraph, baselineGraph],
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[baselineStatus]]],
        [20, [
          [success, pending],
          [success, pending],
          [success, pending],
          [success, pending],
        ]],
      ]),
    });
    await expect(waitForProviderOutcome({
      api: graphLagApi,
      baselineReceipt: baseline,
      maxPolls: 2,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 20, statusId: 201 });
    expect(graphLagApi.graphqlCalls).toHaveLength(4);
    expect(graphLagApi.calls.filter(
      (call) => call === `GET /repos/${providerRepository}/releases/latest`,
    )).toHaveLength(4);

    const staleGraphApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [[successGraph, baselineGraph]],
      refSha: providerVerifiedSha,
      statuses: new Map([[20, [[
        providerStatus(202, "pending", "2026-08-29T15:03:01Z", {}, 20),
        success,
      ]]]]),
    });
    await expect(waitForProviderOutcome({
      api: staleGraphApi,
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("poll budget exhausted");

    const staleGraphFailureApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [[successGraph, baselineGraph]],
      refSha: providerVerifiedSha,
      statuses: new Map([[20, [[
        providerStatus(202, "failure", "2026-08-29T15:03:01Z", {}, 20),
        success,
      ]]]]),
    });
    await expect(waitForProviderOutcome({
      api: staleGraphFailureApi,
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("ended in failure");

    const confirmationRegressionApi = new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      graphqlDeployments: [
        [successGraph, baselineGraph],
        [pendingGraph, baselineGraph],
      ],
      refSha: providerVerifiedSha,
      statuses: new Map([[20, [[success], [success]]]]),
    });
    await expect(waitForProviderOutcome({
      api: confirmationRegressionApi,
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("regressed during success confirmation");

    for (const state of ["error", "failure", "inactive"] as const) {
      const failed = providerStatus(300, state, successAt, {}, 20);
      const graphFailureApi = new ProviderApiFixture({
        deployments: [[candidate, baselineDeployment]],
        graphqlDeployments: [[
          graphqlDeploymentFromRest(candidate, [failed]),
          baselineGraph,
        ]],
        refSha: providerVerifiedSha,
        statuses: new Map([[20, [[success]]]]),
      });
      await expect(waitForProviderOutcome({
        api: graphFailureApi,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      })).rejects.toThrow(`ended in ${state}`);
    }

    for (const state of ["error", "failure", "inactive"] as const) {
      const historicalFailure = providerStatus(
        199,
        state,
        "2026-08-29T15:02:45Z",
        {},
        20,
      );
      const pollHistoryApi = new ProviderApiFixture({
        deployments: [[candidate, baselineDeployment]],
        graphqlDeployments: [[successGraph, baselineGraph]],
        refSha: providerVerifiedSha,
        statuses: new Map([[20, [[success, historicalFailure]]]]),
      });
      await expect(waitForProviderOutcome({
        api: pollHistoryApi,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      })).rejects.toThrow(`ended in ${state}`);

      const firstConfirmationHistoryApi = new ProviderApiFixture({
        deployments: [[candidate, baselineDeployment]],
        refSha: providerVerifiedSha,
        statuses: new Map([
          [10, [[baselineStatus]]],
          [20, [[success], [success, historicalFailure]]],
        ]),
      });
      await expect(waitForProviderOutcome({
        api: firstConfirmationHistoryApi,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      })).rejects.toThrow(`ended in ${state}`);

      const finalConfirmationHistoryApi = new ProviderApiFixture({
        deployments: [[candidate, baselineDeployment]],
        refSha: providerVerifiedSha,
        statuses: new Map([
          [10, [[baselineStatus]]],
          [20, [
            [success],
            [success],
            [success, historicalFailure],
          ]],
        ]),
      });
      await expect(waitForProviderOutcome({
        api: finalConfirmationHistoryApi,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      })).rejects.toThrow(`ended in ${state}`);
    }

    const successGraphRecord = successGraph as Readonly<Record<string, ProviderJson>>;
    const successGraphStatus = successGraphRecord.latestStatus as Readonly<
      Record<string, ProviderJson>
    >;
    for (const latestStatus of [
      { ...successGraphStatus, id: "different-status-node" },
      {
        ...successGraphStatus,
        createdAt: "2026-08-29T15:02:59Z",
        updatedAt: "2026-08-29T15:02:59Z",
      },
      {
        ...successGraphStatus,
        creator: { __typename: "Bot", databaseId: 1, login: "vercel" },
      },
      {
        ...successGraphStatus,
        environmentUrl: "https://wrench-other-hraness.vercel.app",
        logUrl: "https://wrench-other-hraness.vercel.app",
      },
    ] as const) {
      const disagreementApi = new ProviderApiFixture({
        deployments: [[candidate, baselineDeployment]],
        graphqlDeployments: [[
          providerGraphqlDeployment(20, candidateAt, {
            latestStatus,
            updatedAt: successAt,
          }),
          baselineGraph,
        ]],
        refSha: providerVerifiedSha,
        statuses: new Map([[20, [[success]]]]),
      });
      await expect(waitForProviderOutcome({
        api: disagreementApi,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      })).rejects.toThrow();
    }

    const recovery = await providerReceipts("already-exact");
    const recoveryApi = new ProviderApiFixture({
      deployments: [[recovery.baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[
          providerStatus(100, "success", "2026-08-29T14:06:00Z"),
        ]]],
      ]),
    });
    await expect(waitForProviderOutcome({
      api: recoveryApi,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 10, statusId: 100 });
  });

  test("rejects provider identity, concurrency, timeout, and final-readback failures", async () => {
    const { baseline, baselineDeployment, promotion } = await providerReceipts("advanced");
    const candidateAt = "2026-08-29T15:02:00Z";
    const successAt = "2026-08-29T15:03:00Z";
    const candidateStatus = (
      id: number,
      state: string,
      createdAt: string,
      overrides: Readonly<Record<string, ProviderJson>> = {},
    ): ProviderJson => providerStatus(id, state, createdAt, overrides, 20);
    const waitCase = (
      candidate: ProviderJson,
      statusSnapshots: ProviderJson[][],
      deployments: ProviderJson[][] = [[candidate, baselineDeployment], [candidate, baselineDeployment]],
      refSnapshots: readonly string[] = [],
      tagSnapshots: readonly string[] = [],
      releaseSnapshots: readonly ProviderJson[] = [],
      latestSnapshots: readonly ProviderJson[] = [],
    ): ProviderApiFixture => new ProviderApiFixture({
      deployments,
      latestSnapshots,
      refSha: providerVerifiedSha,
      refSnapshots,
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, statusSnapshots],
      ]),
      tagSnapshots,
      releaseSnapshots,
    });
    const run = (api: ProviderApiFixture, maxPolls = 2): Promise<unknown> =>
      waitForProviderOutcome({
        api,
        baselineReceipt: baseline,
        maxPolls,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
      });

    for (const candidate of [
      providerDeployment(20, candidateAt, { sha: "3".repeat(40) }),
      providerDeployment(20, candidateAt, { ref: "website-production" }),
      providerDeployment(20, candidateAt, { ref: providerTag }),
      providerDeployment(20, candidateAt, { ref: "A".repeat(40) }),
      providerDeployment(20, candidateAt, { ref: null }),
      providerDeployment(20, candidateAt, { ref: providerPreviousSha }),
      providerDeployment(20, candidateAt, { task: "other" }),
      providerDeployment(20, candidateAt, { environment: "Preview" }),
      providerDeployment(20, candidateAt, { original_environment: null }),
      providerDeployment(20, candidateAt, {
        creator: { id: 1, login: "vercel[bot]", type: "Bot" },
      }),
      providerDeployment(20, candidateAt, {
        creator: { id: 35613825, login: "other[bot]", type: "Bot" },
      }),
      providerDeployment(20, candidateAt, {
        creator: { id: 35613825, login: "vercel[bot]", type: "User" },
      }),
    ] as const) {
      await expect(run(waitCase(candidate, [[candidateStatus(201, "success", successAt)]])))
        .rejects.toThrow("deployment");
    }

    const gapCandidate = providerDeployment(20, "2026-08-29T15:01:00Z");
    await expect(run(waitCase(gapCandidate, [[candidateStatus(201, "success", successAt)]])))
      .rejects.toThrow("concurrent promotion gap");

    const competing = [
      providerDeployment(21, "2026-08-29T15:02:01Z"),
      providerDeployment(20, candidateAt),
      baselineDeployment,
    ];
    await expect(run(waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt)]],
      [competing],
    ))).rejects.toThrow("more than one new Production deployment");

    const noCandidate = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: terminalBaselineStatus(),
    });
    await expect(run(noCandidate, 2)).rejects.toThrow("poll budget exhausted");

    const emptyStatuses = waitCase(providerDeployment(20, candidateAt), [[], []]);
    await expect(run(emptyStatuses, 2)).rejects.toThrow("poll budget exhausted");

    const disappearingStatus = waitCase(providerDeployment(20, candidateAt), [
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z")],
      [],
    ]);
    await expect(run(disappearingStatus, 2)).rejects.toThrow("statuses disappeared");

    const mutatedStatus = waitCase(providerDeployment(20, candidateAt), [
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z")],
      [candidateStatus(200, "success", "2026-08-29T15:02:30Z")],
    ]);
    await expect(run(mutatedStatus, 2)).rejects.toThrow("status 200 changed");
    const mutatedStatusUrl = waitCase(providerDeployment(20, candidateAt), [
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z")],
      [candidateStatus(200, "pending", "2026-08-29T15:02:30Z", {
        environment_url: "https://wrench-alt-hraness.vercel.app",
        log_url: "https://wrench-alt-hraness.vercel.app",
        target_url: "https://wrench-alt-hraness.vercel.app",
      })],
    ]);
    await expect(run(mutatedStatusUrl, 2)).rejects.toThrow("status 200 changed");

    for (const state of ["error", "failure", "inactive"] as const) {
      await expect(run(waitCase(
        providerDeployment(20, candidateAt),
        [[candidateStatus(201, state, successAt)]],
      ))).rejects.toThrow(`ended in ${state}`);
    }

    const switched = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(200, "pending", "2026-08-29T15:02:30Z")]],
      [
        [providerDeployment(20, candidateAt), baselineDeployment],
        [providerDeployment(21, "2026-08-29T15:02:01Z"), baselineDeployment],
      ],
    );
    await expect(run(switched)).rejects.toThrow();

    const disappeared = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(200, "pending", "2026-08-29T15:02:30Z")]],
    );
    disappeared.deploymentDetailError = new Error("simulated deployment disappearance");
    await expect(run(disappeared)).rejects.toThrow("simulated deployment disappearance");

    const successRegression = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [
          candidateStatus(202, "pending", "2026-08-29T15:03:01Z"),
          candidateStatus(201, "success", successAt),
        ],
      ],
    );
    await expect(run(successRegression)).rejects.toThrow("success changed");

    const finalStatusInventoryRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [
          candidateStatus(201, "success", successAt),
          candidateStatus(200, "pending", "2026-08-29T15:02:30Z"),
        ],
        [
          candidateStatus(201, "success", successAt),
          candidateStatus(200, "pending", "2026-08-29T15:02:30Z"),
        ],
        [
          candidateStatus(201, "success", successAt),
          candidateStatus(200, "pending", "2026-08-29T15:02:30Z"),
          candidateStatus(199, "queued", "2026-08-29T15:02:10Z"),
        ],
      ],
    );
    await expect(run(finalStatusInventoryRace)).rejects.toThrow("success changed");

    const finalInventoryRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      [
        [providerDeployment(20, candidateAt), baselineDeployment],
        [providerDeployment(20, candidateAt), baselineDeployment],
        [
          providerDeployment(21, "2026-08-29T15:03:01Z"),
          providerDeployment(20, candidateAt),
          baselineDeployment,
        ],
      ],
    );
    await expect(run(finalInventoryRace)).rejects.toThrow();

    const finalRefRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [providerVerifiedSha, providerVerifiedSha, providerVerifiedSha, "3".repeat(40)],
    );
    await expect(run(finalRefRace)).rejects.toThrow("website-production moved");

    const finalTagRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [],
      [providerVerifiedSha, providerVerifiedSha, providerVerifiedSha, providerTagObjectSha],
    );
    await expect(run(finalTagRace)).rejects.toThrow("tag v0.16.2 moved");

    const finalReleaseRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [],
      [],
      [
        providerRelease(),
        providerRelease(),
        providerRelease(),
        providerRelease({ published_at: "2026-08-29T14:00:01Z" }),
      ],
    );
    await expect(run(finalReleaseRace)).rejects.toThrow("Release identity changed");

    const finalReleaseIdRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [],
      [],
      [
        providerRelease(),
        providerRelease(),
        providerRelease(),
        providerRelease({ id: 11 }),
      ],
    );
    await expect(run(finalReleaseIdRace)).rejects.toThrow("Release identity changed");

    const wrongStatusBot = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt, {
        creator: { id: 2, login: "vercel[bot]", type: "Bot" },
      })]],
    );
    await expect(run(wrongStatusBot)).rejects.toThrow("pinned Vercel bot");

    const wrongDeploymentStatusesUrl = waitCase(
      providerDeployment(20, candidateAt, {
        statuses_url: `https://api.github.com/repos/${providerRepository}/deployments/21/statuses`,
      }),
      [[candidateStatus(201, "success", successAt)]],
    );
    await expect(run(wrongDeploymentStatusesUrl)).rejects.toThrow("statuses_url");

    const refBoundCandidate = providerDeployment(20, candidateAt);
    const refDrift = new ProviderApiFixture({
      deploymentDetails: [
        refBoundCandidate,
        providerDeployment(20, candidateAt, { ref: providerPreviousSha }),
      ],
      deployments: [[refBoundCandidate, baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, [[candidateStatus(201, "success", successAt)]]],
      ]),
    });
    await expect(run(refDrift, 1)).rejects.toThrow(".ref does not bind its exact SHA");

    const duplicateStatusNodeId = waitCase(
      providerDeployment(20, candidateAt),
      [[
        candidateStatus(201, "success", successAt),
        candidateStatus(200, "pending", "2026-08-29T15:02:30Z", {
          node_id: "status-201",
        }),
      ]],
    );
    await expect(run(duplicateStatusNodeId)).rejects.toThrow("duplicate node id status-201");

    for (const overrides of [
      { deployment_url: `https://api.github.com/repos/${providerRepository}/deployments/21` },
      { environment: "Preview" },
      { environment_url: "http://wrench-20-hraness.vercel.app" },
      { environment_url: "https://wrench-20-hraness.vercel.app/" },
      { log_url: "https://wrench-other-hraness.vercel.app" },
      { target_url: "https://wrench-other-hraness.vercel.app" },
    ] as const) {
      await expect(run(waitCase(
        providerDeployment(20, candidateAt),
        [[candidateStatus(201, "success", successAt, overrides)]],
      ))).rejects.toThrow();
    }

    const tiedStatusSecond = waitCase(providerDeployment(20, candidateAt), [[
      candidateStatus(202, "success", successAt),
      candidateStatus(201, "pending", successAt),
    ]]);
    await expect(run(tiedStatusSecond)).resolves.toEqual({ deploymentId: 20, statusId: 202 });

    const initialLatestRace = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt)]],
      undefined,
      [],
      [],
      [],
      [providerLatest({ tag_name: "v0.16.1" })],
    );
    await expect(run(initialLatestRace)).rejects.toThrow("Release v0.16.2 is no longer Latest");

    const decisiveLatestRace = waitCase(
      providerDeployment(20, candidateAt),
      [[candidateStatus(201, "success", successAt)]],
      undefined,
      [],
      [],
      [],
      [providerLatest(), providerLatest({ tag_name: "v0.16.1" })],
    );
    await expect(run(decisiveLatestRace)).rejects.toThrow("Release v0.16.2 is no longer Latest");

    const terminalLatestRace = waitCase(
      providerDeployment(20, candidateAt),
      [
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
        [candidateStatus(201, "success", successAt)],
      ],
      undefined,
      [],
      [],
      [],
      [
        providerLatest(),
        providerLatest(),
        providerLatest(),
        providerLatest({ tag_name: "v0.16.1" }),
      ],
    );
    await expect(run(terminalLatestRace)).rejects.toThrow("Release v0.16.2 is no longer Latest");

    await expect(waitForProviderOutcomeRaw({
      api: new ProviderApiFixture({ defaultBranchSnapshots: ["main", "release"] }),
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      recoveryWorkflowSha: providerVerifiedSha,
      sleep: async () => {},
      ...providerAuthority,
    })).rejects.toThrow("default branch moved during source verification");

    const recoverySourceShaRace = new ProviderApiFixture({
      defaultBranchShaSnapshots: [providerVerifiedSha, "3".repeat(40)],
      deployments: [[providerDeployment(20, candidateAt), baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, [
          [candidateStatus(201, "success", successAt)],
          [candidateStatus(201, "success", successAt)],
          [candidateStatus(201, "success", successAt)],
        ]],
      ]),
    });
    await expect(waitForProviderOutcomeRaw({
      api: recoverySourceShaRace,
      baselineReceipt: baseline,
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20)],
      }),
      recoveryWorkflowSha: providerVerifiedSha,
      sleep: async () => {},
      ...providerAuthority,
    })).resolves.toBeDefined();

    const wrongMode = {
      ...(promotion as Readonly<Record<string, ProviderJson>>),
      mode: "already-exact",
    };
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture(),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: wrongMode,
      sleep: async () => {},
    })).rejects.toThrow("releaseAppRevocation contradicts its mode");
    const wrongTransition = {
      ...(promotion as Readonly<Record<string, ProviderJson>>),
      mode: "already-exact",
      releaseAppRevocation: null,
    };
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture(),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: wrongTransition,
      sleep: async () => {},
    })).rejects.toThrow("promotion receipt mode contradicts the recorded ref transition");
    const immediateRevocation = {
      ...(promotion as Readonly<Record<string, ProviderJson>>),
      releaseAppRevocation: {
        ...providerReleaseAppRevocation,
        observationCount: 2,
        propagationObserved: false,
      },
    };
    await expect(waitForProviderOutcome({
      api: waitCase(
        providerDeployment(20, candidateAt),
        [[candidateStatus(201, "success", successAt)]],
      ),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: immediateRevocation,
      sleep: async () => {},
    })).resolves.toEqual({ deploymentId: 20, statusId: 201 });
    const missingRevocation = {
      ...(promotion as Readonly<Record<string, ProviderJson>>),
    } as Record<string, ProviderJson>;
    delete missingRevocation.releaseAppRevocation;
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture(),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: missingRevocation,
      sleep: async () => {},
    })).rejects.toThrow("promotion receipt has an unexpected shape");
    for (const releaseAppRevocation of [
      null,
      { ...providerReleaseAppRevocation, converged: false },
      { ...providerReleaseAppRevocation, observationCount: 2 },
      { ...providerReleaseAppRevocation, observationCount: 11 },
      { ...providerReleaseAppRevocation, propagationObserved: false },
      { ...providerReleaseAppRevocation, stableDenials: 1 },
      { ...providerReleaseAppRevocation, extra: true },
    ] as const) {
      await expect(waitForProviderOutcome({
        api: new ProviderApiFixture(),
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: {
          ...(promotion as Readonly<Record<string, ProviderJson>>),
          releaseAppRevocation,
        },
        sleep: async () => {},
      })).rejects.toThrow("promotion receipt releaseAppRevocation");
    }
    const invalidReleaseId = {
      ...(promotion as Readonly<Record<string, ProviderJson>>),
      releaseId: 0,
    };
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture(),
      baselineReceipt: baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: invalidReleaseId,
      sleep: async () => {},
    })).rejects.toThrow("promotion receipt releaseId");
    const tamperedBaseline = {
      ...(baseline as Readonly<Record<string, ProviderJson>>),
      completedAt: "2026-08-29T15:00:00.600Z",
    };
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture(),
      baselineReceipt: tamperedBaseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: promotion,
      sleep: async () => {},
    })).rejects.toThrow("does not bind the baseline receipt");

    for (const authority of [
      { repository: "hraness/other", verifiedSha: providerVerifiedSha, verifiedTag: providerTag },
      { repository: providerRepository, verifiedSha: "3".repeat(40), verifiedTag: providerTag },
      { repository: providerRepository, verifiedSha: providerVerifiedSha, verifiedTag: "v9.9.9" },
    ] as const) {
      const api = new ProviderApiFixture();
      await expect(waitForProviderOutcomeRaw({
        api,
        baselineReceipt: baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: promotion,
        sleep: async () => {},
        ...authority,
      })).rejects.toThrow("authoritative release inputs");
      expect(api.calls).toHaveLength(0);
    }
  });

  test("enforces one half-open monotonic 20-minute provider observation deadline", async () => {
    const { baseline, baselineDeployment, promotion } = await providerReceipts("advanced");
    const candidateAt = "2026-08-29T15:02:00Z";
    const successAt = "2026-08-29T15:03:00Z";
    const candidate = providerDeployment(20, candidateAt);
    const success = providerStatus(201, "success", successAt, {}, 20);
    const noCandidate = (
      readHook?: (timeoutMilliseconds: number | undefined) => void,
    ): ProviderApiFixture => new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      readHook,
      refSha: providerVerifiedSha,
      statuses: terminalBaselineStatus(),
    });
    const successCase = (
      readHook?: (timeoutMilliseconds: number | undefined) => void,
    ): ProviderApiFixture => new ProviderApiFixture({
      deployments: [[candidate, baselineDeployment]],
      readHook,
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, [[success], [success], [success]]],
      ]),
    });
    const run = (
      api: ProviderApiFixture,
      monotonicNow: () => number,
      sleep: (milliseconds: number) => Promise<void>,
      maxPolls = 20,
      pollIntervalMilliseconds = 60_000,
    ): Promise<unknown> => waitForProviderOutcome({
      api,
      baselineReceipt: baseline,
      maxPolls,
      monotonicNow,
      pollIntervalMilliseconds,
      promotionReceipt: promotion,
      publicSite: new ProviderPublicSiteFixture({
        markerSnapshots: [providerMarker(providerVerifiedSha, providerTag, 20)],
        readHook: (timeoutMilliseconds) => api.readHook?.(timeoutMilliseconds),
      }),
      sleep,
    });

    let now = 0;
    const expectedPartialSleepRequests = [59_997, 29_999, 15_000];
    expect(expectedPartialSleepRequests).toHaveLength(3);
    const sleepThroughThreePartialWakeups = (
      requests: number[],
    ): ((milliseconds: number) => Promise<void>) => async (milliseconds) => {
      requests.push(milliseconds);
      const phase = (requests.length - 1) % 3;
      now += phase === 2 ? milliseconds : Math.floor(milliseconds / 2);
    };
    const partialSleeps: number[] = [];
    const fullWindowApi = noCandidate((timeoutMilliseconds) => {
      if (timeoutMilliseconds !== undefined) now += 1;
    });
    await expect(run(
      fullWindowApi,
      () => now,
      sleepThroughThreePartialWakeups(partialSleeps),
    )).rejects.toThrow("timed out waiting for the exact Vercel Production deployment");
    expect(partialSleeps).toEqual(
      Array.from({ length: 20 }, () => expectedPartialSleepRequests).flat(),
    );
    expect(now).toBe(1_200_000);
    expect(fullWindowApi.graphqlCalls).toHaveLength(20);
    expect(fullWindowApi.timeoutMilliseconds).toHaveLength(40);
    expect(fullWindowApi.timeoutMilliseconds.slice(-2)).toEqual([60_000, 59_999]);

    now = 0;
    const tailSleeps: number[] = [];
    const latencyApi = noCandidate((timeoutMilliseconds) => {
      if (timeoutMilliseconds !== undefined) now += 11_000;
    });
    await expect(run(
      latencyApi,
      () => now,
      async (milliseconds) => {
        tailSleeps.push(milliseconds);
        now += milliseconds;
      },
    )).rejects.toThrow("timed out waiting for the exact Vercel Production deployment");
    expect(tailSleeps).toEqual(Array.from({ length: 20 }, () => 27_000));
    expect(latencyApi.graphqlCalls).toHaveLength(20);
    expect(now).toBe(1_200_000);

    now = 0;
    let boundaryRead = 0;
    let boundarySamples = 0;
    const successGithubReads = 36;
    const successPublicReads = 11;
    const successExternalReads = successGithubReads + successPublicReads;
    const exactBoundaryApi = successCase((timeoutMilliseconds) => {
      if (timeoutMilliseconds === undefined) return;
      boundaryRead += 1;
      now = boundaryRead === successExternalReads
        ? 1_200_000
        : Math.floor(1_199_999 * boundaryRead / (successExternalReads - 1));
    });
    await expect(run(exactBoundaryApi, () => {
      if (now !== 1_200_000) return now;
      boundarySamples += 1;
      return boundarySamples === 1 ? now : now + 0.001;
    }, async () => {}))
      .resolves.toEqual({ deploymentId: 20, statusId: 201 });
    expect(now).toBe(1_200_000);
    expect(boundaryRead).toBe(successExternalReads);
    expect(boundarySamples).toBe(1);
    expect(exactBoundaryApi.timeoutMilliseconds).toHaveLength(successGithubReads);
    expect(exactBoundaryApi.timeoutMilliseconds.at(-1)).toBe(1);

    now = 0;
    const lateSleeps: number[] = [];
    const lateCandidateApi = new ProviderApiFixture({
      deployments: [
        ...Array.from({ length: 19 }, () => [baselineDeployment]),
        [candidate, baselineDeployment],
      ],
      readHook: (timeoutMilliseconds) => {
        if (timeoutMilliseconds !== undefined) now += 1;
      },
      refSha: providerVerifiedSha,
      statuses: new Map([
        [10, [[providerStatus(100, "success", "2026-08-29T13:01:00Z")]]],
        [20, [[success], [success], [success]]],
      ]),
    });
    await expect(run(
      lateCandidateApi,
      () => now,
      sleepThroughThreePartialWakeups(lateSleeps),
    )).resolves.toEqual({ deploymentId: 20, statusId: 201 });
    expect(lateSleeps).toEqual(
      Array.from({ length: 19 }, () => expectedPartialSleepRequests).flat(),
    );
    expect(now).toBe(1_140_047);
    expect(lateCandidateApi.graphqlCalls).toHaveLength(22);

    now = 0;
    const frozenSuccessApi = successCase();
    await expect(run(frozenSuccessApi, () => now, async () => {}))
      .rejects.toThrow("did not advance the provider monotonic clock");
    expect(frozenSuccessApi.timeoutMilliseconds).toHaveLength(1);

    now = 0;
    const afterBoundaryApi = successCase((timeoutMilliseconds) => {
      if (timeoutMilliseconds !== undefined) now = 1_200_001;
    });
    await expect(run(afterBoundaryApi, () => now, async () => {}))
      .rejects.toThrow("timed out waiting for the exact Vercel Production deployment");
    expect(afterBoundaryApi.timeoutMilliseconds).toHaveLength(1);

    let subMillisecondRead = 0;
    const subMillisecondApi = noCandidate();
    await expect(run(
      subMillisecondApi,
      () => subMillisecondRead++ === 0 ? 0 : 1_199_999.5,
      async () => {},
    )).rejects.toThrow("timed out waiting for the exact Vercel Production deployment");
    expect(subMillisecondApi.timeoutMilliseconds).toHaveLength(0);
    expect(subMillisecondApi.graphqlCalls).toHaveLength(0);

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1] as const) {
      await expect(run(noCandidate(), () => invalid, async () => {}))
        .rejects.toThrow("finite nonnegative monotonic timestamp");
    }
    await expect(run(noCandidate(), () => Number.MAX_SAFE_INTEGER, async () => {}))
      .rejects.toThrow("deadline overflows");

    let read = 0;
    await expect(run(
      noCandidate(),
      () => read++ === 0 ? 100 : 99,
      async () => {},
    )).rejects.toThrow("monotonic clock regressed");

    now = 0;
    const stuckSleeps: number[] = [];
    const stuckApi = noCandidate((timeoutMilliseconds) => {
      if (timeoutMilliseconds !== undefined) now += 1;
    });
    await expect(run(
      stuckApi,
      () => now,
      async (milliseconds) => {
        stuckSleeps.push(milliseconds);
        if (stuckSleeps.length === 1) now += 1;
      },
    )).rejects.toThrow("poll sleep did not reach its monotonic schedule");
    expect(stuckSleeps).toHaveLength(16);
    expect(stuckApi.graphqlCalls).toHaveLength(1);

    now = 0;
    const reducedSleeps: number[] = [];
    const reducedApi = noCandidate((timeoutMilliseconds) => {
      if (timeoutMilliseconds !== undefined) now += 1;
    });
    await expect(run(
      reducedApi,
      () => now,
      async (milliseconds) => {
        reducedSleeps.push(milliseconds);
      },
      1,
    ))
      .rejects.toThrow("poll budget exhausted before its monotonic deadline");
    expect(reducedSleeps).toHaveLength(0);
    expect(reducedApi.graphqlCalls).toHaveLength(1);

    now = 0;
    const immediateSleeps: number[] = [];
    const immediateApi = noCandidate((timeoutMilliseconds) => {
      if (timeoutMilliseconds !== undefined) now += 1;
    });
    await expect(run(
      immediateApi,
      () => now,
      async (milliseconds) => {
        immediateSleeps.push(milliseconds);
      },
      20,
      0,
    )).rejects.toThrow("test cadence exhausted before its monotonic deadline");
    expect(immediateSleeps).toHaveLength(0);
    expect(immediateApi.graphqlCalls).toHaveLength(20);
    expect(immediateApi.timeoutMilliseconds).toHaveLength(40);
    expect(now).toBe(60);
  });

  test("fails recovery closed on stale success, latest ties, or newer deployments", async () => {
    const recovery = await providerReceipts("already-exact");
    const baselineDeployment = recovery.baselineDeployment;

    const baselineStatusDriftGraph = providerGraphqlDeployment(
      10,
      "2026-08-29T14:05:00Z",
      {
        latestStatus: {
          createdAt: "2026-08-29T14:06:00Z",
          creator: { __typename: "Bot", databaseId: 35613825, login: "vercel" },
          environment: "Production",
          environmentUrl: "https://wrench-10-hraness.vercel.app",
          id: "status-99",
          logUrl: "https://wrench-10-hraness.vercel.app",
          state: "SUCCESS",
          updatedAt: "2026-08-29T14:06:00Z",
        },
        updatedAt: "2026-08-29T14:06:00Z",
      },
    );
    const baselineStatusDrift = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      graphqlDeployments: [[baselineStatusDriftGraph]],
      refSha: providerVerifiedSha,
      statuses: new Map([[10, [[
        providerStatus(100, "success", "2026-08-29T14:06:00Z"),
        providerStatus(99, "pending", "2026-08-29T14:05:30Z"),
      ]]]]),
    });
    await expect(waitForProviderOutcome({
      api: baselineStatusDrift,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).rejects.toThrow("baseline Production deployment disappeared or changed");

    const recoveryReceiptsFor = async (
      deployments: ProviderJson[],
      statuses: Map<number, ProviderJson[][]>,
    ): Promise<Readonly<{ baseline: ProviderJson; promotion: ProviderJson }>> => {
      const baseline = await createProviderBaseline({
        api: new ProviderApiFixture({
          deployments: [deployments],
          refSha: providerVerifiedSha,
          serverDates: [providerBaselineServerDate, providerBaselineServerDate],
          statuses,
        }),
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
      }) as ProviderJson;
      const promotion = await promoteWebsiteProduction({
        api: new ProviderApiFixture({
          deployments: [deployments],
          refSha: providerVerifiedSha,
          serverDates: [providerPromotionServerDate],
          statuses,
        }),
        baselineReceipt: baseline,
        repository: providerRepository,
        verifiedSha: providerVerifiedSha,
        verifiedTag: providerTag,
      }) as ProviderJson;
      return Object.freeze({ baseline, promotion });
    };

    const staleDeployment = providerDeployment(10, "2026-08-29T13:59:59Z");
    const staleStatuses = terminalBaselineStatus(10, "2026-08-29T14:00:01Z");
    const stale = await recoveryReceiptsFor([staleDeployment], staleStatuses);
    const staleApi = new ProviderApiFixture({
      deployments: [[staleDeployment]],
      refSha: providerVerifiedSha,
      statuses: staleStatuses,
    });
    await expect(waitForProviderOutcome({
      api: staleApi,
      baselineReceipt: stale.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: stale.promotion,
      sleep: async () => {},
    })).rejects.toThrow("does not postdate the immutable Release");

    const tiedOlderId = providerDeployment(10, "2026-08-29T14:05:00Z");
    const tiedNewerId = providerDeployment(11, "2026-08-29T14:05:00Z");
    const tiedStatuses = new Map<number, ProviderJson[][]>([
      [10, [[providerStatus(100, "success", "2026-08-29T14:06:00Z")]]],
      [11, [[providerStatus(101, "success", "2026-08-29T14:06:00Z", {}, 11)]]],
    ]);
    await expect(recoveryReceiptsFor(
      [tiedOlderId, tiedNewerId],
      tiedStatuses,
    )).rejects.toThrow("ambiguous at second precision");

    const olderVerified = providerDeployment(10, "2026-08-29T14:05:00Z");
    const newerWrongSha = providerDeployment(11, "2026-08-29T14:07:00Z", {
      sha: providerPreviousSha,
    });
    const wrongNewestStatuses = new Map<number, ProviderJson[][]>([
      [10, [[providerStatus(100, "success", "2026-08-29T14:06:00Z")]]],
      [11, [[providerStatus(101, "success", "2026-08-29T14:08:00Z", {}, 11)]]],
    ]);
    const wrongNewestReceipts = await recoveryReceiptsFor(
      [olderVerified, newerWrongSha],
      wrongNewestStatuses,
    );
    await expect(waitForProviderOutcome({
      api: new ProviderApiFixture({
        deployments: [[olderVerified, newerWrongSha]],
        refSha: providerVerifiedSha,
        statuses: wrongNewestStatuses,
      }),
      baselineReceipt: wrongNewestReceipts.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: wrongNewestReceipts.promotion,
      sleep: async () => {},
    })).rejects.toThrow("successfully binds another SHA");

    for (const terminalState of ["failure", "error", "inactive"] as const) {
      const newerWrongTerminal = providerDeployment(11, "2026-08-29T14:07:00Z", {
        sha: providerPreviousSha,
      });
      const wrongTerminalStatuses = new Map<number, ProviderJson[][]>([
        [10, [[providerStatus(100, "success", "2026-08-29T14:06:00Z")]]],
        [11, [[providerStatus(101, terminalState, "2026-08-29T14:08:00Z", {}, 11)]]],
      ]);
      const wrongTerminalReceipts = await recoveryReceiptsFor(
        [olderVerified, newerWrongTerminal],
        wrongTerminalStatuses,
      );
      await expect(waitForProviderOutcome({
        api: new ProviderApiFixture({
          deployments: [[olderVerified, newerWrongTerminal]],
          refSha: providerVerifiedSha,
          statuses: wrongTerminalStatuses,
        }),
        baselineReceipt: wrongTerminalReceipts.baseline,
        maxPolls: 1,
        pollIntervalMilliseconds: 0,
        promotionReceipt: wrongTerminalReceipts.promotion,
        sleep: async () => {},
      })).resolves.toEqual({ deploymentId: 10, statusId: 100 });
    }

    const concurrentApi = new ProviderApiFixture({
      deployments: [[
        providerDeployment(11, "2026-08-29T14:07:00Z"),
        baselineDeployment,
      ]],
      refSha: providerVerifiedSha,
      statuses: terminalBaselineStatus(10, "2026-08-29T14:06:00Z"),
    });
    await expect(waitForProviderOutcome({
      api: concurrentApi,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).rejects.toThrow("concurrent Production deployment");

    const malformedApi = new ProviderApiFixture({
      deployments: [[baselineDeployment]],
      refSha: providerVerifiedSha,
      statuses: terminalBaselineStatus(10, "2026-08-29T14:06:00Z"),
    });
    malformedApi.release = { ...providerRelease(), published_at: null };
    await expect(waitForProviderOutcome({
      api: malformedApi,
      baselineReceipt: recovery.baseline,
      maxPolls: 1,
      pollIntervalMilliseconds: 0,
      promotionReceipt: recovery.promotion,
      sleep: async () => {},
    })).rejects.toThrow("published_at");
  });

  test("documents bootstrap, verification, stage-only trust, MFA, and tag ordering", async () => {
    const [
      guide,
      agents,
      websiteAgents,
      websiteReadme,
      readme,
      changelog,
      skillInstallGuide,
      manifestText,
    ] = await Promise.all([
        readFile(publishingGuideUrl, "utf8"),
        readFile(agentGuideUrl, "utf8"),
        readFile(websiteAgentGuideUrl, "utf8"),
        readFile(websiteReadmeUrl, "utf8"),
        readFile(readmeUrl, "utf8"),
        readFile(changelogUrl, "utf8"),
        readFile(skillInstallGuideUrl, "utf8"),
        readFile(manifestUrl, "utf8"),
      ]);
    const manifest = JSON.parse(manifestText) as { readonly version: string };
    const exactPackage = `@hraness/wrench@${manifest.version}`;
    const nextReleaseVersion = "0.16.5";
    const tagFailFastBoundary = 'set -eu\ncase "${STAGE_RUN_ID:-}" in';
    const stageRunIdGuard = 'case "${STAGE_RUN_ID:-}" in';
    const stageSourceBinding = 'C="$(gh api \\';
    const stageSourceObjectProof = 'test "$(git rev-parse --verify "$C^{commit}")" = "$C"';
    const stagedManifestRead = 'git show "${C}:package.json"';
    const stagedPackageCoordinateProof =
      `test "$package_coordinate" = "@hraness/wrench@${nextReleaseVersion}"`;
    const sourceArtifactDownload = 'gh run download "$STAGE_RUN_ID" \\';
    const registryArtifactDownload = `npm pack @hraness/wrench@${nextReleaseVersion} \\`;
    const registryIdentityCheck = "bun run ./scripts/npm-package-identity.ts \\";
    const registrySmokeCheck = "bun run ./scripts/package-smoke.ts \\";
    const exactTagCommand = `git tag v${nextReleaseVersion} "$C"`;
    const oneTimeBootstrap =
      "This section records the one-time bootstrap of `@hraness/wrench@0.15.1`.";
    const doNotReuseBootstrap =
      "Do not reuse these bootstrap commands for any\nlater version.";
    const laterVersionRoute =
      "Follow [Stage a later version](#stage-a-later-version) instead.";

    for (const required of [
      exactPackage,
      oneTimeBootstrap,
      doNotReuseBootstrap,
      laterVersionRoute,
      "npm publish \"$wrench_npm_archive\"",
      "npm trust github @hraness/wrench",
      "--environment npm-stage",
      "--allow-stage-publish",
      "npm access set mfa=publish @hraness/wrench",
      "The `npm-stage` environment has no",
      "required deployment reviewers",
      "**Stage exact package** to start automatically",
      "human inspection and two-factor approval",
      "starts **Stage npm package** automatically",
      "manifest edit with an unchanged version succeeds without running the verify or",
      "OIDC jobs.",
      "Manual recovery",
      "runs the same verification and main-only environment path",
      "scripts/npm-package-identity.ts",
      "--source-archive \"$wrench_npm_archive\"",
      "--registry-archive \"$wrench_registry_archive\"",
      tagFailFastBoundary,
      stageRunIdGuard,
      stageSourceBinding,
      ".workflow_id == 344213783",
      '.name == "Stage npm package"',
      '.path == ".github/workflows/npm-stage.yml"',
      '.event == "workflow_dispatch"',
      '.head_branch == "main"',
      '.status == "completed"',
      '.conclusion == "success"',
      ".run_attempt == 1",
      'test "${#C}" -eq 40',
      '*[!0-9a-f]*) exit 1 ;;',
      'test "$(git cat-file -t "$C")" = commit',
      stageSourceObjectProof,
      stagedManifestRead,
      'JSON.parse(require("node:fs").readFileSync(0, "utf8"))',
      'manifest?.name !== "@hraness/wrench"',
      `manifest?.version !== "${nextReleaseVersion}"`,
      stagedPackageCoordinateProof,
      sourceArtifactDownload,
      'wrench_source_name="npm-package-0.16.5-$C-$STAGE_RUN_ID-1"',
      '--name "$wrench_source_name"',
      registryArtifactDownload,
      registryIdentityCheck,
      registrySmokeCheck,
      `--expected-version ${nextReleaseVersion}`,
      exactTagCommand,
      "npm stage approve <stage-id>",
      "The exact npm keyword list is checked by `scripts/package-smoke.ts`",
      "Repository topics are maintainer-managed discovery",
      "`beeper`",
      "`messaging`",
      "Do not grant a release workflow repository",
      "Production Branch as `website-production`",
      "Vercel System Environment Variables enabled",
      "`prj_TZbDZ38ABPan158IqnczgsuTu6Ue` under team\n`team_UAd1iD2XogJlbFg4h14mRaPM`",
      "linked to GitHub repository ID `1316443113`",
      "`link.productionBranch=website-production`",
      "`autoExposeSystemEnvs=true`, and `autoAssignCustomDomains=true`",
      "persistent project invariant, not a per-release switch",
      "READY/STAGED deployment and GitHub success without\nmoving `wrench.rip` or `www.wrench.rip`",
      "Make one\nsetting-only update, then read the project back immediately",
      "only allowed\nchange is `autoAssignCustomDomains: false` to `true`",
      "An ambiguous setting update is readback-only, never a blind retry",
      "`vercel promote <exact-id-or-url>`",
      "do not rewrite the ref, rerun the workflow, or assign an individual\nalias",
      "workflows never mutate this project setting, call the Vercel API, or perform an\nalias or promote operation",
      "`VERCEL_GIT_COMMIT_REF=website-production`",
      "`main` and pull requests are preview sources only",
      "For the one-time\nmigration only",
      "never bootstrap it from `main`",
      "exception must never be repeated",
      "Live ruleset `21832074` targets exactly `refs/heads/website-production` and\n`refs/heads/website-production-canary`",
      "`current_user_can_bypass=never`",
      "exact creation, deletion, and\nnon-fast-forward rules",
      "Live ruleset `21887484` targets the same refs with one\nupdate restriction and exactly one `Integration` bypass for dedicated App",
      "`4783991` with `bypass_mode=always`",
      "Incident freeze ruleset `22182820` added no-bypass creation,\nupdate, deletion, and non-fast-forward restrictions during the v0.16.4 release",
      "Production-only freeze ruleset `22149969` remained\nno-bypass during that retained proof",
      "Replacement incident freeze `22182820` protected the v0.16.4 release and was\nthen removed by captured numeric ID",
      "The App-only writer passed the positive and negative canary\nproofs retained below",
      "historical, not a live control",
      "The retained canary proof is evidence, never standing\nmutation authority",
      "Before every required fast-forward, fresh administrator readback must\nreconfirm",
      "exact permanent rulesets and target refs",
      "sole App\n`4783991` `Integration` bypass",
      "App registration still\ngrants exactly",
      "`metadata:read`, `contents:write`, and `workflows:write`",
      "with no\nother permission",
      "installation `158077029` still selects exactly\nrepository `hraness/wrench` at ID `1316443113`",
      "`production-ref-writer-key` environment still has `deployment=false`",
      "main-only branch policy",
      "sole reviewer `0thernet`",
      "`prevent_self_review=false`",
      "administrator bypass disabled",
      "exactly the four variables",
      "`WRENCH_RELEASE_APP_ID`",
      "`WRENCH_RELEASE_APP_CLIENT_ID`",
      "`WRENCH_RELEASE_APP_SLUG`",
      "`WRENCH_RELEASE_APP_INSTALLATION_ID`",
      "exactly the `WRENCH_RELEASE_APP_PRIVATE_KEY` secret",
      "Any drift leaves\nproduction unchanged",
      "GitHub Actions App Integration 15368 is not the\nproduction writer",
      "Live Protect-main ruleset `20921911` has no\nbypass actors",
      "assigns source ownership and notification",
      "does not claim live or\nindependent review enforcement",
      "retains the pull-request path and exact Required integration\ncheck",
      "`require_code_owner_review` must remain `false`",
      "until a second eligible independent code owner exists",
      "Repository Actions\ndefault to read",
      "leaves only the Release\n`publish` job with a `contents: write` `GITHUB_TOKEN`",
      "does not read or update `website-production`, wait for Vercel, or\nreceive the dedicated App key",
      "The Release lookup accepts only an exact REST 200",
      "Only an authenticated exact 404 permits one REST create request",
      "does not use opaque `gh release view` or\n`gh release create` commands",
      "tag-push Release workflow intentionally executes source `S=C`",
      "a stale-source manual recovery run staged and then published\n`@hraness/wrench@0.16.3` from stale source",
      "Never create a `v0.16.3` Git tag or GitHub Release",
      "The completed\nreplacement is `0.16.4`; the first marker-bearing successor is `0.16.5`",
      "If release controls change materially after staging, that stage is ineligible\nfor tagging",
      "An accepted and eligible stage must be inspected and approved without\na duplicate dispatch",
      "An accepted but ineligible pending stage must be inspected,\nrejected with human two-factor authentication, and confirmed absent before one\nfresh same-version stage is dispatched from final current `main`",
      "If the\nineligible stage is already public, do not reject, unpublish, overwrite, tag, or\nrelease it; move the complete corrected release to a greater version",
      "npm stage reject <stage-id>",
      "git diff --quiet --no-ext-diff --no-textconv C M -- .github/workflows\nscripts/release-ref-authority.ts scripts/release-provider-outcome.mjs\nscripts/release-app-token.mjs scripts/release-ref-writer.mjs",
      "descendant movement is release-authority-safe only while",
      "release-control change in the irreducible prewrite-to-POST window",
      "terminal readback fail closed even though GitHub may already have created the\nimmutable Release",
      "The POST has no conditional-write lease",
      "never deletes, patches, or rolls back a Release\nin response",
      "signed-in\nadministrator must read back both immutable Releases as `enabled=true` and one\nexact active repository tag ruleset",
      "sole ref target is `refs/tags/v*`",
      "bypass-actor set is empty",
      "exact rule types are `deletion` and\n`update`",
      "Creation remains intentionally allowed",
      "Ruleset `19989752`, currently named `Immutable version tags`",
      "numeric ID and name are not authority: the semantic readback\nis",
      "/repos/hraness/wrench/rulesets/$wrench_tag_ruleset_id",
      "value.target !== \"tag\"",
      "value.enforcement !== \"active\"",
      "value.bypass_actors.length !== 0",
      "refName.include[0] !== \"refs/tags/v*\"",
      "JSON.stringify(ruleTypes) !== '[\"deletion\",\"update\"]'",
      "X-GitHub-Api-Version: 2026-03-10",
      "/repos/hraness/wrench/immutable-releases",
      "{enabled: .enabled, enforced_by_owner: .enforced_by_owner}",
      "Object.keys(value).sort().join(\",\") !== \"enabled,enforced_by_owner\"",
      "typeof value.enforced_by_owner !== \"boolean\"",
      "residual\nadministrator-toggle window",
      "treats `target_commitish` as\nnon-authoritative",
      "stable Release ID and publication time across\nthe authority sandwich and every promotion/outcome receipt readback",
      "Release workflow ID `323493609`",
      "entire `workflow_run` payload as\nforeign data",
      "reviewed workflow source `W` originates from `main`",
      "automatic head SHA must instead equal the peeled immutable tag commit",
      "prove `C<=W<=M` for protected current main `M`",
      "Manual recovery carries no upstream SHA",
      "Before any key-gated job starts",
      "already-exact branch takes a separate read-only job",
      "no environment admission, App variable, private key, token mint, or Git\npush",
      "`production-ref-writer-key`, configured with\n`deployment: false`",
      "require reviewer `0thernet`, disable\nadmin bypass, set `prevent_self_review=false`",
      "App\nregistration and every minted token close to exactly `metadata:read`,\n`contents:write`, and `workflows:write`",
      "with no Administration or other\npermission",
      "Workflows write is required because an admitted fast-forward may\nintroduce reviewed `.github/workflows` changes",
      "That runtime token\nproof does not prove the installation-wide selected-repository set",
      "privileged setup must exhaustively read every repository\nselected for the installation",
      "single-use permission and writer proof completed on 2026-09-02",
      "`fb876445334bb74abcb3592a5aaae2672c7b2d96` in workflow `345799741`, run\n`33691443614`, attempt 1",
      "Rule Suite `3922909251`",
      "Rule Suite `3922938237`",
      "`C=0bf88a064233635e0c5485c61f9c533974a7dca4`",
      "`33309c470336127228b959e2aaa54138247b9684`",
      "must never be reset, deleted, or repurposed",
      "`PRE_CLEANUP_MANIFEST.tsv` SHA-256 is\n`cf899eac777336a06dd3d19c41512ae60d1e19f848fdf709c5284ddf73564815`",
      "selected installation `158077029`",
      "packet `SHA256SUMS` SHA-256\n`62449019d3a2c6c5bed4c1f5d25d9a5383f95e865da7335a579e1cbe28f2b148`",
      "complete `EXECUTION_JOURNAL.jsonl` SHA-256\n`4facee05aa0493bb3f724a47729079fd107f4f2d029a4547d5fcbd0df2fa9560`",
      "`KEY_PROOF_RECEIPT_V3.json` SHA-256\n`a3d75a3adf39286cab828ea0dd3ac0e3c8242e9a18c73f51f06f20bde0e0e468`",
      "terminal journal-record digest is\n`9d6c91d29fb8932a6abba9b2f9d4822a153011d0642dd61150a4b9a8bf8da75b`",
      "These four anchors identify the one-shot key-setup proof",
      "base64-decoded `WRENCH_RELEASE_APP_CANARY_EVIDENCE_V2` value emitted by\nworkflow run `33691443614`",
      "ends at its closing `}` byte with no trailing line\nfeed",
      "`b3b285d8d8965851595ff991ba4a4ffa327b605350c161fca36dc09a32b5bb27`",
      "Archived file `terminal.canary-evidence.json` contains those same JSON bytes",
      "plus exactly one trailing line feed",
      "`5b5161fbaea60b29bac64881680e7954631c157b2cb5a0a8e84d1dc1b9f415ec`",
      "raw prove-job log response bytes for job `100450916193`",
      "`eb79ede7214e1b3085d7f787cd91df8b23f9150f805c13d5e5675df934b70510`",
      "Archived whole-run log file `terminal.run.log` is a separate, larger byte",
      "`eb930fec28427928a328a89f61874920ebc18694484b0ffd70051d660ca703e8`",
      "These four hashes label four distinct retained or fetched byte representations\nand are not interchangeable",
      "`93f5eaa8169aa38b358f7eb3e80b30f80f0cb3fd4eb3d37fe6ac60673b02f9fd`",
      "`ca646017da1c8e57ef915b6b76e4e808a41a1e0492454ca0b0c3176f7a504b8a`",
      "`{converged:true, observationCount:2, propagationObserved:false,\nstableDenials:2}`",
      "production helper remains hard-bound to `website-production`",
      "This checked cleanup removed the single-use workflow and helper",
      "`--force-with-lease=refs/heads/website-production:<expected-old>`",
      "first fetches only the verified tag through the fixed HTTPS",
      "peels that fetched object locally",
      "does not check out or execute\ntagged code",
      "exactly one nonredirecting\n`DELETE /installation/token` request",
      "half-open request-start window `[start, deadline)`",
      "HTTP 401 on two distinct scheduled reads",
      "Request,\nbody, and sleep latency are charged to the same window",
      "missed absolute slot\nis skipped instead of triggering a burst",
      "every observation that can\nstart before the deadline remains authorized",
      "`wrench-provider-promotion-v2` receipt must retain that exact bounded object",
      "`releaseAppRevocation`",
      "no-write `already-exact` path must instead bind the\nfield to `null`",
      "Wrench fail-closed policy, not a GitHub revocation-propagation SLA",
      "No action is\nretried",
      "exact production-ref post-read begins only after convergence",
      "every\n`WRENCH_RELEASE_APP_*` value removed",
      "workflow never creates, deletes, force-moves, or\nrecreates the branch",
      "exactly 20 observation slots anchored to that start at offsets zero through\n19 minutes",
      "half-open monotonic `[start, deadline)` window",
      "API latency\nreduces the sleep before the next absolute slot instead of sliding the schedule",
      "default cadence performs only a final bounded\nsleep to the 20-minute deadline",
      "reduced poll count or test cadence rejects immediately",
      "makes no visibility claim for a\ndeployment that changes after the slot-20 query completes",
      "No provider API\nprocess starts with less than one millisecond remaining",
      "every completed\nprocess must strictly advance the injected monotonic clock",
      "final external read\nthat completes exactly at the deadline remains eligible",
      "no redundant clock sample or later API read follows it",
      "separate 30-minute timeout",
      "worst missing-Release path uses 30 calls",
      "five bounded release\npages plus the empty sentinel page",
      "use at most 344 REST calls",
      "leaving 656 calls",
      "promotion helper itself uses at most 21 read-only REST calls",
      "at most fourteen App REST requests",
      "240-point ceiling and 760 points of headroom",
      "Read-only GitHub responses are capped at 8 MiB",
      "App\nidentity, installation, token, and revocation responses are streamed under a\n1 MiB cap",
      "cross-job receipt is capped at 64 KiB",
      "Authenticated GitHub\n`Date` headers bracket that snapshot",
      "complete current inventory of at most 500",
      "removes previous deployment\nstatuses after 90 days while preserving",
      "preserving the current status on the deployment",
      "pinned\ncandidate also gets an exhaustive, order-independent REST status-history read",
      "initial success observation plus two complete consistent\nreadbacks",
      "repeats the complete deployment inventory after the final status\nread",
      "Latest Release or\nworkflow-source drift",
      "exact seven-key `/.well-known/wrench-release.json`",
      "A 404 is allowed\nonly when promoting exact v0.16.5",
      "third identity, changed\nsame-release deployment URL, target-to-baseline regression",
      "`https://wrench.rip/`, `/providers/beeper/`, and `/llms.txt`",
      "one no-follow 308 whose `Location` preserves\nthe marker path and query exactly",
      "project-domain aliases are not release\nauthorities",
      "Vercel static caching is not assumed bypassable",
      "at most 32 unauthenticated GETs",
      "Every request\nhas at most ten seconds",
      "marker and redirect bodies are capped at 1 KiB",
      "Only when creating a missing immutable Release",
      "pins one exact older immutable Latest Release by tag, ID, and publication time",
      "may remain only that exact predecessor\nor advance to the exact created target",
      "at most twelve\nobservations at absolute five-second slots inside one 60-second monotonic\ndeadline",
      "third older\nidentity, regression, same-or-higher different stable tag",
      "exact Release that already existed gets one immediate Latest check and never\nenters this convergence loop",
      "final Latest read is the last external\nobservation",
      "bounded authority sandwich, not an atomic provider snapshot",
      "dispatch **Promote website production** from current `main`",
      "keeps that\ncoordinate distinct from reviewed workflow source `W`",
      "already-exact recovery remains entirely outside the key environment",
      "Never rerun an ambiguous App push",
      "website:vercel-build",
      "WRENCH_VERCEL_BUILD=release-bound-v1",
      "marker and every Vercel signal are absent",
      "missing, malformed, or inconsistent platform",
      "GitHub's bounded public commit API",
      "fixed local `git rev-parse HEAD` child output",
      "checkout keeps\na resolvable Git `HEAD`",
      "exact tarball with canonical npm",
      "Vercel's system commit SHA to equal that verifier-proven local HEAD",
      "`Cache-Control: no-store, max-age=0`",
      "Preview, development, and true local builds never emit it",
    ] as const) {
      expect(guide).toContain(required);
    }
    expect(guide).not.toContain("Those unowned claims are retracted");
    expect(guide).not.toContain("Neither digest is evidence for this canary");
    expect(guide).not.toContain("permits deletion of ID `22182820`");
    expect(guide).not.toContain("require authenticated\nabsence before any fast-forward");
    for (const temporaryFingerprintVariable of [
      "WRENCH_RELEASE_LIFECYCLE_RULESET_ID",
      "WRENCH_RELEASE_LIFECYCLE_RULESET_UPDATED_AT",
      "WRENCH_RELEASE_UPDATE_RULESET_ID",
      "WRENCH_RELEASE_UPDATE_RULESET_UPDATED_AT",
      "WRENCH_RELEASE_PRODUCTION_FREEZE_RULESET_ID",
      "WRENCH_RELEASE_PRODUCTION_FREEZE_RULESET_UPDATED_AT",
    ] as const) {
      expect(guide).toContain(`\`${temporaryFingerprintVariable}\``);
    }
    expect(existsSync(new URL(
      "../.github/workflows/release-app-canary.yml",
      import.meta.url,
    ))).toBe(false);
    expect(existsSync(new URL("./release-app-canary.mjs", import.meta.url))).toBe(false);
    expect(guide).not.toContain("The temporary **Prove release App canary** workflow");
    expect(guide.match(/^## Stage a later version$/gmu)).toHaveLength(1);
    expect(guide).not.toContain("## Publish later versions");
    expect(guide.indexOf(oneTimeBootstrap)).toBeLessThan(guide.indexOf(doNotReuseBootstrap));
    expect(guide.indexOf(doNotReuseBootstrap)).toBeLessThan(guide.indexOf(laterVersionRoute));
    const commands = npmCommands(guide);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).toContain(`--registry=${npmRegistry}`);
    expect(guide.split("\n")).toContain(exactTagCommand);
    expect(guide.split("\n")).not.toContain(`git tag v${nextReleaseVersion}`);
    const stageSectionIndex = guide.indexOf("## Stage a later version");
    const stageIndexOf = (value: string) => guide.indexOf(value, stageSectionIndex);
    expect(stageIndexOf(tagFailFastBoundary)).toBeLessThan(stageIndexOf(stageSourceBinding));
    expect(stageIndexOf(stageRunIdGuard)).toBeLessThan(stageIndexOf(stageSourceBinding));
    expect(stageIndexOf(stageSourceBinding)).toBeLessThan(stageIndexOf(stageSourceObjectProof));
    expect(stageIndexOf(stageSourceObjectProof)).toBeLessThan(stageIndexOf(stagedManifestRead));
    expect(stageIndexOf(stagedManifestRead))
      .toBeLessThan(stageIndexOf(stagedPackageCoordinateProof));
    expect(stageIndexOf(stagedPackageCoordinateProof))
      .toBeLessThan(stageIndexOf(sourceArtifactDownload));
    expect(stageIndexOf(sourceArtifactDownload))
      .toBeLessThan(stageIndexOf(registryArtifactDownload));
    expect(stageIndexOf(registryArtifactDownload))
      .toBeLessThan(stageIndexOf(registryIdentityCheck));
    expect(stageIndexOf(registryIdentityCheck)).toBeLessThan(stageIndexOf(registrySmokeCheck));
    expect(stageIndexOf(registrySmokeCheck)).toBeLessThan(stageIndexOf(exactTagCommand));
    expect(guide.indexOf("npm publish \"$wrench_npm_archive\""))
      .toBeLessThan(guide.indexOf("npm trust github @hraness/wrench"));
    expect(guide.indexOf("npm trust github @hraness/wrench"))
      .toBeLessThan(guide.indexOf(exactTagCommand));

    expect(agents).toContain("Follow `docs/publishing.md`");
    expect(agents).toContain("automatically enter the exact staging pipeline");
    expect(agents).toContain("main-only `npm-stage` environment");
    expect(agents).toContain("no required GitHub deployment reviewers");
    expect(agents).toContain("CI must stage automatically after verification");
    expect(agents).toContain("two-factor approval of the npm stage remain mandatory");
    expect(agents).toContain("Verify that exact public artifact before creating its tag");
    expect(agents).toContain("Before every stable tag push, a signed-in administrator must freshly prove both immutable Releases enabled");
    expect(agents).toContain("one exact active repository tag ruleset targeting only `refs/tags/v*`");
    expect(agents).toContain("Current ruleset `19989752` / `Immutable version tags` is retained evidence");
    expect(agents).toContain("semantics, not its ID or name, are authority");
    expect(agents).toContain("Release workflow must not receive Administration permission or call ruleset endpoints");
    expect(guide).toContain("main-only `npm-stage` environment");
    expect(guide).toContain("no required deployment reviewers");
    expect(agents).toContain("sole `contents: write` job creates or verifies the immutable Latest GitHub Release");
    expect(agents).toContain("Release workflow must never read, create, or update `website-production`");
    expect(agents).toContain("production-promotion workflow from reviewed main source `W`");
    expect(agents).toContain("prove release `C<=W<=M` for protected current main `M`");
    expect(agents).toContain("peeled immutable release SHA");
    expect(agents).toContain("allowing only linear descendant movement after dispatch");
    expect(agents).toContain("untrusted stable-tag input and no upstream SHA");
    expect(agents).toContain("Wrench repository ID `1316443113` and Release workflow ID `323493609`");
    expect(agents).toContain("complete bounded Vercel Production baseline before any key-environment wait");
    expect(agents).toContain("already-exact ref must take a separate read-only path");
    expect(agents).toContain("enter `production-ref-writer-key` with `deployment: false`");
    expect(agents).toContain("explicit `--force-with-lease=refs/heads/website-production:<expected-old>`");
    expect(agents).toContain("Fetch only the exact verified tag through the private askpass token");
    expect(agents).toContain("without executing tagged code");
    expect(agents).toContain("App registration and every minted token must close to exactly `metadata:read`, `contents:write`, and `workflows:write`");
    expect(agents).toContain("with no Administration or other permission");
    expect(agents).toContain("Workflows write is required because an admitted fast-forward may introduce reviewed `.github/workflows` changes");
    expect(agents).toContain("privileged setup must separately enumerate the installation-wide selected-repository set");
    expect(agents).toContain("`prevent_self_review=false`");
    expect(agents).toContain("writer's retained admission proof is workflow run `33691443614`");
    expect(agents).toContain("ordinary `P` to `C` update was denied");
    expect(agents).toContain("dedicated App performed the only leased fast-forward");
    expect(agents).toContain("stale lease was rejected");
    expect(agents).toContain("retained proof is evidence, not standing mutation authority");
    expect(agents).toContain("Before every required fast-forward, fresh administrator readback must reconfirm");
    expect(agents).toContain("permanent rulesets and target refs");
    expect(agents).toContain("sole App `4783991` `Integration` bypass");
    expect(agents).toContain("exact App permission set");
    expect(agents).toContain("installation `158077029` selects only Wrench repository ID `1316443113`");
    expect(agents).toContain("exactly four App identity variables and the one private-key secret");
    expect(agents).toContain("Any drift leaves production unchanged");
    expect(agents).toContain("Retain persistent canary `refs/heads/website-production-canary` at exact `C=0bf88a064233635e0c5485c61f9c533974a7dca4`");
    expect(agents).toContain("never reset, delete, or repurpose it");
    expect(agents).toContain("Keep the production lifecycle and App-only update rules mirrored on that ref");
    expect(agents).toContain("keep the single-use canary source removed");
    expect(agents).toContain("Keep the production helper hard-bound to `website-production`");
    expect(agents).toContain("exactly one empty-204 revocation request");
    expect(agents).toContain("two stable authorization denials");
    expect(agents).toContain("ten-slot, 30-second monotonic operational window before the exact ref post-read");
    expect(agents).toContain("not a GitHub propagation SLA");
    expect(agents).toContain("cap the App path at fourteen REST requests");
    expect(agents).toContain("canonical GitHub `Date` headers strictly before the minted `expires_at`");
    expect(agents).toContain("`propagationObserved=false` means the first two probes were the stable 401 pair");
    expect(agents).toContain("`propagationObserved=true` means at least one exact 200 preceded the final two stable 401s");
    expect(agents).toContain("`releaseAppRevocation` in every advanced `wrench-provider-promotion-v2` receipt");
    expect(agents).toContain("bind `null` on the separate no-write `already-exact` path");
    expect(agents).not.toContain("provisional source and initial App registration");
    expect(agents).not.toContain("contents-only writer");
    expect(agents).toContain("Require bounded read-only jobs");
    expect(agents).toContain("complete current state and `latestStatus` of at most 500");
    expect(agents).toContain("exhaustively audit only the pinned candidate's REST status history");
    expect(agents).toContain("Reject any retained failure, error, or inactive candidate status");
    expect(agents).toContain("REST deployment's lowercase commit `.ref` and `.sha`");
    expect(agents).toContain("20 observation slots at absolute minute offsets zero through 19");
    expect(agents).toContain("without sliding later slots");
    expect(agents).toContain("previous deployment statuses that GitHub deletes after 90 days");
    expect(agents).toContain("GitHub preserves the current status on the deployment");
    expect(agents).not.toContain("audit every retained Production deployment status");
    expect(agents).not.toContain("every baseline deployment's REST status history");
    expect(agents).toContain("a missing production branch is a hard failure");
    expect(agents).toContain("Vercel's Production Branch on `website-production`");
    expect(agents).toContain("persistent `autoAssignCustomDomains=true`");
    expect(agents).toContain("False may stage without moving the canonical domains and is never a release-time toggle");
    expect(agents).toContain("exact project `prj_TZbDZ38ABPan158IqnczgsuTu6Ue`, team `team_UAd1iD2XogJlbFg4h14mRaPM`");
    expect(agents).toContain("False may stage without moving the canonical domains");
    expect(agents).toContain("Ambiguity is readback-only");
    expect(agents).toContain("recovery never blindly reruns, rewrites the ref, or individually aliases a candidate");
    expect(agents).toContain("documented one-time Vercel bootstrap");
    expect(agents).toContain("Live ruleset `21832074` supplies no-bypass creation, deletion, and non-fast-forward protection");
    expect(agents).toContain("Live ruleset `21887484` supplies the sole update restriction and exact App `4783991` `Integration` bypass with `bypass_mode=always`");
    expect(agents).toContain("Incident freeze ruleset `22182820` was removed by captured numeric ID during the audited v0.16.4 production promotion");
    expect(agents).toContain("exact seven-key `/.well-known/wrench-release.json`");
    expect(agents).toContain("only exact v0.16.5 may begin from 404");
    expect(agents).toContain("two stable apex marker/health snapshots plus one exact no-follow `www` 308");
    expect(agents).toContain("Checked-in `CODEOWNERS` supplies ownership and notification only");
    expect(agents).toContain("Protect-main has no bypass actors and retains pull-request admission plus the exact Required CI check");
    expect(agents).toContain("`require_code_owner_review=false` until a second eligible independent code owner exists");
    expect(agents).toContain("`main` and pull requests are preview sources");
    expect(websiteAgents).toContain("tag Release workflow may only create or verify the immutable Latest Release");
    expect(websiteAgents).toContain("A separate workflow loaded from reviewed main source `W` owns production promotion");
    expect(websiteAgents).toContain("Keep reviewed workflow source `W` distinct from peeled immutable release commit `C`");
    expect(websiteAgents).toContain("prove `C<=W<=M` for protected current main `M`");
    expect(websiteAgents).toContain("dedicated one-repository release App only for a required fast-forward");
    expect(websiteAgents).toContain("explicit expected-old `--force-with-lease`");
    expect(websiteAgents).toContain("fetch only the verified tag");
    expect(websiteAgents).toContain("without executing tagged code");
    expect(websiteAgents).toContain("A missing branch is a hard failure");
    expect(websiteAgents).toContain("neither workflow may create, delete, force-move, or accept divergence");
    expect(websiteAgents).toContain("A separate 30-minute read-only job");
    expect(websiteAgents).toContain("absolute observation slots at minute offsets zero through 19");
    expect(websiteAgents).toContain("`[start, deadline)` provider window");
    expect(websiteAgents).toContain("charge API latency without sliding those slots");
    expect(websiteAgents).toContain("App and each minted token must have exactly `metadata:read`, `contents:write`, and `workflows:write`");
    expect(websiteAgents).toContain("Keep the App and minted token permission set exact at `metadata:read`, `contents:write`, and `workflows:write`");
    expect(websiteAgents).toContain("Workflows write is required because an admitted fast-forward may introduce reviewed `.github/workflows` changes");
    expect(websiteAgents).toContain("privileged setup separately proves that the installation-wide selected-repository set contains only Wrench");
    expect(websiteAgents).toContain("`prevent_self_review=false`");
    expect(websiteAgents).toContain("retained admission proof is workflow run `33691443614`");
    expect(websiteAgents).toContain("dedicated App performed the only leased `P` to `C` fast-forward");
    expect(websiteAgents).toContain("Keep that ref at exact `C=0bf88a064233635e0c5485c61f9c533974a7dca4`");
    expect(websiteAgents).toContain("never reset, delete, or repurpose it");
    expect(websiteAgents).toContain("keep the single-use canary source removed");
    expect(websiteAgents).toContain("keep the production helper hard-bound to `website-production`");
    expect(websiteAgents).toContain("retained proof is evidence, not standing mutation authority");
    expect(websiteAgents).toContain("Before every required fast-forward, fresh administrator readback must reconfirm");
    expect(websiteAgents).toContain("permanent rulesets and target refs");
    expect(websiteAgents).toContain("sole App `4783991` `Integration` bypass");
    expect(websiteAgents).toContain("installation `158077029` selects only Wrench repository ID `1316443113`");
    expect(websiteAgents).toContain("exactly four App identity variables and the one private-key secret");
    expect(websiteAgents).toContain("Any drift leaves production unchanged");
    expect(websiteAgents).toContain("Live lifecycle rules cover creation, deletion, and non-fast-forward movement on production and canary");
    expect(websiteAgents).toContain("A separate update rule denies every updater except exact App `4783991`");
    expect(websiteAgents).toContain("`Integration` with `bypass_mode=always`");
    expect(websiteAgents).toContain("Incident freeze ruleset `22182820` was removed by captured numeric ID during the audited v0.16.4 production promotion");
    expect(websiteAgents).toContain("Each verified Production build emits exact bounded `/.well-known/wrench-release.json` bytes");
    expect(websiteAgents).toContain("marker may be absent only at the v0.16.5 baseline");
    expect(websiteAgents).toContain("persistent `autoAssignCustomDomains=true`");
    expect(websiteAgents).toContain("not a per-release switch");
    expect(websiteAgents).toContain("READY/STAGED plus GitHub success without moving the canonical domains");
    expect(websiteAgents).toContain("one setting-only update, immediately read it back");
    expect(websiteAgents).toContain("`vercel promote <exact-id-or-url>`");
    expect(websiteAgents).toContain("never a workflow rerun, ref rewrite, or individual alias assignment");
    expect(websiteAgents).toContain("Checked-in workflows remain token-free");
    expect(websiteAgents).toContain("preview builds must not depend on npm or GitHub release availability and must not emit the production marker");
    expect(websiteAgents).not.toContain("initial provisional permission configuration");
    expect(websiteAgents).not.toContain("provider window orchestration headroom");
    expect(websiteAgents).toContain("bind the GraphQL and REST current-status identities");
    expect(websiteAgents).toContain("exactly one empty-204 token revocation");
    expect(websiteAgents).toContain("ten absolute offsets inside a 30-second half-open request-start window");
    expect(websiteAgents).toContain("Every accepted 200 or 401 also requires a canonical pre-expiry `Date`");
    expect(websiteAgents).toContain("`propagationObserved=false` means those were the first two probes");
    expect(websiteAgents).toContain("while `true` means at least one exact 200 preceded the final two 401s");
    expect(websiteAgents).toContain("Two stable HTTP 401 observations must converge before the exact ref readback");
    expect(websiteAgents).toContain("not a GitHub propagation SLA");
    expect(websiteAgents).toContain("initial success observation plus two stable");
    expect(websiteAgents).not.toContain("audit every retained Production deployment status");
    expect(websiteAgents).not.toContain("every baseline deployment's REST status history");
    expect(websiteAgents).not.toContain("may create or fast-forward");
    expect(websiteReadme).toContain("tag Release workflow publishes only the immutable GitHub Release");
    expect(websiteReadme).toContain("separate\nmain-origin promotion workflow");
    expect(websiteReadme).toContain("one repository-only\nrelease App token and an explicit expected-old Git lease");
    expect(websiteReadme).toContain("fetches only the verified\ntag into its depth-one reviewed-workflow checkout");
    expect(websiteReadme).toContain("without executing tagged code");
    expect(websiteReadme).toContain("reviewed workflow source must descend from that release commit");
    expect(websiteReadme).toContain("live no-bypass ruleset protects\ncreation, deletion, and non-fast-forward movement on the production and canary\nrefs");
    expect(websiteReadme).toContain("second update rule denies every updater except exact App `4783991`");
    expect(websiteReadme).toContain("`Integration` with `bypass_mode=always`");
    expect(websiteReadme).toContain("Incident freeze ruleset `22182820` was\nremoved by captured numeric ID during the audited v0.16.4 production promotion");
    expect(websiteReadme).toContain("exact bounded\nseven-key `/.well-known/wrench-release.json`");
    expect(websiteReadme).toContain("Marker absence is allowed only for the v0.16.5 baseline");
    expect(websiteReadme).toContain("Project `prj_TZbDZ38ABPan158IqnczgsuTu6Ue` under team\n`team_UAd1iD2XogJlbFg4h14mRaPM`");
    expect(websiteReadme).toContain("persistent\n`autoAssignCustomDomains=true`; this is not a per-release switch");
    expect(websiteReadme).toContain("READY/STAGED with GitHub success while the apex and `www`\nstay on the old deployment");
    expect(websiteReadme).toContain("one setting-only\nfalse-to-true update");
    expect(websiteReadme).toContain("Ambiguous updates are readback-only\nwith no blind retry");
    expect(websiteReadme).toContain("`vercel promote <exact-id-or-url>`");
    expect(websiteReadme).toContain("never a workflow rerun, ref rewrite, or individual alias assignment");
    expect(websiteReadme).toContain("Checked-in workflows remain token-free and never mutate Vercel project settings");
    expect(websiteReadme).toContain("retained privileged setup proof\nestablishes that private Hraness App `4783991`, through installation\n`158077029`, is installed only on exact repository `hraness/wrench`");
    expect(websiteReadme).toContain("App\nregistration and each separately repository-narrowed runtime token use exactly\n`metadata:read`, `contents:write`, and `workflows:write`");
    expect(websiteReadme).toContain("reviewer-gated\nwriter environment holds the key");
    expect(websiteReadme).toContain("Stable public\nidentifiers and published SHA-256 digests");
    expect(websiteReadme).toContain("owner-controlled private response evidence");
    expect(websiteReadme).toContain("do not make those private responses independently\npublic");
    expect(websiteReadme).toContain("Retained evidence is not standing mutation authority");
    expect(websiteReadme).toContain("Before every required\nfast-forward, fresh administrator readback must reconfirm");
    expect(websiteReadme).toContain("permanent\nrulesets and target refs");
    expect(websiteReadme).toContain("sole App `4783991` `Integration` bypass");
    expect(websiteReadme).toContain("installation `158077029` still selects\nonly Wrench repository ID `1316443113`");
    expect(websiteReadme).toContain("exactly four App\nidentity variables and the one private-key secret");
    expect(websiteReadme).toContain("Any drift leaves production\nunchanged");
    expect(websiteReadme).not.toContain("Wrench-only App");
    expect(websiteReadme).toContain("Workflows write is required for admitted\ncommits that change checked workflow files");
    expect(websiteReadme).toContain("Retained workflow run `33691443614`\nproves the exact\nworkflow-changing leased `P` to `C` canary");
    expect(websiteReadme).toContain("persistent canary remains at\nexact `C=0bf88a064233635e0c5485c61f9c533974a7dca4`");
    expect(websiteReadme).not.toContain("provisional contents-only App");
    expect(websiteReadme).toContain("A missing branch is a hard\nfailure");
    expect(websiteReadme).toContain("neither workflow recreates it");
    expect(websiteReadme).not.toContain("creates or fast-forwards");
    expect(websiteReadme).not.toContain("only non-force fast-forwards");
    expect(readme).toContain(exactPackage);
    expect(readme).toContain(`npx skills add hraness/wrench#v${manifest.version}`);
    expect(readme).toContain("can become individually reachable while a\nrelease is being staged");
    expect(readme).toContain("completed, supported public release");
    expect(readme).not.toMatch(/npx skills add hraness\/wrench(?:\s|$)/u);
    expect(changelog).toContain("Versioned sections identify checked package source");
    expect(changelog).toContain("publicly\nreleased only after the matching canonical npm package");
    expect(skillInstallGuide).toContain(`exact v${manifest.version} release coordinate`);
    expect(skillInstallGuide).toContain("If the coordinate is not public, stop");
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
