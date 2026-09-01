#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";

const EXPECTED_OWNER = "hraness";
const EXPECTED_REPOSITORY = "hraness/wrench";
export const WRENCH_REPOSITORY_ID = 1_316_443_113;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MIN_TOKEN_LIFETIME_MILLISECONDS = 50 * 60 * 1000;
const MAX_TOKEN_LIFETIME_MILLISECONDS = 61 * 60 * 1000;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
const CLIENT_ID = /^[A-Za-z0-9._-]{6,128}$/u;
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const SECOND_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;

function fail(message) {
  throw new Error(message);
}

function expectRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  return value;
}

function expectArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value;
}

function expectString(value, label) {
  if (typeof value !== "string") fail(`${label} is not a string`);
  return value;
}

function expectExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(keys)) fail(`${label} has an unexpected shape`);
}

function expectRequiredKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
}

function exactEnvironmentString(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} is missing`);
  return value;
}

function exactPositiveInteger(value, label) {
  if (typeof value !== "string" || !POSITIVE_INTEGER.test(value)) {
    fail(`${label} is not a canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} exceeds the safe integer range`);
  return parsed;
}

function exactAppSlug(value, label) {
  if (typeof value !== "string" || !APP_SLUG.test(value)) fail(`${label} is not a GitHub App slug`);
  return value;
}

function exactClientId(value) {
  if (typeof value !== "string" || !CLIENT_ID.test(value)) {
    fail("WRENCH_RELEASE_APP_CLIENT_ID is not a canonical GitHub App client ID");
  }
  return value;
}

function exactToken(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    /[\0\r\n]/u.test(value)
  ) {
    fail("release App token response is missing or malformed");
  }
  return value;
}

function parseHttpDate(value, label) {
  const date = expectString(value, label);
  if (!HTTP_DATE.test(date)) fail(`${label} is not one canonical HTTP Date`);
  const milliseconds = Date.parse(date);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== date) {
    fail(`${label} is not a real canonical HTTP Date`);
  }
  return milliseconds;
}

function parseSecondTimestamp(value, label) {
  const timestamp = expectString(value, label);
  if (!SECOND_TIMESTAMP.test(timestamp)) fail(`${label} is not one exact second UTC timestamp`);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace(".000Z", "Z") !== timestamp) {
    fail(`${label} is not a real canonical timestamp`);
  }
  return milliseconds;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function parseReleaseAppConfiguration(environment) {
  const repository = exactEnvironmentString(environment, "GITHUB_REPOSITORY");
  const repositoryOwner = exactEnvironmentString(environment, "GITHUB_REPOSITORY_OWNER");
  const repositoryId = exactPositiveInteger(
    exactEnvironmentString(environment, "GITHUB_REPOSITORY_ID"),
    "GITHUB_REPOSITORY_ID",
  );
  if (
    repository !== EXPECTED_REPOSITORY ||
    repositoryOwner !== EXPECTED_OWNER ||
    repositoryId !== WRENCH_REPOSITORY_ID
  ) {
    fail(`release App writer must run for exact repository ${EXPECTED_REPOSITORY}`);
  }
  const apiUrl = new URL(exactEnvironmentString(environment, "GITHUB_API_URL"));
  if (apiUrl.href !== "https://api.github.com/" || apiUrl.username !== "" || apiUrl.password !== "") {
    fail("GITHUB_API_URL is not the exact GitHub Cloud API origin");
  }
  const privateKey = exactEnvironmentString(environment, "WRENCH_RELEASE_APP_PRIVATE_KEY");
  if (Buffer.byteLength(privateKey, "utf8") > MAX_PRIVATE_KEY_BYTES || /\0/u.test(privateKey)) {
    fail("WRENCH_RELEASE_APP_PRIVATE_KEY is malformed");
  }
  return Object.freeze({
    apiUrl,
    appId: exactPositiveInteger(
      exactEnvironmentString(environment, "WRENCH_RELEASE_APP_ID"),
      "WRENCH_RELEASE_APP_ID",
    ),
    appSlug: exactAppSlug(
      exactEnvironmentString(environment, "WRENCH_RELEASE_APP_SLUG"),
      "WRENCH_RELEASE_APP_SLUG",
    ),
    clientId: exactClientId(exactEnvironmentString(environment, "WRENCH_RELEASE_APP_CLIENT_ID")),
    installationId: exactPositiveInteger(
      exactEnvironmentString(environment, "WRENCH_RELEASE_APP_INSTALLATION_ID"),
      "WRENCH_RELEASE_APP_INSTALLATION_ID",
    ),
    privateKey,
    repository,
    repositoryId,
  });
}

export function createReleaseAppJwt(input) {
  if (!Number.isSafeInteger(input.nowMilliseconds) || input.nowMilliseconds < 0) {
    fail("release App JWT clock is invalid");
  }
  const clientId = exactClientId(input.clientId);
  const issuedAt = Math.floor(input.nowMilliseconds / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ exp: expiresAt, iat: issuedAt, iss: clientId }));
  const unsigned = `${header}.${payload}`;
  let key;
  try {
    key = createPrivateKey(input.privateKey);
  } catch {
    fail("WRENCH_RELEASE_APP_PRIVATE_KEY is not a valid private key");
  }
  if (key.asymmetricKeyType !== "rsa") fail("WRENCH_RELEASE_APP_PRIVATE_KEY is not an RSA key");
  let signature;
  try {
    signature = sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), key);
  } catch {
    fail("WRENCH_RELEASE_APP_PRIVATE_KEY could not sign the App JWT");
  }
  return `${unsigned}.${signature.toString("base64url")}`;
}

export function releaseAppTokenRequestBody() {
  return Object.freeze({
    permissions: Object.freeze({
      contents: "write",
      metadata: "read",
      workflows: "write",
    }),
    repository_ids: Object.freeze([WRENCH_REPOSITORY_ID]),
  });
}

export function parseReleaseAppIdentity(value, configuration) {
  const app = expectRecord(value, "release App identity");
  const owner = expectRecord(app.owner, "release App owner");
  const permissions = expectRecord(app.permissions, "release App permissions");
  expectExactKeys(
    permissions,
    ["contents", "metadata", "workflows"],
    "release App permissions",
  );
  if (
    app.id !== configuration.appId ||
    app.slug !== configuration.appSlug ||
    app.client_id !== configuration.clientId ||
    owner.login !== EXPECTED_OWNER ||
    owner.type !== "Organization" ||
    permissions.contents !== "write" ||
    permissions.metadata !== "read" ||
    permissions.workflows !== "write"
  ) {
    fail("authenticated release App identity or permission closure does not match checked variables");
  }
}

export function parseReleaseAppInstallation(value, configuration) {
  const installation = expectRecord(value, "release App installation");
  const account = expectRecord(installation.account, "release App installation account");
  const permissions = expectRecord(installation.permissions, "release App installation permissions");
  expectExactKeys(
    permissions,
    ["contents", "metadata", "workflows"],
    "release App installation permissions",
  );
  if (
    installation.id !== configuration.installationId ||
    installation.app_id !== configuration.appId ||
    installation.app_slug !== configuration.appSlug ||
    installation.repository_selection !== "selected" ||
    installation.target_type !== "Organization" ||
    account.login !== EXPECTED_OWNER ||
    account.type !== "Organization" ||
    permissions.contents !== "write" ||
    permissions.metadata !== "read" ||
    permissions.workflows !== "write"
  ) {
    fail("release App installation identity or permission closure does not match checked variables");
  }
}

function tokenFromResponse(value) {
  return exactToken(expectRecord(value, "release App token response").token);
}

export function parseReleaseAppTokenResponse(value, serverDate) {
  const response = expectRecord(value, "release App token response");
  expectRequiredKeys(
    response,
    ["expires_at", "permissions", "repositories", "repository_selection", "token"],
    "release App token response",
  );
  const token = exactToken(response.token);
  const responseMilliseconds = parseHttpDate(serverDate, "release App token response Date");
  const expiresMilliseconds = parseSecondTimestamp(response.expires_at, "release App token expires_at");
  const lifetime = expiresMilliseconds - responseMilliseconds;
  if (lifetime < MIN_TOKEN_LIFETIME_MILLISECONDS || lifetime > MAX_TOKEN_LIFETIME_MILLISECONDS) {
    fail("release App token expiry is outside the one-hour response window");
  }
  const permissions = expectRecord(response.permissions, "release App token permissions");
  expectExactKeys(
    permissions,
    ["contents", "metadata", "workflows"],
    "release App token permissions",
  );
  if (
    permissions.contents !== "write" ||
    permissions.metadata !== "read" ||
    permissions.workflows !== "write"
  ) {
    fail(
      "release App token permissions are not exactly contents:write, metadata:read, and workflows:write",
    );
  }
  if (response.repository_selection !== "selected") {
    fail("release App token response is not selected-repository scoped");
  }
  const repositories = expectArray(response.repositories, "release App token repositories");
  if (repositories.length !== 1) fail("release App token repository set is not exactly one");
  const repository = expectRecord(repositories[0], "release App token repository");
  const owner = expectRecord(repository.owner, "release App token repository owner");
  if (
    repository.id !== WRENCH_REPOSITORY_ID ||
    repository.name !== "wrench" ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    owner.login !== EXPECTED_OWNER
  ) {
    fail(`release App token repository is not exact ${EXPECTED_REPOSITORY}`);
  }
  return Object.freeze({
    expiresAt: response.expires_at,
    permissions: Object.freeze({
      contents: "write",
      metadata: "read",
      workflows: "write",
    }),
    repositoryId: WRENCH_REPOSITORY_ID,
    token,
  });
}

export async function withReleaseAppToken(options, operation) {
  const configuration = parseReleaseAppConfiguration(options.environment);
  const jwt = createReleaseAppJwt({
    clientId: configuration.clientId,
    nowMilliseconds: options.nowMilliseconds(),
    privateKey: configuration.privateKey,
  });
  let token;
  let result;
  let operationError;
  try {
    parseReleaseAppIdentity(await options.inspect({ apiUrl: configuration.apiUrl, jwt }), configuration);
    parseReleaseAppInstallation(await options.inspectInstallation({
      apiUrl: configuration.apiUrl,
      installationId: configuration.installationId,
      jwt,
    }), configuration);
    const response = await options.mint({
      apiUrl: configuration.apiUrl,
      body: releaseAppTokenRequestBody(),
      installationId: configuration.installationId,
      jwt,
    });
    token = tokenFromResponse(response.body);
    options.mask(token);
    const receipt = parseReleaseAppTokenResponse(response.body, response.serverDate);
    result = await operation(token, Object.freeze({
      appId: configuration.appId,
      appSlug: configuration.appSlug,
      clientId: configuration.clientId,
      expiresAt: receipt.expiresAt,
      installationId: configuration.installationId,
      repositoryId: receipt.repositoryId,
    }));
  } catch (error) {
    operationError = error;
  }
  let revokeError;
  if (token !== undefined) {
    try {
      await options.revoke({ apiUrl: configuration.apiUrl, token });
    } catch (error) {
      revokeError = error;
    }
  }
  if (operationError !== undefined && revokeError !== undefined) {
    throw new AggregateError(
      [operationError, revokeError],
      "release App operation and token revocation both failed",
    );
  }
  if (operationError !== undefined) throw operationError;
  if (revokeError !== undefined) throw revokeError;
  return result;
}

async function readBoundedBytes(response, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      fail(`${label} declared an invalid response length`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) fail(`${label} returned malformed bytes`);
    total += result.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The response is already rejected; cancellation is best effort.
      }
      fail(`${label} exceeded its response bound`);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJson(response, label) {
  const bytes = await readBoundedBytes(response, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} did not return bounded UTF-8 JSON`);
  }
}

