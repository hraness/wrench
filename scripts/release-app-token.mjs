#!/usr/bin/env node

import { createPrivateKey, sign } from "node:crypto";
import { performance } from "node:perf_hooks";

const EXPECTED_OWNER = "hraness";
const EXPECTED_REPOSITORY = "hraness/wrench";
export const WRENCH_REPOSITORY_ID = 1_316_443_113;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4096;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const REVOCATION_DEADLINE_MILLISECONDS = 30_000;
export const RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS = Object.freeze([
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
const REQUIRED_STABLE_REVOCATION_DENIALS = 2;
const MAX_SLEEP_ATTEMPTS_PER_OBSERVATION = 64;
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

function exactRevocationReceipt(value) {
  const receipt = expectRecord(value, "release App token revocation receipt");
  expectExactKeys(
    receipt,
    ["converged", "observationCount", "propagationObserved", "stableDenials"],
    "release App token revocation receipt",
  );
  if (
    receipt.converged !== true ||
    !Number.isSafeInteger(receipt.observationCount) ||
    receipt.observationCount < REQUIRED_STABLE_REVOCATION_DENIALS ||
    receipt.observationCount > RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS.length ||
    typeof receipt.propagationObserved !== "boolean" ||
    (receipt.propagationObserved === false &&
      receipt.observationCount !== REQUIRED_STABLE_REVOCATION_DENIALS) ||
    (receipt.propagationObserved === true &&
      receipt.observationCount < REQUIRED_STABLE_REVOCATION_DENIALS + 1) ||
    receipt.stableDenials !== REQUIRED_STABLE_REVOCATION_DENIALS
  ) {
    fail("release App token revocation receipt is malformed");
  }
  return Object.freeze({
    converged: true,
    observationCount: receipt.observationCount,
    propagationObserved: receipt.propagationObserved,
    stableDenials: REQUIRED_STABLE_REVOCATION_DENIALS,
  });
}

function parseInstallationRepositories(value) {
  const response = expectRecord(value, "release App token repository response");
  expectRequiredKeys(
    response,
    ["repositories", "repository_selection", "total_count"],
    "release App token repository response",
  );
  const repositories = expectArray(
    response.repositories,
    "release App token repository response repositories",
  );
  if (
    response.total_count !== 1 ||
    response.repository_selection !== "selected" ||
    repositories.length !== 1
  ) {
    fail("release App token repository read is not the exact selected Wrench repository set");
  }
  const repository = expectRecord(repositories[0], "release App token repository read");
  const owner = expectRecord(repository.owner, "release App token repository read owner");
  if (
    repository.id !== WRENCH_REPOSITORY_ID ||
    repository.name !== "wrench" ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    owner.login !== EXPECTED_OWNER
  ) {
    fail(`release App token repository read is not exact ${EXPECTED_REPOSITORY}`);
  }
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
  let tokenExpiresAt;
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
    tokenExpiresAt = expectRecord(response.body, "release App token response").expires_at;
    options.mask(token);
    const receipt = parseReleaseAppTokenResponse(response.body, response.serverDate);
    tokenExpiresAt = receipt.expiresAt;
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
      const revocationReceipt = exactRevocationReceipt(await options.revoke({
        apiUrl: configuration.apiUrl,
        expiresAt: tokenExpiresAt,
        token,
      }));
      if (options.onRevoked !== undefined) {
        await options.onRevoked(revocationReceipt);
      }
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
      try {
        await response.body?.cancel();
      } catch {
        // The response is already rejected; cancellation is best effort.
      }
      fail(`${label} declared an invalid response length`);
    }
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) fail(`${label} returned malformed bytes`);
      chunks.push(result.value);
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The response is already rejected; cancellation is best effort.
        }
        fail(`${label} exceeded its response bound`);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function readBoundedJson(response, label) {
  const bytes = await readBoundedBytes(response, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} did not return bounded UTF-8 JSON`);
  } finally {
    bytes.fill(0);
  }
}

async function readBoundedJsonRecord(response, label) {
  return expectRecord(await readBoundedJson(response, label), label);
}

async function discardBoundedResponse(response, label) {
  const bytes = await readBoundedBytes(response, label);
  bytes.fill(0);
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

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function revocationIndeterminate(reason) {
  return new Error(`release App token revocation convergence is indeterminate: ${reason}`);
}

function exactMonotonicNow(nowImplementation, previous, label) {
  let current;
  try {
    current = nowImplementation();
  } catch {
    throw revocationIndeterminate(`${label} clock read failed`);
  }
  if (!Number.isFinite(current) || current < 0 || current > Number.MAX_SAFE_INTEGER) {
    throw revocationIndeterminate(`${label} clock is invalid`);
  }
  if (previous !== undefined && current < previous) {
    throw revocationIndeterminate(`${label} clock regressed`);
  }
  return current;
}

function exactTimeoutMilliseconds(remaining) {
  const timeout = Math.min(REQUEST_TIMEOUT_MILLISECONDS, Math.floor(remaining));
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw revocationIndeterminate("the post-delete deadline has no request budget remaining");
  }
  return timeout;
}

async function fetchRevocationDeletionResponse(input, request) {
  let response;
  try {
    response = await input.fetchImplementation(request.url, {
      headers: appRequestHeaders(`Bearer ${input.token}`, "wrench-release-writer"),
      method: "DELETE",
      redirect: "error",
      signal: input.createTimeoutSignal(REQUEST_TIMEOUT_MILLISECONDS),
    });
  } catch {
    throw revocationIndeterminate("release App token revocation transport failed");
  }
  return Object.freeze({
    redirected: response.redirected !== false || response.headers.get("location") !== null,
    response,
  });
}

async function fetchRevocationObservationResponse(input, request) {
  const before = exactMonotonicNow(input.now, input.lastNow.value, `${request.label} begin`);
  input.lastNow.value = before;
  if (before >= Math.min(request.deadline, request.nextTarget)) {
    return Object.freeze({ before, skipped: true });
  }
  const timeoutMilliseconds = exactTimeoutMilliseconds(request.deadline - before);
  let response;
  try {
    response = await input.fetchImplementation(request.url, {
      headers: appRequestHeaders(`Bearer ${input.token}`, "wrench-release-writer"),
      method: request.method,
      redirect: "error",
      signal: input.createTimeoutSignal(timeoutMilliseconds),
    });
  } catch {
    throw revocationIndeterminate(`${request.label} transport failed`);
  }
  return Object.freeze({
    before,
    redirected: response.redirected !== false || response.headers.get("location") !== null,
    response,
    skipped: false,
  });
}

function completeRevocationRequest(input, before, label) {
  const after = exactMonotonicNow(input.now, before, `${label} completion`);
  if (after <= before) {
    throw revocationIndeterminate(`${label} clock did not advance`);
  }
  input.lastNow.value = after;
  return after;
}

async function waitForAbsoluteObservation(input, target, nextTarget) {
  for (let attempt = 0; attempt < MAX_SLEEP_ATTEMPTS_PER_OBSERVATION; attempt += 1) {
    const before = exactMonotonicNow(input.now, input.lastNow.value, "revocation observation wait");
    input.lastNow.value = before;
    if (before >= target) return before;
    try {
      await input.sleep(target - before);
    } catch {
      throw revocationIndeterminate("revocation observation sleep failed");
    }
    const after = exactMonotonicNow(input.now, before, "revocation observation wake");
    if (after <= before) {
      throw revocationIndeterminate("revocation observation sleep did not advance the clock");
    }
    input.lastNow.value = after;
    if (after >= nextTarget) return after;
  }
  throw revocationIndeterminate("revocation observation sleep exceeded its attempt bound");
}

function parseServerDateBeforeExpiry(response, expiresMilliseconds, label) {
  const serverMilliseconds = parseHttpDate(response.headers.get("date"), `${label} Date`);
  if (serverMilliseconds >= expiresMilliseconds) {
    throw revocationIndeterminate(`${label} did not precede the minted token expiry`);
  }
  return serverMilliseconds;
}

async function asRevocationIndeterminate(reason, operation) {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("release App token revocation convergence is indeterminate:")
    ) {
      throw error;
    }
    throw revocationIndeterminate(reason);
  }
}

/**
 * Sends exactly one revocation request and then waits for two stable authorization denials from
 * the token's exact selected-repository endpoint. The 30-second request-start window is
 * an operational fail-closed ceiling, not a claim about GitHub's revocation propagation SLA.
 */
export async function revokeReleaseAppTokenWithConvergence(input) {
  const apiUrl = input.apiUrl;
  const token = exactToken(input.token);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const now = input.now ?? (() => performance.now());
  const sleep = input.sleep ?? defaultSleep;
  const createTimeoutSignal = input.createTimeoutSignal ?? ((milliseconds) =>
    AbortSignal.timeout(milliseconds));
  const lastNow = { value: undefined };
  const repositoryUrl = new URL("/installation/repositories", apiUrl);
  const deleteUrl = new URL("/installation/token", apiUrl);
  const shared = Object.freeze({
    createTimeoutSignal,
    fetchImplementation,
    lastNow,
    now,
    sleep,
    token,
  });

  let deletion;
  let deletionError;
  try {
    deletion = await fetchRevocationDeletionResponse(shared, {
      url: deleteUrl,
    });
    if (deletion.redirected) {
      await asRevocationIndeterminate(
        "revocation redirect response is malformed",
        async () => discardBoundedResponse(
          deletion.response,
          "release App token revocation response",
        ),
      );
      throw revocationIndeterminate("release App token revocation redirected");
    }
    if (deletion.response.status !== 204) {
      await asRevocationIndeterminate(
        "revocation error response is malformed",
        async () => discardBoundedResponse(
          deletion.response,
          "release App token revocation response",
        ),
      );
      throw revocationIndeterminate("revocation was not accepted");
    }
    let deletionBytes;
    try {
      deletionBytes = await asRevocationIndeterminate(
        "revocation response is malformed",
        async () => readBoundedBytes(
          deletion.response,
          "release App token revocation response",
        ),
      );
      const declaredLength = deletion.response.headers.get("content-length");
      if (
        (declaredLength !== null && declaredLength !== "0") ||
        deletionBytes.byteLength !== 0
      ) {
        throw revocationIndeterminate("revocation returned an unexpected body");
      }
    } finally {
      deletionBytes?.fill(0);
    }
  } catch (error) {
    deletionError = error;
  }
  if (deletionError !== undefined) throw deletionError;

  const startedAt = exactMonotonicNow(
    now,
    undefined,
    "release App token revocation completion",
  );
  lastNow.value = startedAt;

  let expiresMilliseconds;
  try {
    expiresMilliseconds = parseSecondTimestamp(input.expiresAt, "release App token expires_at");
    parseServerDateBeforeExpiry(
      deletion.response,
      expiresMilliseconds,
      "release App token revocation",
    );
  } catch {
    throw revocationIndeterminate("revocation authority time proof is malformed");
  }

  if (startedAt > Number.MAX_SAFE_INTEGER - REVOCATION_DEADLINE_MILLISECONDS) {
    throw revocationIndeterminate("revocation convergence deadline is outside the precise clock range");
  }
  const deadline = startedAt + REVOCATION_DEADLINE_MILLISECONDS;
  if (!Number.isFinite(deadline) || deadline <= startedAt) {
    throw revocationIndeterminate("revocation convergence deadline is invalid");
  }

  let observationCount = 0;
  let sawAuthorizedResponse = false;
  let stableDenials = 0;
  let convergenceReceipt;
  let convergenceError;
  try {
    for (const [index, offset] of RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS.entries()) {
      const target = startedAt + offset;
      const nextOffset = RELEASE_APP_REVOCATION_OBSERVATION_OFFSETS_MILLISECONDS[index + 1];
      const nextTarget = nextOffset === undefined ? deadline : startedAt + nextOffset;
      let current = exactMonotonicNow(now, lastNow.value, "revocation observation schedule");
      lastNow.value = current;
      if (index > 0 && current > target) continue;
      if (current >= nextTarget) continue;
      current = await waitForAbsoluteObservation(shared, target, nextTarget);
      if (current >= nextTarget || current >= deadline) continue;
      const observation = await fetchRevocationObservationResponse(shared, {
        deadline,
        label: "release App token revocation observation",
        method: "GET",
        nextTarget,
        url: repositoryUrl,
      });
      if (observation.skipped) continue;
      observationCount += 1;
      if (observation.redirected) {
        try {
          await discardBoundedResponse(
            observation.response,
            "release App token revocation observation response",
          );
        } catch {
          throw revocationIndeterminate("redirected revocation observation response is malformed");
        }
        const completedAt = completeRevocationRequest(
          shared,
          observation.before,
          "release App token revocation observation",
        );
        if (completedAt > deadline) {
          throw revocationIndeterminate("a revocation observation completed outside its deadline");
        }
        throw revocationIndeterminate("release App token revocation observation redirected");
      }
      if (observation.response.status === 200) {
        try {
          const body = await readBoundedJsonRecord(
            observation.response,
            "release App token revocation observation response",
          );
          parseInstallationRepositories(body);
          parseServerDateBeforeExpiry(
            observation.response,
            expiresMilliseconds,
            "release App token revocation observation",
          );
        } catch {
          throw revocationIndeterminate("authorized revocation observation is malformed");
        }
        const completedAt = completeRevocationRequest(
          shared,
          observation.before,
          "release App token revocation observation",
        );
        if (completedAt > deadline) {
          throw revocationIndeterminate("a revocation observation completed outside its deadline");
        }
        if (stableDenials > 0) {
          throw revocationIndeterminate("authorization returned after a denial observation");
        }
        sawAuthorizedResponse = true;
        continue;
      }
      if (observation.response.status === 401) {
        let deniedBytes;
        try {
          deniedBytes = await readBoundedBytes(
            observation.response,
            "release App token revocation observation response",
          );
          parseServerDateBeforeExpiry(
            observation.response,
            expiresMilliseconds,
            "release App token revocation observation",
          );
        } catch {
          throw revocationIndeterminate("denied revocation observation is malformed");
        } finally {
          deniedBytes?.fill(0);
        }
        const completedAt = completeRevocationRequest(
          shared,
          observation.before,
          "release App token revocation observation",
        );
        if (completedAt > deadline) {
          throw revocationIndeterminate("a revocation observation completed outside its deadline");
        }
        stableDenials += 1;
        if (stableDenials === REQUIRED_STABLE_REVOCATION_DENIALS) {
          convergenceReceipt = Object.freeze({
            converged: true,
            observationCount,
            propagationObserved: sawAuthorizedResponse,
            stableDenials: REQUIRED_STABLE_REVOCATION_DENIALS,
          });
          break;
        }
        continue;
      }
      try {
        await discardBoundedResponse(
          observation.response,
          "release App token revocation observation response",
        );
      } catch {
        throw revocationIndeterminate("unexpected revocation observation response is malformed");
      }
      completeRevocationRequest(
        shared,
        observation.before,
        "release App token revocation observation",
      );
      throw revocationIndeterminate("observation returned an unexpected authorization state");
    }

    if (convergenceReceipt === undefined) {
      if (stableDenials === 0) {
        fail("release App token revocation did not converge within the bounded operational window");
      }
      throw revocationIndeterminate("only one denial was observed before the operational deadline");
    }
  } catch (error) {
    convergenceError = error;
  }

  if (convergenceError !== undefined) throw convergenceError;
  return convergenceReceipt;
}

async function revokeWithFetch(input) {
  return revokeReleaseAppTokenWithConvergence({
    apiUrl: input.apiUrl,
    expiresAt: input.expiresAt,
    token: input.token,
  });
}

export function withReleaseAppTokenFromEnvironment(environment, operation, onRevoked) {
  return withReleaseAppToken({
    environment,
    inspect: inspectWithFetch,
    inspectInstallation: inspectInstallationWithFetch,
    mask(token) {
      process.stdout.write(`::add-mask::${token}\n`);
    },
    mint: mintWithFetch,
    nowMilliseconds: Date.now,
    onRevoked,
    revoke: revokeWithFetch,
  }, operation);
}
