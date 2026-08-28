import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const PACKAGE_NAME = "@hraness/wrench" as const;
const REPOSITORY = "hraness/wrench" as const;
const REPOSITORY_URL = "https://github.com/hraness/wrench.git" as const;
const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org" as const;
const GITHUB_API_ORIGIN = "https://api.github.com" as const;
const NETWORK_DEADLINE_MS = 20_000;
const MAX_PUBLIC_JSON_BYTES = 1_000_000;
const MAX_GIT_STDOUT_BYTES = 1_024;
const MAX_GIT_STDERR_BYTES = 8_192;
const repositoryRoot = resolve(import.meta.dir, "..");
const stableVersionPattern =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const commitShaPattern = /^[0-9a-f]{40}$/u;
const evidenceKeys = [
  "githubRelease",
  "headSha",
  "latestGithubRelease",
  "npmManifest",
  "remoteTagRefs",
] as const;

export type ProductionReleaseIdentity = Readonly<{
  name: typeof PACKAGE_NAME;
  tag: `v${string}`;
  version: string;
}>;

export type ProductionReleaseEvidence = Readonly<{
  githubRelease: unknown;
  headSha: string;
  latestGithubRelease: unknown;
  npmManifest: unknown;
  remoteTagRefs: string;
}>;

export type ProductionReleaseEvidenceLoader = (
  identity: ProductionReleaseIdentity,
) => Promise<unknown>;

export type BoundedChildProcess = Readonly<{
  exited: Promise<number>;
  kill: () => void;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}>;

function unknownRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`${label} must contain exactly: ${sortedExpected.join(", ")}.`);
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array> {
  if (stream === null) throw new Error(`${label} has no response body.`);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("maximumBytes must be a nonnegative safe integer.");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await reader.cancel();
        throw new Error(`${label} returned a non-byte stream chunk.`);
      }
      if (chunk.value.byteLength > maximumBytes - byteLength) {
        await reader.cancel();
        throw new Error(`${label} exceeded ${String(maximumBytes)} bytes.`);
      }
      chunks.push(chunk.value);
      byteLength += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<unknown> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${label} returned HTTP ${String(response.status)}.`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      await response.body?.cancel();
      throw new Error(`${label} returned an invalid Content-Length.`);
    }
    if (BigInt(contentLength) > BigInt(maximumBytes)) {
      await response.body?.cancel();
      throw new Error(`${label} exceeded ${String(maximumBytes)} bytes.`);
    }
  }
  const body = decodeUtf8(
    await readBoundedStream(response.body, maximumBytes, label),
    label,
  );
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

export async function collectBoundedChildOutput(
  child: BoundedChildProcess,
  label: string,
  stdoutMaximumBytes = MAX_GIT_STDOUT_BYTES,
  stderrMaximumBytes = MAX_GIT_STDERR_BYTES,
): Promise<string> {
  const exited = child.exited;
  const stdout = readBoundedStream(
    child.stdout,
    stdoutMaximumBytes,
    `${label} stdout`,
  );
  const stderr = readBoundedStream(
    child.stderr,
    stderrMaximumBytes,
    `${label} stderr`,
  );
  let result: readonly [number, Uint8Array, Uint8Array];
  try {
    result = await Promise.all([exited, stdout, stderr]);
  } catch (error) {
    try {
      child.kill();
    } catch {
      // The process may already have exited while a bounded stream was failing.
    }
    await Promise.allSettled([exited, stdout, stderr]);
    throw error;
  }
  if (result[0] !== 0) {
    throw new Error(`${label} failed with exit code ${String(result[0])}.`);
  }
  return decodeUtf8(result[1], `${label} stdout`);
}

export function parseProductionReleaseIdentity(
  value: unknown,
): ProductionReleaseIdentity {
  const manifest = unknownRecord(value, "package.json");
  if (manifest.name !== PACKAGE_NAME) {
    throw new TypeError(`package.json must name ${PACKAGE_NAME}.`);
  }
  if (
    typeof manifest.version !== "string"
    || !stableVersionPattern.test(manifest.version)
  ) {
    throw new TypeError("package.json version must be a stable semantic version.");
  }
  return Object.freeze({
    name: PACKAGE_NAME,
    tag: `v${manifest.version}`,
    version: manifest.version,
  });
}

function parseEvidence(value: unknown): ProductionReleaseEvidence {
  const evidence = unknownRecord(value, "production release evidence");
  exactKeys(evidence, evidenceKeys, "production release evidence");
  if (typeof evidence.headSha !== "string" || !commitShaPattern.test(evidence.headSha)) {
    throw new TypeError("Production HEAD evidence must be a lowercase 40-character commit SHA.");
  }
  if (typeof evidence.remoteTagRefs !== "string") {
    throw new TypeError("Remote tag evidence must be text.");
  }
  return {
    githubRelease: evidence.githubRelease,
    headSha: evidence.headSha,
    latestGithubRelease: evidence.latestGithubRelease,
    npmManifest: evidence.npmManifest,
    remoteTagRefs: evidence.remoteTagRefs,
  };
}

function resolveRemoteTagCommit(
  identity: ProductionReleaseIdentity,
  remoteTagRefs: string,
): string {
  const tagRef = `refs/tags/${identity.tag}`;
  const peeledTagRef = `${tagRef}^{}`;
  const refs = new Map<string, string>();
  const lines = remoteTagRefs.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{40})\t([^\t\r\n]+)$/u.exec(line);
    if (match === null) {
      throw new Error("GitHub returned a malformed tag-ref record.");
    }
    const sha = match[1]!;
    const ref = match[2]!;
    if (ref !== tagRef && ref !== peeledTagRef) {
      throw new Error(`GitHub returned an unexpected tag ref: ${ref}.`);
    }
    if (refs.has(ref)) {
      throw new Error(`GitHub returned duplicate evidence for ${ref}.`);
    }
    refs.set(ref, sha);
  }
  const direct = refs.get(tagRef);
  if (direct === undefined) throw new Error(`GitHub does not publish ${tagRef}.`);
  return refs.get(peeledTagRef) ?? direct;
}

function verifyNpmManifest(
  identity: ProductionReleaseIdentity,
  value: unknown,
): void {
  const manifest = unknownRecord(value, "canonical npm version manifest");
  if (manifest.name !== identity.name || manifest.version !== identity.version) {
    throw new Error(
      `Canonical npm does not contain exact ${identity.name}@${identity.version}.`,
    );
  }
  const dist = unknownRecord(manifest.dist, "canonical npm dist metadata");
  if (typeof dist.integrity !== "string" || !dist.integrity.startsWith("sha512-")) {
    throw new Error("Canonical npm does not expose a SHA-512 package integrity.");
  }
  const encodedDigest = dist.integrity.slice("sha512-".length);
  const digest = Buffer.from(encodedDigest, "base64");
  if (digest.byteLength !== 64 || digest.toString("base64") !== encodedDigest) {
    throw new Error("Canonical npm does not expose a SHA-512 package integrity.");
  }
}

type GithubReleaseState = Readonly<{
  id: number;
  tagName: string;
}>;

function githubReleaseState(value: unknown, label: string): GithubReleaseState {
  const release = unknownRecord(value, label);
  if (!Number.isSafeInteger(release.id) || (release.id as number) <= 0) {
    throw new Error(`${label} has no stable positive ID.`);
  }
  if (release.draft !== false) throw new Error(`${label} must not be a draft.`);
  if (release.prerelease !== false) throw new Error(`${label} must not be a prerelease.`);
  if (release.immutable !== true) throw new Error(`${label} must be immutable.`);
  if (typeof release.tag_name !== "string") throw new Error(`${label} has no tag name.`);
  return {
    id: release.id as number,
    tagName: release.tag_name,
  };
}

export function verifyProductionReleaseEvidence(
  packageValue: unknown,
  evidenceValue: unknown,
): ProductionReleaseIdentity {
  const identity = parseProductionReleaseIdentity(packageValue);
  const evidence = parseEvidence(evidenceValue);
  const tagCommit = resolveRemoteTagCommit(identity, evidence.remoteTagRefs);
  if (tagCommit !== evidence.headSha) {
    throw new Error(
      `Checked-out HEAD ${evidence.headSha} is not exact remote ${identity.tag} commit ${tagCommit}.`,
    );
  }
  verifyNpmManifest(identity, evidence.npmManifest);
  const release = githubReleaseState(evidence.githubRelease, `GitHub Release ${identity.tag}`);
  if (release.tagName !== identity.tag) {
    throw new Error(`GitHub Release tag ${release.tagName} is not ${identity.tag}.`);
  }
  const latest = githubReleaseState(
    evidence.latestGithubRelease,
    "Latest GitHub Release",
  );
  if (latest.tagName !== identity.tag || latest.id !== release.id) {
    throw new Error(`GitHub Release ${identity.tag} is not Latest.`);
  }
  return identity;
}

async function fetchPublicJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: url.startsWith(GITHUB_API_ORIGIN)
        ? "application/vnd.github+json"
        : "application/json",
      "User-Agent": "wrench-production-release-verifier",
      ...(url.startsWith(GITHUB_API_ORIGIN)
        ? { "X-GitHub-Api-Version": "2022-11-28" }
        : {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(NETWORK_DEADLINE_MS),
  });
  return readBoundedJsonResponse(response, MAX_PUBLIC_JSON_BYTES, label);
}

async function runGit(
  args: readonly string[],
  label: string,
  cwd: string,
): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      GIT_ASKPASS: "/usr/bin/false",
      GIT_CEILING_DIRECTORIES: "/",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // A concurrent exit is still settled and inspected below.
    }
  }, NETWORK_DEADLINE_MS);
  try {
    try {
      const output = await collectBoundedChildOutput(child, label);
      if (timedOut) throw new Error(`${label} timed out.`);
      return output;
    } catch (error) {
      if (timedOut) throw new Error(`${label} timed out.`, { cause: error });
      throw error;
    }
  } finally {
    clearTimeout(deadline);
  }
}

function parseHeadSha(output: string): string {
  const normalized = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (!commitShaPattern.test(normalized)) {
    throw new Error("git rev-parse returned an invalid production HEAD commit.");
  }
  return normalized;
}

export async function loadProductionReleaseEvidence(
  identity: ProductionReleaseIdentity,
): Promise<ProductionReleaseEvidence> {
  const tagRef = `refs/tags/${identity.tag}`;
  const packagePath = encodeURIComponent(identity.name);
  const tagPath = encodeURIComponent(identity.tag);
  const [headOutput, remoteTagRefs, npmManifest, githubRelease, latestGithubRelease] =
    await Promise.all([
      runGit(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "Production HEAD lookup",
        repositoryRoot,
      ),
      runGit(
        ["ls-remote", REPOSITORY_URL, tagRef, `${tagRef}^{}`],
        "GitHub tag-ref lookup",
        "/",
      ),
      fetchPublicJson(
        `${NPM_REGISTRY_ORIGIN}/${packagePath}/${identity.version}`,
        "Canonical npm registry",
      ),
      fetchPublicJson(
        `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}/releases/tags/${tagPath}`,
        `GitHub Release ${identity.tag}`,
      ),
      fetchPublicJson(
        `${GITHUB_API_ORIGIN}/repos/${REPOSITORY}/releases/latest`,
        "Latest GitHub Release",
      ),
    ]);
  return {
    githubRelease,
    headSha: parseHeadSha(headOutput),
    latestGithubRelease,
    npmManifest,
    remoteTagRefs,
  };
}

export async function verifyProductionRelease(
  packageValue: unknown,
  loadEvidence: ProductionReleaseEvidenceLoader = loadProductionReleaseEvidence,
): Promise<ProductionReleaseIdentity> {
  const identity = parseProductionReleaseIdentity(packageValue);
  return verifyProductionReleaseEvidence(identity, await loadEvidence(identity));
}

export async function verifyCurrentProductionRelease(): Promise<ProductionReleaseIdentity> {
  const packageValue: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
  return verifyProductionRelease(packageValue);
}

if (import.meta.main) {
  const identity = await verifyCurrentProductionRelease();
  process.stdout.write(
    `Verified production Wrench ${identity.tag} against exact HEAD, canonical npm, and immutable Latest GitHub Release.\n`,
  );
}
