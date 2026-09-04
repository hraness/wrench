const MARKER_KEYS = Object.freeze([
  "schemaVersion",
  "name",
  "repository",
  "tag",
  "version",
  "sourceSha",
  "deploymentUrl",
]);

export const PRODUCTION_RELEASE_MARKER_SCHEMA = "wrench-production-release-v1";
export const PRODUCTION_RELEASE_MARKER_PATH = "/.well-known/wrench-release.json";
export const PRODUCTION_RELEASE_MARKER_MAX_BYTES = 1_024;
export const PRODUCTION_RELEASE_MARKER_NAME = "@hraness/wrench";
export const PRODUCTION_RELEASE_MARKER_REPOSITORY = "hraness/wrench";

const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const DEPLOYMENT_URL = /^https:\/\/wrench-[a-z0-9]+-hraness\.vercel\.app$/u;

function fail(message) {
  throw new TypeError(message);
}

function exactString(value, label) {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  return value;
}

function exactMarker(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("Production release marker must be an object.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== MARKER_KEYS.length
    || keys.some((key, index) => key !== MARKER_KEYS[index])
  ) {
    fail(`Production release marker keys must be exactly ${MARKER_KEYS.join(", ")} in order.`);
  }
  const schemaVersion = exactString(
    value.schemaVersion,
    "Production release marker schemaVersion",
  );
  const name = exactString(value.name, "Production release marker name");
  const repository = exactString(value.repository, "Production release marker repository");
  const tag = exactString(value.tag, "Production release marker tag");
  const version = exactString(value.version, "Production release marker version");
  const sourceSha = exactString(value.sourceSha, "Production release marker sourceSha");
  const deploymentUrl = exactString(
    value.deploymentUrl,
    "Production release marker deploymentUrl",
  );
  if (schemaVersion !== PRODUCTION_RELEASE_MARKER_SCHEMA) {
    fail("Production release marker schemaVersion is unsupported.");
  }
  if (name !== PRODUCTION_RELEASE_MARKER_NAME) {
    fail("Production release marker name is not @hraness/wrench.");
  }
  if (repository !== PRODUCTION_RELEASE_MARKER_REPOSITORY) {
    fail("Production release marker repository is not hraness/wrench.");
  }
  if (!STABLE_VERSION.test(version) || tag !== `v${version}`) {
    fail("Production release marker tag and version are not one exact stable release.");
  }
  if (!COMMIT_SHA.test(sourceSha)) {
    fail("Production release marker sourceSha is not one lowercase 40-hex commit.");
  }
  if (!DEPLOYMENT_URL.test(deploymentUrl)) {
    fail("Production release marker deploymentUrl is not one exact Wrench deployment URL.");
  }
  return Object.freeze({
    schemaVersion,
    name,
    repository,
    tag,
    version,
    sourceSha,
    deploymentUrl,
  });
}

export function createProductionReleaseMarker({
  deploymentUrl,
  name,
  sourceSha,
  tag,
  version,
}) {
  return exactMarker({
    schemaVersion: PRODUCTION_RELEASE_MARKER_SCHEMA,
    name,
    repository: PRODUCTION_RELEASE_MARKER_REPOSITORY,
    tag,
    version,
    sourceSha,
    deploymentUrl,
  });
}

export function serializeProductionReleaseMarker(value) {
  const marker = exactMarker(value);
  const text = `${JSON.stringify(marker)}\n`;
  if (new TextEncoder().encode(text).byteLength > PRODUCTION_RELEASE_MARKER_MAX_BYTES) {
    fail(`Production release marker exceeds ${String(PRODUCTION_RELEASE_MARKER_MAX_BYTES)} bytes.`);
  }
  return text;
}

export function parseProductionReleaseMarker(text) {
  if (typeof text !== "string") fail("Production release marker body must be a string.");
  if (new TextEncoder().encode(text).byteLength > PRODUCTION_RELEASE_MARKER_MAX_BYTES) {
    fail(`Production release marker exceeds ${String(PRODUCTION_RELEASE_MARKER_MAX_BYTES)} bytes.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("Production release marker body is not valid JSON.");
  }
  const marker = exactMarker(value);
  if (serializeProductionReleaseMarker(marker) !== text) {
    fail("Production release marker body is not canonical JSON plus one newline.");
  }
  return marker;
}
