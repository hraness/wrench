import { types as nodeTypes } from "node:util";

const strictSemverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const releaseCommitPattern = /^[a-f0-9]{40}$/u;
const tokenPattern = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/u;
const implementationPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._/+:-]{0,254}[A-Za-z0-9])?$/u;

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export type LocalCliToolArtifactIdentityV1 = {
  readonly platform: string;
  readonly arch: string;
  readonly executableSha256: string;
  readonly archiveSha256?: string;
  readonly downloadUrl?: `https://${string}`;
};

/**
 * Exact binding-level identity of one reviewed external CLI release.
 *
 * `version` and `releaseCommit` are drift probes. Execution authority remains
 * bound to the exact per-platform executable digest.
 */
export type LocalCliToolIdentityV1 = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly implementation: string;
  readonly versionScheme: "semver" | "opaque";
  readonly version: string;
  readonly releaseCommit?: string;
  readonly releaseManifestSha256?: string;
  readonly releaseManifestUrl?: `https://${string}`;
  readonly sourceUrl?: `https://${string}`;
  readonly artifacts: readonly LocalCliToolArtifactIdentityV1[];
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error(`${label} has unsupported symbol fields`);
  }
  const result: JsonRecord = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !descriptor.enumerable
      || !("value" in descriptor)
      || !hasWellFormedUnicode(key)
      || /[\u0000-\u001f\u007f-\u009f]/u.test(key)
    ) {
      throw new Error(`${label} has unsupported accessor fields`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function denseArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value)
    || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1
    || value.length > maximum
  ) {
    throw new Error(`${label} is malformed`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")
    || Object.keys(descriptors).length !== value.length + 1
  ) {
    throw new Error(`${label} is malformed`);
  }
  return Object.freeze(Array.from({ length: value.length }, (_unused, index) => {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) {
      throw new Error(`${label} is malformed`);
    }
    return descriptor.value;
  }));
}