function appRequestHeaders(credential, userAgent) {
  return Object.freeze({
    Accept: "application/vnd.github+json",
    Authorization: credential,
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

async function inspectWithFetch(input) {
  const response = await fetch(new URL("/app", input.apiUrl), {
    headers: appRequestHeaders(`Bearer ${input.jwt}`, "wrench-release-writer"),
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  if (response.status !== 200) fail(`release App identity read returned HTTP ${String(response.status)}`);
  return readBoundedJson(response, "release App identity response");
}

async function inspectInstallationWithFetch(input) {
  const response = await fetch(new URL(`/app/installations/${String(input.installationId)}`, input.apiUrl), {
    headers: appRequestHeaders(`Bearer ${input.jwt}`, "wrench-release-writer"),
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  if (response.status !== 200) fail(`release App installation read returned HTTP ${String(response.status)}`);
  return readBoundedJson(response, "release App installation response");
}

async function mintWithFetch(input) {
  const response = await fetch(new URL(`/app/installations/${String(input.installationId)}/access_tokens`, input.apiUrl), {
    body: JSON.stringify(input.body),
    headers: {
      ...appRequestHeaders(`Bearer ${input.jwt}`, "wrench-release-writer"),
      "Content-Type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  if (response.status !== 201) fail(`release App token mint returned HTTP ${String(response.status)}`);
  return Object.freeze({
    body: await readBoundedJson(response, "release App token response"),
    serverDate: response.headers.get("date"),
  });
}

async function revokeWithFetch(input) {
  const response = await fetch(new URL("/installation/token", input.apiUrl), {
    headers: appRequestHeaders(`Bearer ${input.token}`, "wrench-release-writer"),
    method: "DELETE",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });
  if (response.status !== 204) fail(`release App token revocation returned HTTP ${String(response.status)}`);
  const bytes = await readBoundedBytes(response, "release App token revocation response");
  if (bytes.byteLength !== 0) fail("release App token revocation returned an unexpected body");
}

export function withReleaseAppTokenFromEnvironment(environment, operation) {
  return withReleaseAppToken({
    environment,
    inspect: inspectWithFetch,
    inspectInstallation: inspectInstallationWithFetch,
    mask(token) {
      process.stdout.write(`::add-mask::${token}\n`);
    },
    mint: mintWithFetch,
    nowMilliseconds: Date.now,
    revoke: revokeWithFetch,
  }, operation);
}