function exactKeys(
  value: JsonRecord,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported keys: ${unexpected.join(", ")}`);
  }
  for (const key of allowed) {
    if (
      !Object.hasOwn(value, key)
      && key !== "sourceUrl"
      && key !== "releaseCommit"
      && key !== "releaseManifestSha256"
      && key !== "releaseManifestUrl"
      && key !== "archiveSha256"
      && key !== "downloadUrl"
    ) {
      throw new Error(`${label}.${key} is required`);
    }
  }
}

function exactHttpsUrl(value: unknown, label: string): `https://${string}` {
  if (typeof value !== "string" || value.length > 2_000) {
    throw new Error(`${label} must be a bounded exact HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a bounded exact HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hash !== ""
    || parsed.search !== ""
    || parsed.href !== value
  ) {
    throw new Error(`${label} must be a credential-free exact HTTPS URL without a query or fragment`);
  }
  return value as `https://${string}`;
}

function optionalDigest(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new Error(`${label} must be one lowercase SHA-256 digest`);
  }
  return value;
}

function optionalUrl(
  value: unknown,
  label: string,
): `https://${string}` | undefined {
  return value === undefined ? undefined : exactHttpsUrl(value, label);
}

export function parseLocalCliToolIdentityV1(
  value: unknown,
): LocalCliToolIdentityV1 {
  const tool = record(value, "local CLI tool identity");
  exactKeys(
    tool,
    [
      "schemaVersion",
      "id",
      "implementation",
      "versionScheme",
      "version",
      "releaseCommit",
      "releaseManifestSha256",
      "releaseManifestUrl",
      "sourceUrl",
      "artifacts",
    ],
    "local CLI tool identity",
  );
  if (tool.schemaVersion !== 1) {
    throw new Error("local CLI tool identity schemaVersion must be 1");
  }
  if (typeof tool.id !== "string" || !tokenPattern.test(tool.id)) {
    throw new Error("local CLI tool identity id is malformed");
  }
  if (
    typeof tool.implementation !== "string"
    || !implementationPattern.test(tool.implementation)
  ) {
    throw new Error("local CLI tool identity implementation is malformed");
  }
  if (tool.versionScheme !== "semver" && tool.versionScheme !== "opaque") {
    throw new Error("local CLI tool identity versionScheme must be semver or opaque");
  }
  if (
    typeof tool.version !== "string"
    || tool.version.length < 1
    || tool.version.length > 128
    || /[\u0000-\u001f\u007f-\u009f]/u.test(tool.version)
    || !hasWellFormedUnicode(tool.version)
    || (tool.versionScheme === "semver" && !strictSemverPattern.test(tool.version))
  ) {
    throw new Error("local CLI tool identity version is malformed");
  }
  const hasReleaseCommit = tool.releaseCommit !== undefined;
  if (
    hasReleaseCommit
    && (
      typeof tool.releaseCommit !== "string"
      || !releaseCommitPattern.test(tool.releaseCommit)
    )
  ) {
    throw new Error("local CLI tool identity releaseCommit must be one lowercase 40-character commit ID");
  }
  const releaseManifestSha256 = optionalDigest(
    tool.releaseManifestSha256,
    "local CLI tool identity releaseManifestSha256",
  );
  const sourceUrl = optionalUrl(tool.sourceUrl, "local CLI tool identity sourceUrl");
  const releaseManifestUrl = optionalUrl(
    tool.releaseManifestUrl,
    "local CLI tool identity releaseManifestUrl",
  );
  if ((releaseManifestSha256 === undefined) !== (releaseManifestUrl === undefined)) {
    throw new Error("local CLI tool identity release manifest URL and digest must be declared together");
  }
  const rawArtifacts = denseArray(
    tool.artifacts,
    "local CLI tool identity artifacts",
    16,
  );
  const artifacts = rawArtifacts.map((rawArtifact, index) => {
    const artifact = record(rawArtifact, `local CLI tool artifact ${index}`);
    exactKeys(
      artifact,
      [
        "platform",
        "arch",
        "executableSha256",
        "archiveSha256",
        "downloadUrl",
      ],
      `local CLI tool artifact ${index}`,
    );
    if (typeof artifact.platform !== "string" || !tokenPattern.test(artifact.platform)) {
      throw new Error(`local CLI tool artifact ${index}.platform is malformed`);
    }
    if (typeof artifact.arch !== "string" || !tokenPattern.test(artifact.arch)) {
      throw new Error(`local CLI tool artifact ${index}.arch is malformed`);
    }
    if (
      typeof artifact.executableSha256 !== "string"
      || !sha256Pattern.test(artifact.executableSha256)
    ) {
      throw new Error(`local CLI tool artifact ${index}.executableSha256 must be one lowercase SHA-256 digest`);
    }
    const archiveSha256 = optionalDigest(
      artifact.archiveSha256,
      `local CLI tool artifact ${index}.archiveSha256`,
    );
    const downloadUrl = optionalUrl(
      artifact.downloadUrl,
      `local CLI tool artifact ${index}.downloadUrl`,
    );
    if ((archiveSha256 === undefined) !== (downloadUrl === undefined)) {
      throw new Error(`local CLI tool artifact ${index} archive URL and digest must be declared together`);
    }
    return Object.freeze({
      platform: artifact.platform,
      arch: artifact.arch,
      executableSha256: artifact.executableSha256,
      ...(archiveSha256 === undefined ? {} : { archiveSha256 }),
      ...(downloadUrl === undefined ? {} : { downloadUrl }),
    });
  }).sort((left, right) => {
    const leftCoordinate = `${left.platform}\0${left.arch}`;
    const rightCoordinate = `${right.platform}\0${right.arch}`;
    return leftCoordinate < rightCoordinate
      ? -1
      : leftCoordinate > rightCoordinate ? 1 : 0;
  });
  const coordinates = artifacts.map((artifact) => `${artifact.platform}/${artifact.arch}`);
  if (new Set(coordinates).size !== coordinates.length) {
    throw new Error("local CLI tool identity repeats a platform/architecture artifact");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: tool.id,
    implementation: tool.implementation,
    versionScheme: tool.versionScheme,
    version: tool.version,
    ...(hasReleaseCommit ? { releaseCommit: tool.releaseCommit as string } : {}),
    ...(releaseManifestSha256 === undefined
      ? {}
      : { releaseManifestSha256, releaseManifestUrl: releaseManifestUrl! }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    artifacts: Object.freeze(artifacts),
  });
}

export function localCliToolArtifactForCurrentRuntime(
  tool: LocalCliToolIdentityV1,
): LocalCliToolArtifactIdentityV1 {
  const artifact = tool.artifacts.find((candidate) =>
    candidate.platform === process.platform && candidate.arch === process.arch);
  if (artifact === undefined) {
    throw new Error(
      `local CLI tool ${tool.id}@${tool.version} does not support ${process.platform}/${process.arch}`,
    );
  }
  return artifact;
}
