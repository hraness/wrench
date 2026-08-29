#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const BASELINE_SCHEMA = "wrench-provider-baseline-v2";
const PROMOTION_SCHEMA = "wrench-provider-promotion-v1";
const PRODUCTION_REF = "refs/heads/website-production";
const PAGE_SIZE = 100;
const MAX_ITEMS = 500;
const MAX_PROVIDER_POLLS = 20;
const PROVIDER_POLL_INTERVAL_MILLISECONDS = 60_000;
const PROVIDER_OBSERVATION_DEADLINE_MILLISECONDS = 20 * 60_000;
const PROVIDER_API_CALL_TIMEOUT_MILLISECONDS = 60_000;
const MAX_SLEEP_ATTEMPTS_PER_INTERVAL = 16;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ENCODED_RECEIPT_BYTES = 64 * 1024;
const PAGINATED_READ_REQUESTS = MAX_ITEMS / PAGE_SIZE + 1;
const GITHUB_TOKEN_REST_REQUEST_LIMIT = 1_000;
const VERCEL_CREATOR = Object.freeze({ id: 35613825, login: "vercel[bot]", type: "Bot" });
const VERCEL_GRAPHQL_CREATOR = Object.freeze({ id: 35613825, login: "vercel", type: "Bot" });
const GRAPHQL_PAGE_SIZE = 100;
const MAX_GRAPHQL_DEPLOYMENT_PAGES = 5;
const MAX_GRAPHQL_COST_PER_REQUEST = 2;
const GITHUB_GRAPHQL_POINT_LIMIT = 1_000;
const GRAPHQL_ID = /^[\x21-\x7e]{1,512}$/u;
const VERCEL_PRODUCTION_URL = /^https:\/\/wrench-[a-z0-9]+-hraness\.vercel\.app$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA = /^[0-9a-f]{40}$/u;
const SECOND_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const RECEIPT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/?(?:$|\/))(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]+$/u;
const TERMINAL_STATES = new Set(["error", "failure", "inactive", "success"]);
const STATUS_STATES = new Set([
  "error",
  "failure",
  "inactive",
  "in_progress",
  "pending",
  "queued",
  "success",
]);
const GRAPHQL_DEPLOYMENT_STATES = new Set([
  "ABANDONED",
  "ACTIVE",
  "DESTROYED",
  "ERROR",
  "FAILURE",
  "INACTIVE",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "SUCCESS",
  "WAITING",
]);
const GRAPHQL_STATUS_STATES = new Set([
  "ERROR",
  "FAILURE",
  "INACTIVE",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "SUCCESS",
  "WAITING",
]);
const GRAPHQL_TERMINAL_STATUS_STATES = new Set(["ERROR", "FAILURE", "INACTIVE", "SUCCESS"]);
const PROVIDER_TIMEOUT_MESSAGE = "timed out waiting for the exact Vercel Production deployment";
const COMPATIBLE_GRAPHQL_DEPLOYMENT_STATES = Object.freeze({
  ERROR: new Set(["ERROR"]),
  FAILURE: new Set(["FAILURE"]),
  INACTIVE: new Set(["ABANDONED", "DESTROYED", "INACTIVE"]),
  IN_PROGRESS: new Set(["IN_PROGRESS"]),
  PENDING: new Set(["PENDING"]),
  QUEUED: new Set(["QUEUED"]),
  SUCCESS: new Set(["ACTIVE", "SUCCESS"]),
  WAITING: new Set(["WAITING"]),
});
const PRODUCTION_DEPLOYMENTS_QUERY = `query WrenchProductionDeployments(
  $owner: String!
  $name: String!
  $after: String
) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    deployments(
      first: 100
      after: $after
      environments: ["Production"]
      orderBy: { field: CREATED_AT, direction: DESC }
    ) {
      totalCount
      nodes {
        databaseId
        commitOid
        ref { name }
        createdAt
        updatedAt
        state
        task
        environment
        originalEnvironment
        creator {
          __typename
          login
          ... on Bot { databaseId }
          ... on User { databaseId }
        }
        latestStatus {
          id
          state
          createdAt
          updatedAt
          environment
          environmentUrl
          logUrl
          creator {
            __typename
            login
            ... on Bot { databaseId }
            ... on User { databaseId }
          }
        }
      }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

const BASELINE_REST_REQUESTS = 2;
const PROMOTION_REST_REQUESTS = 14;
const OUTCOME_REST_REQUESTS =
  6 +
  MAX_PROVIDER_POLLS * (2 + PAGINATED_READ_REQUESTS) +
  3 +
  2 +
  PAGINATED_READ_REQUESTS +
  7 +
  PAGINATED_READ_REQUESTS +
  7;
const SURROUNDING_RELEASE_REST_REQUESTS =
  1 +
  1 +
  1 +
  1 +
  PAGINATED_READ_REQUESTS +
  1 +
  3 +
  1;
const BASELINE_GRAPHQL_REQUESTS = 2 * MAX_GRAPHQL_DEPLOYMENT_PAGES;
const OUTCOME_GRAPHQL_REQUESTS =
  (MAX_PROVIDER_POLLS + 2) * MAX_GRAPHQL_DEPLOYMENT_PAGES;

export const releaseRestRequestBudget = Object.freeze({
  githubTokenLimit: GITHUB_TOKEN_REST_REQUEST_LIMIT,
  headroom:
    GITHUB_TOKEN_REST_REQUEST_LIMIT -
    BASELINE_REST_REQUESTS -
    PROMOTION_REST_REQUESTS -
    OUTCOME_REST_REQUESTS -
    SURROUNDING_RELEASE_REST_REQUESTS,
  maxPolls: MAX_PROVIDER_POLLS,
  observationDeadlineMilliseconds: PROVIDER_OBSERVATION_DEADLINE_MILLISECONDS,
  perCallTimeoutMilliseconds: PROVIDER_API_CALL_TIMEOUT_MILLISECONDS,
  pollIntervalMilliseconds: PROVIDER_POLL_INTERVAL_MILLISECONDS,
  providerBaseline: BASELINE_REST_REQUESTS,
  providerOutcome: OUTCOME_REST_REQUESTS,
  providerPromotion: PROMOTION_REST_REQUESTS,
  surroundingRelease: SURROUNDING_RELEASE_REST_REQUESTS,
  total:
    BASELINE_REST_REQUESTS +
    PROMOTION_REST_REQUESTS +
    OUTCOME_REST_REQUESTS +
    SURROUNDING_RELEASE_REST_REQUESTS,
});

export const releaseGraphqlRequestBudget = Object.freeze({
  githubPointLimit: GITHUB_GRAPHQL_POINT_LIMIT,
  headroom:
    GITHUB_GRAPHQL_POINT_LIMIT -
    (BASELINE_GRAPHQL_REQUESTS + OUTCOME_GRAPHQL_REQUESTS) * MAX_GRAPHQL_COST_PER_REQUEST,
  maxCostPerRequest: MAX_GRAPHQL_COST_PER_REQUEST,
  maxPoints:
    (BASELINE_GRAPHQL_REQUESTS + OUTCOME_GRAPHQL_REQUESTS) * MAX_GRAPHQL_COST_PER_REQUEST,
  providerBaseline: BASELINE_GRAPHQL_REQUESTS,
  providerOutcome: OUTCOME_GRAPHQL_REQUESTS,
  totalRequests: BASELINE_GRAPHQL_REQUESTS + OUTCOME_GRAPHQL_REQUESTS,
});

function fail(message) {
  throw new Error(message);
}

function createProviderDeadline(monotonicNow) {
  if (typeof monotonicNow !== "function") fail("monotonicNow is not a function");
  let prior;
  const read = (label) => {
    const value = monotonicNow();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(`${label} is not a finite nonnegative monotonic timestamp`);
    }
    if (prior !== undefined && value < prior) fail("provider monotonic clock regressed");
    prior = value;
    return value;
  };
  const startedAt = read("provider observation start");
  const expiresAt = startedAt + PROVIDER_OBSERVATION_DEADLINE_MILLISECONDS;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt > Number.MAX_SAFE_INTEGER ||
    expiresAt <= startedAt
  ) {
    fail("provider observation deadline overflows the monotonic clock");
  }
  const complete = (label) => {
    const now = read(label);
    const remainingMilliseconds = expiresAt - now;
    if (remainingMilliseconds < 0) fail(PROVIDER_TIMEOUT_MESSAGE);
    return Object.freeze({ now, remainingMilliseconds });
  };
  const begin = (label) => {
    const state = complete(label);
    if (state.remainingMilliseconds < 1) fail(PROVIDER_TIMEOUT_MESSAGE);
    return state;
  };
  return Object.freeze({ begin, complete, expiresAt, read, startedAt });
}

function deadlineBoundReadApi(api, deadline) {
  const invoke = async (method, args, label) => {
    const operation = api?.[method];
    if (typeof operation !== "function") fail(`provider API has no ${method} method`);
    const before = deadline.begin(`begin ${label}`);
    const timeoutMilliseconds = Math.min(
      PROVIDER_API_CALL_TIMEOUT_MILLISECONDS,
      Math.floor(before.remainingMilliseconds),
    );
    const result = await operation.call(api, ...args, Object.freeze({ timeoutMilliseconds }));
    const after = deadline.complete(`complete ${label}`);
    if (after.now <= before.now) {
      fail(`${label} did not advance the provider monotonic clock`);
    }
    return result;
  };
  return Object.freeze({
    get: (endpoint) => invoke("get", [endpoint], `GET ${String(endpoint)}`),
    graphql: (request) => invoke("graphql", [request], "GraphQL Production deployments"),
  });
}

async function waitForProviderScheduleTarget(
  deadline,
  sleep,
  pollIntervalMilliseconds,
  nextObservationIndex,
  { allowDeadlineTarget = false } = {},
) {
  if (pollIntervalMilliseconds === 0) return;
  const start = deadline.complete("schedule provider poll sleep");
  const target = deadline.startedAt + nextObservationIndex * pollIntervalMilliseconds;
  if (
    target > deadline.expiresAt ||
    (target === deadline.expiresAt && !allowDeadlineTarget)
  ) {
    fail("provider poll schedule reached its observation-start deadline");
  }
  let current = start.now;
  for (let attempt = 1; attempt <= MAX_SLEEP_ATTEMPTS_PER_INTERVAL; attempt += 1) {
    const remaining = target - current;
    if (remaining <= 0) return;
    await sleep(remaining);
    const next = deadline.complete("complete provider poll sleep");
    if (next.now >= target) return;
    current = next.now;
  }
  fail("provider poll sleep did not reach its monotonic schedule");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value, label) {
  if (!isRecord(value)) fail(`${label} is not an object`);
  return value;
}

function expectArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value;
}

function expectExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has an unexpected shape`);
  }
}

function expectString(value, label) {
  if (typeof value !== "string") fail(`${label} is not a string`);
  return value;
}

function expectBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} is not a boolean`);
  return value;
}

function expectSafeId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} is not a positive safe integer`);
  return value;
}

function expectNonnegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} is not a nonnegative safe integer`);
  }
  return value;
}

function expectSha(value, label) {
  const sha = expectString(value, label);
  if (!SHA.test(sha)) fail(`${label} is not one lowercase 40-hex commit`);
  return sha;
}

function expectStableTag(value, label) {
  const tag = expectString(value, label);
  if (!STABLE_TAG.test(tag)) fail(`${label} is not one stable semantic-version tag`);
  return tag;
}

function expectRepository(value) {
  const repository = expectString(value, "repository");
  if (!REPOSITORY.test(repository)) fail("repository is not one owner/name coordinate");
  return repository;
}

function parseSecondTimestamp(value, label) {
  const timestamp = expectString(value, label);
  if (!SECOND_TIMESTAMP.test(timestamp)) fail(`${label} is not an exact second UTC timestamp`);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) fail(`${label} is not a real timestamp`);
  if (new Date(milliseconds).toISOString().replace(".000Z", "Z") !== timestamp) {
    fail(`${label} is not a canonical timestamp`);
  }
  return Object.freeze({ milliseconds, timestamp });
}

function parseReceiptTimestamp(value, label) {
  const timestamp = expectString(value, label);
  if (!RECEIPT_TIMESTAMP.test(timestamp)) fail(`${label} is not an exact millisecond UTC timestamp`);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    fail(`${label} is not a canonical timestamp`);
  }
  return Object.freeze({ milliseconds, timestamp });
}

function parseHttpDate(value, label) {
  const date = expectString(value, label);
  if (!HTTP_DATE.test(date)) fail(`${label} is not one canonical HTTP Date`);
  const milliseconds = Date.parse(date);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toUTCString() !== date) {
    fail(`${label} is not a real canonical HTTP Date`);
  }
  return Object.freeze({
    milliseconds,
    timestamp: new Date(milliseconds).toISOString(),
  });
}

function parseJson(text, label) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    fail(`${label} exceeds the bounded JSON response size`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

export function parseIncludedGitHubResponse(text, label = "included GitHub response") {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    fail(`${label} exceeds the bounded response size`);
  }
  const normalized = text.replaceAll("\r\n", "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator <= 0) fail(`${label} has no exact header/body boundary`);
  const headers = normalized.slice(0, separator).split("\n");
  const bodyText = normalized.slice(separator + 2);
  if (!/^HTTP\/(?:1\.1|2(?:\.0)?) 200(?: .*)?$/u.test(headers[0] ?? "")) {
    fail(`${label} is not one successful HTTP response`);
  }
  const dates = [];
  for (const header of headers.slice(1)) {
    const colon = header.indexOf(":");
    if (colon <= 0) fail(`${label} has a malformed response header`);
    const name = header.slice(0, colon).trim().toLowerCase();
    const value = header.slice(colon + 1).trim();
    if (name.length === 0 || value.length === 0) fail(`${label} has an empty response header`);
    if (name === "date") dates.push(value);
  }
  if (dates.length !== 1) fail(`${label} does not have exactly one authenticated Date header`);
  const server = parseHttpDate(dates[0], `${label} Date header`);
  return Object.freeze({
    body: parseJson(bodyText, `${label} body`),
    serverDate: server.timestamp,
  });
}

export function parseOptionalIncludedGitHubResponse(
  text,
  label = "optional included GitHub response",
) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    fail(`${label} exceeds the bounded response size`);
  }
  const normalized = text.replaceAll("\r\n", "\n");
  const separator = normalized.indexOf("\n\n");
  if (separator <= 0) fail(`${label} has no exact header/body boundary`);
  const headers = normalized.slice(0, separator).split("\n");
  const statusMatch = /^HTTP\/(?:1\.1|2(?:\.0)?) (200|404)(?: .*)?$/u.exec(headers[0] ?? "");
  if (statusMatch === null) fail(`${label} is not one exact 200 or 404 HTTP response`);
  for (const header of headers.slice(1)) {
    const colon = header.indexOf(":");
    if (colon <= 0) fail(`${label} has a malformed response header`);
    const name = header.slice(0, colon).trim();
    const value = header.slice(colon + 1).trim();
    if (name.length === 0 || value.length === 0) fail(`${label} has an empty response header`);
  }
  const body = parseJson(normalized.slice(separator + 2), `${label} body`);
  if (statusMatch[1] === "404") {
    const missing = expectRecord(body, `${label} 404 body`);
    if (missing.message !== "Not Found") fail(`${label} is not an exact not-found response`);
    return Object.freeze({ found: false, value: null });
  }
  return Object.freeze({ found: true, value: body });
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function receiptDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function encodeProviderReceipt(value) {
  const encoded = Buffer.from(canonicalJson(value), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_RECEIPT_BYTES) {
    fail("provider receipt exceeds the bounded job-output size");
  }
  return encoded;
}

export function decodeProviderReceipt(value, label = "provider receipt") {
  const encoded = expectString(value, label);
  if (
    !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
    Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_RECEIPT_BYTES
  ) {
    fail(`${label} is not bounded canonical base64url`);
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) fail(`${label} is not canonical base64url`);
  const text = bytes.toString("utf8");
  const decoded = parseJson(text, label);
  if (canonicalJson(decoded) !== text) fail(`${label} does not contain canonical JSON`);
  return decoded;
}

function basicDeployment(value, label) {
  const record = expectRecord(value, label);
  const id = expectSafeId(record.id, `${label}.id`);
  const created = parseSecondTimestamp(record.created_at, `${label}.created_at`);
  const sha = expectSha(record.sha, `${label}.sha`);
  const ref = expectSha(record.ref, `${label}.ref`);
  if (ref !== sha) fail(`${label}.ref does not bind its exact SHA`);
  return Object.freeze({
    createdAt: created.timestamp,
    createdMilliseconds: created.milliseconds,
    id,
    raw: record,
    ref,
    sha,
  });
}

function basicStatus(value, label) {
  const record = expectRecord(value, label);
  const id = expectSafeId(record.id, `${label}.id`);
  const state = expectString(record.state, `${label}.state`);
  if (!STATUS_STATES.has(state)) fail(`${label}.state is unsupported`);
  const created = parseSecondTimestamp(record.created_at, `${label}.created_at`);
  const updated = parseSecondTimestamp(record.updated_at, `${label}.updated_at`);
  if (updated.milliseconds < created.milliseconds) fail(`${label}.updated_at predates creation`);
  return Object.freeze({
    createdAt: created.timestamp,
    createdMilliseconds: created.milliseconds,
    id,
    nodeId: expectGraphqlId(record.node_id, `${label}.node_id`),
    raw: record,
    state,
    updatedAt: updated.timestamp,
    updatedMilliseconds: updated.milliseconds,
  });
}

async function collectPaginated(
  api,
  endpointForPage,
  parseItem,
  label,
  { maxItems = MAX_ITEMS, pageRequests = PAGINATED_READ_REQUESTS } = {},
) {
  const items = [];
  const ids = new Set();
  let exhausted = false;

  for (let page = 1; page <= pageRequests; page += 1) {
    const endpoint = endpointForPage(page);
    const rawPage = expectArray(await api.get(endpoint), `${label} page ${page}`);
    if (rawPage.length > PAGE_SIZE) fail(`${label} page ${page} exceeds ${PAGE_SIZE} items`);
    if (page === pageRequests) {
      if (rawPage.length !== 0) fail(`${label} exceeds the ${String(maxItems)}-item audit cap`);
      break;
    }

    if (exhausted && rawPage.length !== 0) {
      fail(`${label} resumed after a truncated page`);
    }

    for (let index = 0; index < rawPage.length; index += 1) {
      const item = parseItem(rawPage[index], `${label} page ${page} item ${index}`);
      if (ids.has(item.id)) fail(`${label} contains duplicate id ${String(item.id)}`);
      ids.add(item.id);
      items.push(item);
    }
    if (rawPage.length < PAGE_SIZE) exhausted = true;
  }

  items.sort((left, right) =>
    right.createdMilliseconds - left.createdMilliseconds || right.id - left.id);
  return Object.freeze(items);
}

function validateDeploymentStatusEndpoint(deployment, repository, label) {
  const expected =
    `https://api.github.com/repos/${repository}/deployments/${String(deployment.id)}/statuses`;
  if (deployment.raw.statuses_url !== expected) {
    fail(`${label}.statuses_url does not bind its exact deployment`);
  }
  return deployment;
}

function expectGraphqlId(value, label) {
  const id = expectString(value, label);
  if (!GRAPHQL_ID.test(id)) fail(`${label} is not one bounded GraphQL node id`);
  return id;
}

function expectGraphqlVercelCreator(value, label) {
  const creator = expectRecord(value, `${label}.creator`);
  expectExactKeys(creator, ["__typename", "databaseId", "login"], `${label}.creator`);
  if (
    creator.__typename !== VERCEL_GRAPHQL_CREATOR.type ||
    creator.databaseId !== VERCEL_GRAPHQL_CREATOR.id ||
    creator.login !== VERCEL_GRAPHQL_CREATOR.login
  ) {
    fail(`${label}.creator is not the pinned Vercel bot`);
  }
  return Object.freeze({
    id: VERCEL_GRAPHQL_CREATOR.id,
    login: VERCEL_GRAPHQL_CREATOR.login,
    type: VERCEL_GRAPHQL_CREATOR.type,
  });
}

function canonicalVercelProductionUrl(value, label) {
  const url = expectString(value, label);
  if (!VERCEL_PRODUCTION_URL.test(url)) {
    fail(`${label} is not the canonical Wrench Vercel Production URL`);
  }
  return url;
}

function graphqlStatusSnapshotValue(status) {
  return Object.freeze({
    createdAt: status.createdAt,
    creator: status.creator,
    environment: status.environment,
    environmentUrl: status.environmentUrl,
    id: status.id,
    logUrl: status.logUrl,
    state: status.state,
    updatedAt: status.updatedAt,
  });
}

function graphqlDeploymentStatus(value, label, deploymentCreated, deploymentUpdated) {
  const status = expectRecord(value, label);
  expectExactKeys(status, [
    "createdAt",
    "creator",
    "environment",
    "environmentUrl",
    "id",
    "logUrl",
    "state",
    "updatedAt",
  ], label);
  const state = expectString(status.state, `${label}.state`);
  if (!GRAPHQL_STATUS_STATES.has(state)) fail(`${label}.state is unsupported`);
  const created = parseSecondTimestamp(status.createdAt, `${label}.createdAt`);
  const updated = parseSecondTimestamp(status.updatedAt, `${label}.updatedAt`);
  if (
    created.milliseconds < deploymentCreated ||
    updated.milliseconds < created.milliseconds ||
    deploymentUpdated < updated.milliseconds
  ) {
    fail(`${label} has an impossible timestamp interval`);
  }
  if (status.environment !== "Production") fail(`${label}.environment is not Production`);
  const environmentUrl = canonicalVercelProductionUrl(
    status.environmentUrl,
    `${label}.environmentUrl`,
  );
  const logUrl = canonicalVercelProductionUrl(status.logUrl, `${label}.logUrl`);
  if (environmentUrl !== logUrl) fail(`${label} URLs do not bind one Vercel deployment`);
  return Object.freeze({
    createdAt: created.timestamp,
    createdMilliseconds: created.milliseconds,
    creator: expectGraphqlVercelCreator(status.creator, label),
    environment: "Production",
    environmentUrl,
    id: expectGraphqlId(status.id, `${label}.id`),
    logUrl,
    state,
    updatedAt: updated.timestamp,
  });
}

function graphqlProductionDeployment(value, label) {
  const record = expectRecord(value, label);
  expectExactKeys(record, [
    "commitOid",
    "createdAt",
    "creator",
    "databaseId",
    "environment",
    "latestStatus",
    "originalEnvironment",
    "ref",
    "state",
    "task",
    "updatedAt",
  ], label);
  const id = expectSafeId(record.databaseId, `${label}.databaseId`);
  const created = parseSecondTimestamp(record.createdAt, `${label}.createdAt`);
  const updated = parseSecondTimestamp(record.updatedAt, `${label}.updatedAt`);
  if (updated.milliseconds < created.milliseconds) fail(`${label}.updatedAt predates creation`);
  const state = expectString(record.state, `${label}.state`);
  if (!GRAPHQL_DEPLOYMENT_STATES.has(state)) fail(`${label}.state is unsupported`);
  if (
    record.environment !== "Production" ||
    record.originalEnvironment !== "Production" ||
    record.ref !== null ||
    record.task !== "deploy"
  ) {
    fail(`${label} is not one Production deploy deployment`);
  }
  const creator = expectGraphqlVercelCreator(record.creator, label);

  let latestStatus;
  if (record.latestStatus !== null) {
    latestStatus = graphqlDeploymentStatus(
      record.latestStatus,
      `${label}.latestStatus`,
      created.milliseconds,
      updated.milliseconds,
    );
    const compatibleStates = COMPATIBLE_GRAPHQL_DEPLOYMENT_STATES[latestStatus.state];
    if (compatibleStates === undefined || !compatibleStates.has(state)) {
      fail(`${label}.state is incompatible with its latest status`);
    }
  } else if (!["IN_PROGRESS", "PENDING", "QUEUED", "WAITING"].includes(state)) {
    fail(`${label} has no latest status for its deployment state`);
  }

  return Object.freeze({
    createdAt: created.timestamp,
    createdMilliseconds: created.milliseconds,
    creator,
    environment: "Production",
    id,
    latestStatus,
    originalEnvironment: "Production",
    ref: null,
    sha: expectSha(record.commitOid, `${label}.commitOid`),
    state,
    task: "deploy",
    updatedAt: updated.timestamp,
  });
}

function parseGraphqlDeploymentPage(value, label, priorRateLimit, page) {
  const response = expectRecord(value, label);
  expectExactKeys(response, ["data"], label);
  const data = expectRecord(response.data, `${label}.data`);
  expectExactKeys(data, ["rateLimit", "repository"], `${label}.data`);
  const rateLimit = expectRecord(data.rateLimit, `${label}.data.rateLimit`);
  expectExactKeys(rateLimit, ["cost", "remaining", "resetAt"], `${label}.data.rateLimit`);
  const cost = expectSafeId(rateLimit.cost, `${label}.data.rateLimit.cost`);
  if (cost > MAX_GRAPHQL_COST_PER_REQUEST) {
    fail(`${label} costs more than ${String(MAX_GRAPHQL_COST_PER_REQUEST)} GraphQL points`);
  }
  const remaining = expectNonnegativeSafeInteger(
    rateLimit.remaining,
    `${label}.data.rateLimit.remaining`,
  );
  const reset = parseSecondTimestamp(rateLimit.resetAt, `${label}.data.rateLimit.resetAt`);
  if (priorRateLimit !== undefined) {
    if (reset.timestamp !== priorRateLimit.resetAt) {
      fail(`${label} crossed a GraphQL rate-limit reset during one bounded inventory`);
    }
    if (remaining > priorRateLimit.remaining - cost) {
      fail(`${label} GraphQL remaining points did not decrease monotonically`);
    }
  }

  const repository = expectRecord(data.repository, `${label}.data.repository`);
  expectExactKeys(repository, ["deployments"], `${label}.data.repository`);
  const connection = expectRecord(repository.deployments, `${label}.deployments`);
  expectExactKeys(connection, ["nodes", "pageInfo", "totalCount"], `${label}.deployments`);
  const totalCount = expectNonnegativeSafeInteger(
    connection.totalCount,
    `${label}.deployments.totalCount`,
  );
  if (totalCount > MAX_ITEMS) {
    fail(`Production deployments exceed the ${String(MAX_ITEMS)}-item GraphQL audit cap`);
  }
  const nodes = expectArray(connection.nodes, `${label}.deployments.nodes`);
  if (nodes.length > GRAPHQL_PAGE_SIZE) {
    fail(`${label} exceeds ${String(GRAPHQL_PAGE_SIZE)} nodes`);
  }
  const pageInfo = expectRecord(connection.pageInfo, `${label}.deployments.pageInfo`);
  expectExactKeys(pageInfo, ["endCursor", "hasNextPage"], `${label}.deployments.pageInfo`);
  const hasNextPage = expectBoolean(
    pageInfo.hasNextPage,
    `${label}.deployments.pageInfo.hasNextPage`,
  );
  let endCursor;
  if (pageInfo.endCursor !== null) {
    endCursor = expectGraphqlId(
      pageInfo.endCursor,
      `${label}.deployments.pageInfo.endCursor`,
    );
  }
  if (hasNextPage && (nodes.length === 0 || endCursor === undefined)) {
    fail(`${label} has an unusable continuation cursor`);
  }
  if (nodes.length > 0 && endCursor === undefined) {
    fail(`${label} has no cursor for its nonempty page`);
  }
  if (hasNextPage && page === MAX_GRAPHQL_DEPLOYMENT_PAGES) {
    fail(`Production deployments exceed the ${String(MAX_ITEMS)}-item GraphQL audit cap`);
  }
  const remainingPages = hasNextPage ? MAX_GRAPHQL_DEPLOYMENT_PAGES - page : 0;
  if (remaining < remainingPages * MAX_GRAPHQL_COST_PER_REQUEST) {
    fail(`${label} has insufficient GraphQL points to finish the bounded inventory`);
  }
  return Object.freeze({
    endCursor,
    hasNextPage,
    nodes,
    rateLimit: Object.freeze({ remaining, resetAt: reset.timestamp }),
    totalCount,
  });
}

export async function collectProductionDeployments(api, repository) {
  const coordinate = expectRepository(repository);
  const [owner, name] = coordinate.split("/");
  const deployments = [];
  const ids = new Set();
  const latestStatusIds = new Set();
  const cursors = new Set();
  let after;
  let priorRateLimit;
  let totalCount;
  let exhausted = false;
  for (let page = 1; page <= MAX_GRAPHQL_DEPLOYMENT_PAGES; page += 1) {
    const raw = await api.graphql({ after, name, owner, query: PRODUCTION_DEPLOYMENTS_QUERY });
    const parsed = parseGraphqlDeploymentPage(
      raw,
      `Production deployments GraphQL page ${String(page)}`,
      priorRateLimit,
      page,
    );
    priorRateLimit = parsed.rateLimit;
    if (totalCount === undefined) totalCount = parsed.totalCount;
    else if (totalCount !== parsed.totalCount) {
      fail("Production deployments totalCount changed during one bounded inventory");
    }
    for (let index = 0; index < parsed.nodes.length; index += 1) {
      const deployment = graphqlProductionDeployment(
        parsed.nodes[index],
        `Production deployment page ${String(page)} item ${String(index)}`,
      );
      if (ids.has(deployment.id)) {
        fail(`Production deployments contain duplicate id ${String(deployment.id)}`);
      }
      ids.add(deployment.id);
      if (deployment.latestStatus !== undefined) {
        if (latestStatusIds.has(deployment.latestStatus.id)) {
          fail(`Production deployments contain duplicate latest status id ${deployment.latestStatus.id}`);
        }
        latestStatusIds.add(deployment.latestStatus.id);
      }
      deployments.push(deployment);
    }
    if (!parsed.hasNextPage) {
      exhausted = true;
      break;
    }
    if (parsed.endCursor === undefined || cursors.has(parsed.endCursor)) {
      fail("Production deployments GraphQL cursor repeated");
    }
    cursors.add(parsed.endCursor);
    after = parsed.endCursor;
  }
  if (!exhausted || totalCount === undefined || deployments.length !== totalCount) {
    fail("Production deployments GraphQL inventory did not exhaust its declared totalCount");
  }
  deployments.sort((left, right) =>
    right.createdMilliseconds - left.createdMilliseconds || right.id - left.id);
  return Object.freeze(deployments);
}

export async function collectDeploymentStatuses(api, repository, deploymentId) {
  const coordinate = expectRepository(repository);
  const id = expectSafeId(deploymentId, "deployment id");
  return collectPaginated(
    api,
    (page) => `/repos/${coordinate}/deployments/${String(id)}/statuses?per_page=100&page=${String(page)}`,
    basicStatus,
    `deployment ${String(id)} statuses`,
  );
}

async function readDeployment(api, repository, deploymentId) {
  const id = expectSafeId(deploymentId, "deployment id");
  const deployment = basicDeployment(
    await api.get(`/repos/${repository}/deployments/${String(id)}`),
    `deployment ${String(id)}`,
  );
  if (deployment.id !== id) fail(`deployment ${String(id)} changed identity`);
  return validateDeploymentStatusEndpoint(
    deployment,
    repository,
    `deployment ${String(id)}`,
  );
}

function stableVersion(tag, label) {
  const match = STABLE_TAG.exec(expectString(tag, label));
  if (match === null) return undefined;
  return Object.freeze(match.slice(1).map((part) => BigInt(part)));
}

function compareStableVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export async function assertReleaseTagNewerThanPublished({ api, repository, verifiedTag }) {
  const coordinate = expectRepository(repository);
  const tag = expectStableTag(verifiedTag, "verified tag");
  const next = stableVersion(tag, "verified tag");
  const ids = new Set();
  let exhausted = false;

  for (let page = 1; page <= PAGINATED_READ_REQUESTS; page += 1) {
    const rawPage = expectArray(
      await api.get(
        `/repos/${coordinate}/releases?per_page=${String(PAGE_SIZE)}&page=${String(page)}`,
      ),
      `published releases page ${String(page)}`,
    );
    if (rawPage.length > PAGE_SIZE) {
      fail(`published releases page ${String(page)} exceeds ${String(PAGE_SIZE)} items`);
    }
    if (page === PAGINATED_READ_REQUESTS) {
      if (rawPage.length !== 0) fail(`published releases exceed the ${String(MAX_ITEMS)}-item audit cap`);
      break;
    }
    if (exhausted && rawPage.length !== 0) fail("published releases resumed after a truncated page");

    for (let index = 0; index < rawPage.length; index += 1) {
      const release = expectRecord(
        rawPage[index],
        `published releases page ${String(page)} item ${String(index)}`,
      );
      const id = expectSafeId(
        release.id,
        `published releases page ${String(page)} item ${String(index)} id`,
      );
      if (ids.has(id)) fail(`published releases contain duplicate id ${String(id)}`);
      ids.add(id);
      const draft = expectBoolean(
        release.draft,
        `published releases page ${String(page)} item ${String(index)} draft`,
      );
      const prerelease = expectBoolean(
        release.prerelease,
        `published releases page ${String(page)} item ${String(index)} prerelease`,
      );
      const currentTag = expectString(
        release.tag_name,
        `published releases page ${String(page)} item ${String(index)} tag_name`,
      );
      const current = stableVersion(currentTag, "published release tag");
      if (
        !draft &&
        !prerelease &&
        current !== undefined &&
        compareStableVersions(next, current) <= 0
      ) {
        fail(`Release ${tag} is not newer than ${currentTag}`);
      }
    }
    if (rawPage.length < PAGE_SIZE) exhausted = true;
  }
}

function deploymentSnapshotValue(item) {
  return Object.freeze({
    createdAt: item.createdAt,
    creator: item.creator,
    environment: item.environment,
    id: item.id,
    latestStatus: item.latestStatus ?? null,
    originalEnvironment: item.originalEnvironment,
    ref: item.ref,
    sha: item.sha,
    state: item.state,
    task: item.task,
    updatedAt: item.updatedAt,
  });
}

function deploymentFingerprint(items) {
  return receiptDigest(items.map(deploymentSnapshotValue));
}

function assertTerminalDeploymentInventory(items, label) {
  for (const deployment of items) {
    const latest = deployment.latestStatus;
    if (latest === undefined || !GRAPHQL_TERMINAL_STATUS_STATES.has(latest.state)) {
      fail(`${label} deployment ${String(deployment.id)} has no terminal latest status`);
    }
  }
}

function statusFingerprintValue(item) {
  return Object.freeze({
    createdAt: item.createdAt,
    creator: Object.freeze({
      id: item.raw.creator.id,
      login: item.raw.creator.login,
      type: item.raw.creator.type,
    }),
    deploymentUrl: item.raw.deployment_url,
    environment: item.raw.environment,
    environmentUrl: item.raw.environment_url,
    id: item.id,
    logUrl: item.raw.log_url,
    nodeId: item.nodeId,
    state: item.state,
    targetUrl: item.raw.target_url,
    updatedAt: item.updatedAt,
  });
}

function statusFingerprint(items) {
  return canonicalJson(items.map(statusFingerprintValue));
}

function exactCommitRef(value, expectedRef, label) {
  const record = expectRecord(value, label);
  const object = expectRecord(record.object, `${label} object`);
  if (record.ref !== expectedRef || object.type !== "commit") {
    fail(`${label} did not resolve to one exact commit ref`);
  }
  return expectSha(object.sha, `${label} SHA`);
}

function exactProductionRef(value) {
  return exactCommitRef(value, PRODUCTION_REF, "website-production ref");
}

async function readProductionRef(api, repository) {
  return exactProductionRef(
    await api.get(`/repos/${repository}/git/ref/heads/website-production`),
  );
}

async function readProductionRefWithServerDate(api, repository) {
  const response = expectRecord(
    await api.getWithServerDate(`/repos/${repository}/git/ref/heads/website-production`),
    "website-production included response",
  );
  expectExactKeys(
    response,
    ["body", "serverDate"],
    "website-production included response",
  );
  const server = parseReceiptTimestamp(
    response.serverDate,
    "website-production authenticated server Date",
  );
  return Object.freeze({
    milliseconds: server.milliseconds,
    sha: exactProductionRef(response.body),
    timestamp: server.timestamp,
  });
}

function expectBranch(value, label) {
  const branch = expectString(value, label);
  if (!BRANCH.test(branch)) fail(`${label} is not one exact branch name`);
  return branch;
}

async function revalidateWorkflowSource(
  api,
  repository,
  { defaultBranch, eventName, recoveryWorkflowSha },
) {
  const branch = expectBranch(defaultBranch, "default branch");
  const event = expectString(eventName, "release event name");
  const recovery = expectString(recoveryWorkflowSha, "recovery workflow SHA");
  if (event === "push") {
    if (recovery !== "") fail("tag release unexpectedly carried a recovery workflow source");
    return;
  }
  if (event !== "workflow_dispatch") fail("provider wait received an unsupported release event");
  const sha = expectSha(recovery, "recovery workflow SHA");
  const repositoryState = expectRecord(
    await api.get(`/repos/${repository}`),
    "release workflow repository",
  );
  if (expectBranch(repositoryState.default_branch, "current default branch") !== branch) {
    fail("release recovery default branch changed after workflow verification");
  }
  const expectedRef = `refs/heads/${branch}`;
  const current = exactCommitRef(
    await api.get(`/repos/${repository}/git/ref/heads/${branch}`),
    expectedRef,
    "release workflow source ref",
  );
  if (current !== sha) fail("release recovery workflow source is no longer current main");
  const terminalRepositoryState = expectRecord(
    await api.get(`/repos/${repository}`),
    "terminal release workflow repository",
  );
  if (
    expectBranch(terminalRepositoryState.default_branch, "terminal current default branch") !==
    branch
  ) {
    fail("release recovery default branch moved during source verification");
  }
}

function expectVercelCreator(value, label) {
  const creator = expectRecord(value, `${label}.creator`);
  if (
    creator.id !== VERCEL_CREATOR.id ||
    creator.login !== VERCEL_CREATOR.login ||
    creator.type !== VERCEL_CREATOR.type
  ) {
    fail(`${label}.creator is not the pinned Vercel bot`);
  }
}

function exactCandidate(item, expectedSha, label) {
  const record = item.raw;
  if (
    item.sha !== expectedSha ||
    item.ref !== expectedSha ||
    record.task !== "deploy" ||
    record.environment !== "Production" ||
    record.original_environment !== "Production"
  ) {
    fail(`${label} does not bind the exact Vercel Production deployment identity`);
  }
  expectVercelCreator(record.creator, label);
  return item;
}

function exactCandidateStatus(item, deployment, repository, label) {
  const expectedDeploymentUrl =
    `https://api.github.com/repos/${repository}/deployments/${String(deployment.id)}`;
  const environmentUrl = expectString(item.raw.environment_url, `${label}.environment_url`);
  const targetUrl = expectString(item.raw.target_url, `${label}.target_url`);
  const logUrl = expectString(item.raw.log_url, `${label}.log_url`);
  if (item.createdMilliseconds < deployment.createdMilliseconds) {
    fail(`${label} predates its deployment`);
  }
  if (
    item.raw.environment !== "Production" ||
    item.raw.deployment_url !== expectedDeploymentUrl ||
    targetUrl !== environmentUrl ||
    logUrl !== environmentUrl ||
    !VERCEL_PRODUCTION_URL.test(environmentUrl)
  ) {
    fail(`${label} does not bind the exact Production deployment status identity`);
  }
  expectVercelCreator(item.raw.creator, label);
  return item;
}

function validateCandidateStatuses(items, deployment, repository) {
  const nodeIds = new Set();
  for (const item of items) {
    exactCandidateStatus(
      item,
      deployment,
      repository,
      `deployment ${String(deployment.id)} status ${String(item.id)}`,
    );
    if (nodeIds.has(item.nodeId)) {
      fail(`deployment ${String(deployment.id)} statuses contain duplicate node id ${item.nodeId}`);
    }
    nodeIds.add(item.nodeId);
  }
}

function observeRestCurrentStatus(items, graphCandidate) {
  const first = items[0];
  if (first === undefined) {
    return Object.freeze({ current: undefined, newest: Object.freeze([]) });
  }
  const newest = Object.freeze(
    items.filter((item) => item.createdMilliseconds === first.createdMilliseconds),
  );
  if (newest.length === 1) {
    return Object.freeze({ current: newest[0], newest });
  }
  const graphStatusId = graphCandidate.latestStatus?.id;
  const current = newest.find((item) => item.nodeId === graphStatusId);
  return Object.freeze({ current, newest });
}

function assertNoTerminalRestFailure(statuses, candidateId) {
  const failed = statuses.find(
    (item) => item.state !== "success" && TERMINAL_STATES.has(item.state),
  );
  if (failed !== undefined) {
    fail(`candidate Production deployment ${String(candidateId)} ended in ${failed.state}`);
  }
}

async function readImmutableRelease(api, repository, tag) {
  const value = expectRecord(
    await api.get(`/repos/${repository}/releases/tags/${tag}`),
    `Release ${tag}`,
  );
  if (
    value.tag_name !== tag ||
    value.draft !== false ||
    value.prerelease !== false ||
    value.immutable !== true
  ) {
    fail(`Release ${tag} is not exact, published, and immutable`);
  }
  const published = parseSecondTimestamp(value.published_at, `Release ${tag}.published_at`);
  return Object.freeze({ publishedAt: published.timestamp, publishedMilliseconds: published.milliseconds });
}

async function readLatestRelease(api, repository, tag) {
  const value = expectRecord(
    await api.get(`/repos/${repository}/releases/latest`),
    "Latest Release",
  );
  if (value.tag_name !== tag) fail(`Latest Release is not ${tag}`);
}

async function readVerifiedTagCommit(api, repository, tag, verifiedSha) {
  const encodedTagRef = encodeURIComponent(`refs/tags/${tag}`);
  const value = expectRecord(
    await api.get(`/repos/${repository}/commits/${encodedTagRef}`),
    `tag ${tag}`,
  );
  const tagSha = expectSha(value.sha, `tag ${tag} SHA`);
  if (tagSha !== verifiedSha) fail(`tag ${tag} moved from the verified release commit`);
}

export function exactPublishedRelease(value, tag, label = "published Release") {
  const stableTag = expectStableTag(tag, "published Release tag");
  const release = expectRecord(value, label);
  const assets = expectArray(release.assets, `${label}.assets`);
  if (
    release.tag_name !== stableTag ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.immutable !== true ||
    assets.length !== 0
  ) {
    fail(`Release ${stableTag} is not exact, published, immutable, and asset-free`);
  }
  parseSecondTimestamp(release.published_at, `${label}.published_at`);
  return release;
}

async function readFastForwardComparison(api, repository, currentSha, verifiedSha) {
  const value = expectRecord(
    await api.get(`/repos/${repository}/compare/${currentSha}...${verifiedSha}`),
    "production fast-forward comparison",
  );
  const base = expectRecord(value.base_commit, "comparison.base_commit");
  const mergeBase = expectRecord(value.merge_base_commit, "comparison.merge_base_commit");
  if (
    value.status !== "ahead" ||
    !Number.isSafeInteger(value.ahead_by) ||
    value.ahead_by <= 0 ||
    value.behind_by !== 0 ||
    base.sha !== currentSha ||
    mergeBase.sha !== currentSha
  ) {
    fail(`website-production does not fast-forward from ${currentSha} to ${verifiedSha}`);
  }
}

function parseBaselineReceipt(value) {
  const receipt = expectRecord(value, "baseline receipt");
  expectExactKeys(receipt, [
    "completedAt",
    "deploymentFingerprint",
    "deploymentIds",
    "lowerBound",
    "productionRef",
    "refSha",
    "repository",
    "schema",
    "verifiedSha",
  ], "baseline receipt");
  if (receipt.schema !== BASELINE_SCHEMA || receipt.productionRef !== PRODUCTION_REF) {
    fail("baseline receipt has the wrong schema or production ref");
  }
  const repository = expectRepository(receipt.repository);
  const verifiedSha = expectSha(receipt.verifiedSha, "baseline receipt verifiedSha");
  const refSha = expectSha(receipt.refSha, "baseline receipt refSha");
  const lowerBound = parseReceiptTimestamp(receipt.lowerBound, "baseline receipt lowerBound");
  const completedAt = parseReceiptTimestamp(receipt.completedAt, "baseline receipt completedAt");
  if (completedAt.milliseconds < lowerBound.milliseconds) {
    fail("baseline receipt completed before its lower bound");
  }

  const deploymentFingerprintValue = expectString(
    receipt.deploymentFingerprint,
    "baseline receipt deploymentFingerprint",
  );
  if (!/^[0-9a-f]{64}$/u.test(deploymentFingerprintValue)) {
    fail("baseline receipt deploymentFingerprint is invalid");
  }
  const rawDeploymentIds = expectArray(receipt.deploymentIds, "baseline receipt deploymentIds");
  if (rawDeploymentIds.length > MAX_ITEMS) fail("baseline receipt exceeds the deployment cap");
  const deploymentIds = new Set();
  const normalizedDeploymentIds = rawDeploymentIds.map((value, index) => {
    const id = expectSafeId(value, `baseline deployment id ${String(index)}`);
    if (deploymentIds.has(id)) fail(`baseline receipt contains duplicate deployment ${String(id)}`);
    deploymentIds.add(id);
    return id;
  });
  for (let index = 1; index < normalizedDeploymentIds.length; index += 1) {
    if (normalizedDeploymentIds[index - 1] <= normalizedDeploymentIds[index]) {
      fail("baseline deployment ids are not in strict descending order");
    }
  }

  return Object.freeze({
    completedAt: completedAt.timestamp,
    completedMilliseconds: completedAt.milliseconds,
    deploymentFingerprint: deploymentFingerprintValue,
    deploymentIds: Object.freeze(normalizedDeploymentIds),
    lowerBound: lowerBound.timestamp,
    lowerBoundMilliseconds: lowerBound.milliseconds,
    productionRef: PRODUCTION_REF,
    refSha,
    repository,
    schema: BASELINE_SCHEMA,
    verifiedSha,
  });
}

function baselineReceiptValue(receipt) {
  return Object.freeze({
    completedAt: receipt.completedAt,
    deploymentFingerprint: receipt.deploymentFingerprint,
    deploymentIds: receipt.deploymentIds,
    lowerBound: receipt.lowerBound,
    productionRef: receipt.productionRef,
    refSha: receipt.refSha,
    repository: receipt.repository,
    schema: receipt.schema,
    verifiedSha: receipt.verifiedSha,
  });
}

function parsePromotionReceipt(value) {
  const receipt = expectRecord(value, "promotion receipt");
  expectExactKeys(receipt, [
    "baselineDigest",
    "boundaryAt",
    "mode",
    "previousSha",
    "productionRef",
    "releasePublishedAt",
    "repository",
    "schema",
    "verifiedSha",
    "verifiedTag",
  ], "promotion receipt");
  if (receipt.schema !== PROMOTION_SCHEMA || receipt.productionRef !== PRODUCTION_REF) {
    fail("promotion receipt has the wrong schema or production ref");
  }
  const mode = expectString(receipt.mode, "promotion receipt mode");
  if (mode !== "advanced" && mode !== "already-exact") fail("promotion receipt mode is unsupported");
  const baselineDigestValue = expectString(receipt.baselineDigest, "promotion receipt baselineDigest");
  if (!/^[0-9a-f]{64}$/u.test(baselineDigestValue)) fail("promotion receipt baselineDigest is invalid");
  const boundary = parseReceiptTimestamp(receipt.boundaryAt, "promotion receipt boundaryAt");
  const published = parseSecondTimestamp(receipt.releasePublishedAt, "promotion receipt releasePublishedAt");
  return Object.freeze({
    baselineDigest: baselineDigestValue,
    boundaryAt: boundary.timestamp,
    boundaryMilliseconds: boundary.milliseconds,
    mode,
    previousSha: expectSha(receipt.previousSha, "promotion receipt previousSha"),
    productionRef: PRODUCTION_REF,
    releasePublishedAt: published.timestamp,
    releasePublishedMilliseconds: published.milliseconds,
    repository: expectRepository(receipt.repository),
    schema: PROMOTION_SCHEMA,
    verifiedSha: expectSha(receipt.verifiedSha, "promotion receipt verifiedSha"),
    verifiedTag: expectStableTag(receipt.verifiedTag, "promotion receipt verifiedTag"),
  });
}

function promotionReceiptValue(receipt) {
  return Object.freeze({
    baselineDigest: receipt.baselineDigest,
    boundaryAt: receipt.boundaryAt,
    mode: receipt.mode,
    previousSha: receipt.previousSha,
    productionRef: receipt.productionRef,
    releasePublishedAt: receipt.releasePublishedAt,
    repository: receipt.repository,
    schema: receipt.schema,
    verifiedSha: receipt.verifiedSha,
    verifiedTag: receipt.verifiedTag,
  });
}

export async function createProviderBaseline({ api, repository, verifiedSha }) {
  const coordinate = expectRepository(repository);
  const sha = expectSha(verifiedSha, "verified SHA");
  const initialRef = await readProductionRefWithServerDate(api, coordinate);
  const lowerBound = initialRef.timestamp;
  const lowerBoundMilliseconds = initialRef.milliseconds;
  const refSha = initialRef.sha;
  const first = await collectProductionDeployments(api, coordinate);
  assertTerminalDeploymentInventory(first, "first baseline inventory");
  for (const deployment of first) {
    if (deployment.createdMilliseconds >= lowerBoundMilliseconds) {
      fail(`Production deployment ${String(deployment.id)} overlaps the baseline lower bound`);
    }
  }
  const second = await collectProductionDeployments(api, coordinate);
  assertTerminalDeploymentInventory(second, "second baseline inventory");
  if (deploymentFingerprint(first) !== deploymentFingerprint(second)) {
    fail("Production deployment inventory changed during the baseline snapshot");
  }
  const finalRef = await readProductionRefWithServerDate(api, coordinate);
  if (finalRef.sha !== refSha) fail("website-production moved during the baseline snapshot");
  if (finalRef.milliseconds < lowerBoundMilliseconds) {
    fail("GitHub server Date regressed during the baseline snapshot");
  }
  const receipt = Object.freeze({
    completedAt: finalRef.timestamp,
    deploymentFingerprint: deploymentFingerprint(second),
    deploymentIds: second.map((deployment) => deployment.id).sort((left, right) => right - left),
    lowerBound,
    productionRef: PRODUCTION_REF,
    refSha,
    repository: coordinate,
    schema: BASELINE_SCHEMA,
    verifiedSha: sha,
  });
  return baselineReceiptValue(parseBaselineReceipt(receipt));
}

export async function promoteWebsiteProduction({
  api,
  baselineReceipt,
  defaultBranch = "main",
  eventName = "push",
  recoveryWorkflowSha = "",
  repository,
  verifiedSha,
  verifiedTag,
}) {
  const coordinate = expectRepository(repository);
  const sha = expectSha(verifiedSha, "verified SHA");
  const tag = expectStableTag(verifiedTag, "verified tag");
  const baseline = parseBaselineReceipt(baselineReceipt);
  const workflowSource = Object.freeze({ defaultBranch, eventName, recoveryWorkflowSha });
  const baselineValue = baselineReceiptValue(baseline);
  if (baseline.repository !== coordinate || baseline.verifiedSha !== sha) {
    fail("baseline receipt does not bind the verified release coordinate");
  }

  await readVerifiedTagCommit(api, coordinate, tag, sha);
  const release = await readImmutableRelease(api, coordinate, tag);
  await readLatestRelease(api, coordinate, tag);
  const initialRefSha = await readProductionRef(api, coordinate);
  if (initialRefSha !== baseline.refSha) fail("website-production moved after the baseline snapshot");

  const prePatchRef = await readProductionRefWithServerDate(api, coordinate);
  if (prePatchRef.sha !== baseline.refSha) fail("website-production moved before promotion");
  if (
    prePatchRef.milliseconds < baseline.completedMilliseconds ||
    prePatchRef.milliseconds <= release.publishedMilliseconds
  ) {
    fail("promotion boundary does not follow the baseline and immutable Release");
  }

  let mode;
  if (prePatchRef.sha === sha) {
    mode = "already-exact";
  } else {
    mode = "advanced";
    await readFastForwardComparison(api, coordinate, prePatchRef.sha, sha);
    await revalidateWorkflowSource(api, coordinate, workflowSource);
    await api.patch(
      `/repos/${coordinate}/git/refs/heads/website-production`,
      Object.freeze({ force: false, sha }),
    );
  }

  const promotedSha = await readProductionRef(api, coordinate);
  if (promotedSha !== sha) fail(`website-production resolved to ${promotedSha} after promotion`);
  await revalidateWorkflowSource(api, coordinate, workflowSource);
  const receipt = Object.freeze({
    baselineDigest: receiptDigest(baselineValue),
    boundaryAt: prePatchRef.timestamp,
    mode,
    previousSha: prePatchRef.sha,
    productionRef: PRODUCTION_REF,
    releasePublishedAt: release.publishedAt,
    repository: coordinate,
    schema: PROMOTION_SCHEMA,
    verifiedSha: sha,
    verifiedTag: tag,
  });
  return promotionReceiptValue(parsePromotionReceipt(receipt));
}

function validateReceiptPair(
  baselineValue,
  promotionValue,
  { repository, verifiedSha, verifiedTag },
) {
  const authoritativeRepository = expectRepository(repository);
  const authoritativeSha = expectSha(verifiedSha, "authoritative verified SHA");
  const authoritativeTag = expectStableTag(verifiedTag, "authoritative verified tag");
  const baseline = parseBaselineReceipt(baselineValue);
  const promotion = parsePromotionReceipt(promotionValue);
  const digest = receiptDigest(baselineReceiptValue(baseline));
  if (promotion.baselineDigest !== digest) fail("promotion receipt does not bind the baseline receipt");
  if (
    baseline.repository !== promotion.repository ||
    baseline.verifiedSha !== promotion.verifiedSha ||
    promotion.previousSha !== baseline.refSha
  ) {
    fail("provider receipts do not bind one release transition");
  }
  if (
    promotion.repository !== authoritativeRepository ||
    promotion.verifiedSha !== authoritativeSha ||
    promotion.verifiedTag !== authoritativeTag
  ) {
    fail("provider receipts do not bind the authoritative release inputs");
  }
  if (
    promotion.boundaryMilliseconds < baseline.completedMilliseconds ||
    promotion.boundaryMilliseconds <= promotion.releasePublishedMilliseconds
  ) {
    fail("promotion receipt boundary does not follow the baseline and immutable Release");
  }
  if (
    (promotion.mode === "advanced" && promotion.previousSha === promotion.verifiedSha) ||
    (promotion.mode === "already-exact" && promotion.previousSha !== promotion.verifiedSha)
  ) {
    fail("promotion receipt mode contradicts the recorded ref transition");
  }
  return Object.freeze({ baseline, promotion });
}

function sameBaselineInventory(baseline, deployments) {
  const ids = new Set(baseline.deploymentIds);
  const currentBaseline = deployments.filter((item) => ids.has(item.id));
  return (
    currentBaseline.length === baseline.deploymentIds.length &&
    deploymentFingerprint(currentBaseline) === baseline.deploymentFingerprint
  );
}

function newDeployments(baseline, deployments) {
  const ids = new Set(baseline.deploymentIds);
  return deployments.filter((item) => !ids.has(item.id));
}

function exactGraphqlCandidate(item, expectedSha, label) {
  if (
    item.sha !== expectedSha ||
    item.task !== "deploy" ||
    item.environment !== "Production" ||
    item.originalEnvironment !== "Production" ||
    item.creator.id !== VERCEL_GRAPHQL_CREATOR.id ||
    item.creator.login !== VERCEL_GRAPHQL_CREATOR.login ||
    item.creator.type !== VERCEL_GRAPHQL_CREATOR.type
  ) {
    fail(`${label} does not bind the exact Vercel Production deployment identity`);
  }
  return item;
}

function candidateFingerprint(candidate) {
  return canonicalJson({
    createdAt: candidate.createdAt,
    creator: {
      id: candidate.raw.creator.id,
      login: candidate.raw.creator.login,
      type: candidate.raw.creator.type,
    },
    environment: candidate.raw.environment,
    id: candidate.id,
    originalEnvironment: candidate.raw.original_environment,
    ref: candidate.ref,
    sha: candidate.sha,
    task: candidate.raw.task,
  });
}

async function observeCandidate(api, baseline, promotion, pinnedCandidateId) {
  const refSha = await readProductionRef(api, promotion.repository);
  if (refSha !== promotion.verifiedSha) fail("website-production moved during provider verification");
  const deployments = await collectProductionDeployments(api, promotion.repository);
  if (!sameBaselineInventory(baseline, deployments)) {
    fail("a baseline Production deployment disappeared or changed");
  }

  let candidate;
  let graphCandidate;
  if (promotion.mode === "advanced") {
    const additions = newDeployments(baseline, deployments);
    for (const addition of additions) {
      if (addition.createdMilliseconds <= promotion.boundaryMilliseconds) {
        fail(`Production deployment ${String(addition.id)} falls in the concurrent promotion gap`);
      }
      exactGraphqlCandidate(
        addition,
        promotion.verifiedSha,
        `Production deployment ${String(addition.id)}`,
      );
    }
    if (additions.length > 1) fail("more than one new Production deployment followed promotion");
    candidate = additions[0];
  } else {
    if (
      deploymentFingerprint(deployments) !== baseline.deploymentFingerprint
    ) {
      fail("a concurrent Production deployment appeared during recovery verification");
    }
    const exactCandidates = deployments.filter(
      (deployment) => deployment.sha === promotion.verifiedSha,
    );
    candidate = exactCandidates[0];
    if (candidate !== undefined) {
      const second = exactCandidates[1];
      if (second !== undefined && second.createdAt === candidate.createdAt) {
        fail("the latest exact-SHA Production deployment is ambiguous at second precision");
      }
      const newerSuccessfulOtherSha = deployments.find(
        (deployment) =>
          deployment.sha !== promotion.verifiedSha &&
          deployment.createdMilliseconds >= candidate.createdMilliseconds &&
          deployment.latestStatus?.state === "SUCCESS" &&
          ["ACTIVE", "SUCCESS"].includes(deployment.state),
      );
      if (newerSuccessfulOtherSha !== undefined) {
        fail(
          `newer Production deployment ${String(newerSuccessfulOtherSha.id)} successfully binds another SHA`,
        );
      }
      exactGraphqlCandidate(
        candidate,
        promotion.verifiedSha,
        `Production deployment ${String(candidate.id)}`,
      );
      if (candidate.createdMilliseconds <= promotion.releasePublishedMilliseconds) {
        fail("the latest Production deployment does not postdate the immutable Release");
      }
    }
  }

  if (candidate !== undefined) {
    graphCandidate = candidate;
    const directCandidate = exactCandidate(
      await readDeployment(api, promotion.repository, graphCandidate.id),
      promotion.verifiedSha,
      `Production deployment ${String(graphCandidate.id)}`,
    );
    if (
      directCandidate.createdAt !== graphCandidate.createdAt ||
      directCandidate.id !== graphCandidate.id ||
      directCandidate.sha !== graphCandidate.sha
    ) {
      fail("GraphQL and REST candidate Production deployment identities disagree");
    }
    candidate = directCandidate;
    if (candidate.createdMilliseconds <= promotion.releasePublishedMilliseconds) {
      fail("the candidate Production deployment predates the immutable Release");
    }
    if (pinnedCandidateId !== undefined && candidate.id !== pinnedCandidateId) {
      fail("the candidate Production deployment changed after discovery");
    }
  } else if (pinnedCandidateId !== undefined) {
    fail("the candidate Production deployment disappeared after discovery");
  }
  return Object.freeze({
    candidate,
    deploymentFingerprint: deploymentFingerprint(deployments),
    deployments,
    graphCandidate,
  });
}

async function revalidateTerminalAuthority(api, promotion, workflowSource) {
  const refSha = await readProductionRef(api, promotion.repository);
  if (refSha !== promotion.verifiedSha) {
    fail("website-production moved at the terminal provider readback");
  }
  await readVerifiedTagCommit(
    api,
    promotion.repository,
    promotion.verifiedTag,
    promotion.verifiedSha,
  );
  const release = await readImmutableRelease(
    api,
    promotion.repository,
    promotion.verifiedTag,
  );
  if (release.publishedAt !== promotion.releasePublishedAt) {
    fail("immutable Release publication time changed");
  }
  await readLatestRelease(api, promotion.repository, promotion.verifiedTag);
  await revalidateWorkflowSource(api, promotion.repository, workflowSource);
}

function reconcileGraphqlRestStatus(graphCandidate, restCandidate, restStatus) {
  const graphStatus = graphCandidate.latestStatus;
  if (graphStatus === undefined) fail("GraphQL candidate has no current status");
  if (
    graphCandidate.id !== restCandidate.id ||
    graphCandidate.sha !== restCandidate.sha ||
    graphStatus.id !== restStatus.nodeId ||
    graphStatus.state !== restStatus.state.toUpperCase() ||
    graphStatus.createdAt !== restStatus.createdAt ||
    graphStatus.updatedAt !== restStatus.updatedAt ||
    graphStatus.environment !== restStatus.raw.environment ||
    graphStatus.environmentUrl !== restStatus.raw.environment_url ||
    graphStatus.logUrl !== restStatus.raw.log_url ||
    graphStatus.creator.id !== restStatus.raw.creator.id ||
    graphStatus.creator.type !== restStatus.raw.creator.type ||
    `${graphStatus.creator.login}[bot]` !== restStatus.raw.creator.login
  ) {
    fail("GraphQL and REST candidate status identities disagree");
  }
}

async function confirmSuccess(
  api,
  baseline,
  promotion,
  successSnapshot,
  workflowSource,
  deadline,
) {
  deadline.begin("begin provider success confirmation");
  await readVerifiedTagCommit(
    api,
    promotion.repository,
    promotion.verifiedTag,
    promotion.verifiedSha,
  );
  const release = await readImmutableRelease(api, promotion.repository, promotion.verifiedTag);
  if (release.publishedAt !== promotion.releasePublishedAt) fail("immutable Release publication time changed");
  await readLatestRelease(api, promotion.repository, promotion.verifiedTag);
  const observed = await observeCandidate(api, baseline, promotion, successSnapshot.candidate.id);
  if (observed.candidate === undefined) fail("candidate Production deployment disappeared after success");
  if (observed.graphCandidate === undefined) {
    fail("GraphQL candidate Production deployment disappeared after success");
  }
  const graphStatus = observed.graphCandidate.latestStatus;
  if (graphStatus === undefined || !GRAPHQL_TERMINAL_STATUS_STATES.has(graphStatus.state)) {
    fail("GraphQL candidate Production deployment regressed during success confirmation");
  }
  if (
    graphStatus.state !== "SUCCESS" ||
    !["ACTIVE", "SUCCESS"].includes(observed.graphCandidate.state)
  ) {
    fail(`GraphQL candidate Production deployment ended in ${graphStatus.state.toLowerCase()}`);
  }
  if (candidateFingerprint(observed.candidate) !== candidateFingerprint(successSnapshot.candidate)) {
    fail("candidate Production deployment changed before confirmation");
  }
  const confirmedDeploymentFingerprint = observed.deploymentFingerprint;
  const statuses = await collectDeploymentStatuses(api, promotion.repository, observed.candidate.id);
  if (statuses.length === 0) fail("candidate Production deployment statuses disappeared after success");
  validateCandidateStatuses(statuses, observed.candidate, promotion.repository);
  const currentObservation = observeRestCurrentStatus(statuses, observed.graphCandidate);
  assertNoTerminalRestFailure(statuses, observed.candidate.id);
  const latest = currentObservation.current;
  if (
    latest === undefined ||
    graphStatus.id !== latest.nodeId ||
    graphStatus.state !== latest.state.toUpperCase() ||
    latest.nodeId !== successSnapshot.status.nodeId ||
    latest.id !== successSnapshot.status.id ||
    latest.state !== "success" ||
    statusFingerprint(statuses) !== successSnapshot.statusFingerprint
  ) {
    fail("candidate Production deployment success changed before final readback");
  }
  reconcileGraphqlRestStatus(observed.graphCandidate, observed.candidate, latest);
  await revalidateTerminalAuthority(api, promotion, workflowSource);
  const finalStatuses = await collectDeploymentStatuses(
    api,
    promotion.repository,
    observed.candidate.id,
  );
  validateCandidateStatuses(finalStatuses, observed.candidate, promotion.repository);
  const finalObservation = observeRestCurrentStatus(finalStatuses, observed.graphCandidate);
  assertNoTerminalRestFailure(finalStatuses, observed.candidate.id);
  const finalLatest = finalObservation.current;
  if (
    finalLatest === undefined ||
    graphStatus.id !== finalLatest.nodeId ||
    graphStatus.state !== finalLatest.state.toUpperCase() ||
    finalLatest.nodeId !== successSnapshot.status.nodeId ||
    finalLatest.id !== successSnapshot.status.id ||
    finalLatest.state !== "success" ||
    statusFingerprint(finalStatuses) !== successSnapshot.statusFingerprint
  ) {
    fail("candidate Production deployment success changed at the terminal readback");
  }
  const terminalDeployments = await collectProductionDeployments(api, promotion.repository);
  if (deploymentFingerprint(terminalDeployments) !== confirmedDeploymentFingerprint) {
    fail("Production deployment inventory changed at the terminal readback");
  }
  const terminalGraphCandidate = terminalDeployments.find(
    (deployment) => deployment.id === observed.candidate.id,
  );
  if (terminalGraphCandidate === undefined || finalLatest === undefined) {
    fail("candidate Production deployment disappeared at the terminal readback");
  }
  if (
    terminalGraphCandidate.latestStatus?.state !== "SUCCESS" ||
    !["ACTIVE", "SUCCESS"].includes(terminalGraphCandidate.state) ||
    observeRestCurrentStatus(finalStatuses, terminalGraphCandidate).current?.id !== finalLatest.id
  ) {
    fail("candidate Production deployment success changed at the terminal inventory");
  }
  reconcileGraphqlRestStatus(terminalGraphCandidate, observed.candidate, finalLatest);
  await revalidateTerminalAuthority(api, promotion, workflowSource);
  return true;
}

export async function waitForProviderOutcome({
  api,
  baselineReceipt,
  defaultBranch,
  eventName,
  maxPolls = MAX_PROVIDER_POLLS,
  monotonicNow = () => performance.now(),
  promotionReceipt,
  repository,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMilliseconds = PROVIDER_POLL_INTERVAL_MILLISECONDS,
  recoveryWorkflowSha,
  verifiedSha,
  verifiedTag,
}) {
  if (!Number.isSafeInteger(maxPolls) || maxPolls <= 0 || maxPolls > MAX_PROVIDER_POLLS) {
    fail(`maxPolls must be between 1 and ${String(MAX_PROVIDER_POLLS)}`);
  }
  if (
    !Number.isSafeInteger(pollIntervalMilliseconds) ||
    pollIntervalMilliseconds < 0 ||
    pollIntervalMilliseconds > PROVIDER_POLL_INTERVAL_MILLISECONDS
  ) {
    fail(`pollIntervalMilliseconds must be between 0 and ${String(PROVIDER_POLL_INTERVAL_MILLISECONDS)}`);
  }
  const { baseline, promotion } = validateReceiptPair(
    baselineReceipt,
    promotionReceipt,
    { repository, verifiedSha, verifiedTag },
  );
  const workflowSource = Object.freeze({ defaultBranch, eventName, recoveryWorkflowSha });
  await readVerifiedTagCommit(
    api,
    promotion.repository,
    promotion.verifiedTag,
    promotion.verifiedSha,
  );
  const release = await readImmutableRelease(
    api,
    promotion.repository,
    promotion.verifiedTag,
  );
  if (release.publishedAt !== promotion.releasePublishedAt) fail("immutable Release publication time changed");
  await readLatestRelease(api, promotion.repository, promotion.verifiedTag);
  await revalidateWorkflowSource(api, promotion.repository, workflowSource);

  const deadline = createProviderDeadline(monotonicNow);
  const boundedApi = deadlineBoundReadApi(api, deadline);

  let pinnedCandidateId;
  let pinnedCandidateFingerprint;
  const observedStatuses = new Map();
  let observedAnyStatus = false;

  for (let poll = 1; poll <= maxPolls; poll += 1) {
    deadline.begin("begin provider observation");
    const observed = await observeCandidate(
      boundedApi,
      baseline,
      promotion,
      pinnedCandidateId,
    );
    const candidate = observed.candidate;
    const graphCandidate = observed.graphCandidate;
    if (candidate !== undefined) {
      const fingerprint = candidateFingerprint(candidate);
      if (pinnedCandidateId === undefined) {
        pinnedCandidateId = candidate.id;
        pinnedCandidateFingerprint = fingerprint;
      } else if (fingerprint !== pinnedCandidateFingerprint) {
        fail("the candidate Production deployment changed after discovery");
      }
    }
    if (candidate !== undefined) {
      if (pinnedCandidateId === undefined || graphCandidate === undefined) {
        fail("candidate Production deployment was not pinned across both provider APIs");
      }
      const graphStatus = graphCandidate.latestStatus;
      if (
        graphStatus !== undefined &&
        GRAPHQL_TERMINAL_STATUS_STATES.has(graphStatus.state) &&
        graphStatus.state !== "SUCCESS"
      ) {
        fail(`candidate Production deployment ended in ${graphStatus.state.toLowerCase()}`);
      }

      const statuses = await collectDeploymentStatuses(
        boundedApi,
        promotion.repository,
        candidate.id,
      );
      if (statuses.length === 0) {
        if (observedAnyStatus) fail("candidate Production deployment statuses disappeared");
      } else {
        observedAnyStatus = true;
        validateCandidateStatuses(statuses, candidate, promotion.repository);
        const currentById = new Map(statuses.map((status) => [status.id, status]));
        for (const [id, fingerprint] of observedStatuses) {
          const current = currentById.get(id);
          if (current === undefined) fail("a candidate Production deployment status disappeared");
          const currentFingerprint = canonicalJson(statusFingerprintValue(current));
          if (currentFingerprint !== fingerprint) {
            fail(`candidate Production deployment status ${String(id)} changed`);
          }
        }
        for (const status of statuses) {
          observedStatuses.set(status.id, canonicalJson(statusFingerprintValue(status)));
        }
        const currentObservation = observeRestCurrentStatus(statuses, graphCandidate);
        assertNoTerminalRestFailure(statuses, candidate.id);
        const latest = currentObservation.current;
        const currentConverged =
          latest !== undefined &&
          graphStatus !== undefined &&
          latest.nodeId === graphStatus.id &&
          latest.state.toUpperCase() === graphStatus.state;
        if (
          !currentConverged &&
          graphStatus?.state === "SUCCESS" &&
          latest?.state === "success"
        ) {
          fail("GraphQL and REST candidate current success identities disagree");
        }
        if (currentConverged) {
          reconcileGraphqlRestStatus(graphCandidate, candidate, latest);
        }
        if (currentConverged && graphStatus.state === "SUCCESS" && latest.state === "success") {
          if (latest.createdMilliseconds <= promotion.releasePublishedMilliseconds) {
            fail("candidate Production deployment success predates the immutable Release");
          }
          const successSnapshot = Object.freeze({
            candidate,
            status: latest,
            statusFingerprint: statusFingerprint(statuses),
          });
          if (await confirmSuccess(
            boundedApi,
            baseline,
            promotion,
            successSnapshot,
            workflowSource,
            deadline,
          )) {
            return Object.freeze({ deploymentId: candidate.id, statusId: latest.id });
          }
        }
      }
    }

    if (poll < maxPolls) {
      await waitForProviderScheduleTarget(
        deadline,
        sleep,
        pollIntervalMilliseconds,
        poll,
      );
    }
  }
  if (maxPolls < MAX_PROVIDER_POLLS) {
    fail("provider observation poll budget exhausted before its monotonic deadline");
  }
  if (pollIntervalMilliseconds !== PROVIDER_POLL_INTERVAL_MILLISECONDS) {
    fail("provider observation test cadence exhausted before its monotonic deadline");
  }
  await waitForProviderScheduleTarget(
    deadline,
    sleep,
    pollIntervalMilliseconds,
    MAX_PROVIDER_POLLS,
    { allowDeadlineTarget: true },
  );
  fail(PROVIDER_TIMEOUT_MESSAGE);
}

class GitHubApi {
  #environment;

  constructor(environment = process.env) {
    this.#environment = environment;
  }

  #runRaw(
    args,
    label,
    { timeoutMilliseconds = PROVIDER_API_CALL_TIMEOUT_MILLISECONDS } = {},
  ) {
    if (
      !Number.isSafeInteger(timeoutMilliseconds) ||
      timeoutMilliseconds <= 0 ||
      timeoutMilliseconds > PROVIDER_API_CALL_TIMEOUT_MILLISECONDS
    ) {
      fail(
        `${label} timeout must be between 1 and ${String(PROVIDER_API_CALL_TIMEOUT_MILLISECONDS)} milliseconds`,
      );
    }
    const result = spawnSync("gh", ["api", ...args], {
      encoding: "utf8",
      env: this.#environment,
      maxBuffer: MAX_RESPONSE_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMilliseconds,
    });
    if (result.error !== undefined) fail(`${label} could not start: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
      fail(`${label} failed${detail.length === 0 ? "" : `: ${detail}`}`);
    }
    return result.stdout;
  }

  #run(args, label, options) {
    return parseJson(this.#runRaw(args, label, options), label);
  }

  async get(endpoint, options) {
    return this.#run([endpoint], `GET ${endpoint}`, options);
  }

  async getWithServerDate(endpoint, options) {
    const label = `GET with Date ${endpoint}`;
    const response = this.#runRaw(["--include", endpoint], label, options);
    return parseIncludedGitHubResponse(response, label);
  }

  async graphql({ after, name, owner, query }, options) {
    if (query !== PRODUCTION_DEPLOYMENTS_QUERY) fail("unexpected GraphQL query");
    const args = [
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${expectString(owner, "GraphQL owner")}`,
      "-f",
      `name=${expectString(name, "GraphQL repository name")}`,
    ];
    if (after !== undefined) {
      args.push("-f", `after=${expectGraphqlId(after, "GraphQL cursor")}`);
    }
    return this.#run(args, "GraphQL Production deployments", options);
  }

  async patch(endpoint, body, options) {
    if (!isRecord(body) || body.force !== false || typeof body.sha !== "string") {
      fail("PATCH body is not the exact non-force ref update");
    }
    return this.#run(
      ["--method", "PATCH", endpoint, "-f", `sha=${body.sha}`, "-F", "force=false"],
      `PATCH ${endpoint}`,
      options,
    );
  }
}

function writeReceiptOutput(receipt) {
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output !== "string" || output.length === 0) fail("GITHUB_OUTPUT is unavailable");
  appendFileSync(output, `receipt=${encodeProviderReceipt(receipt)}\n`, { encoding: "utf8" });
}

async function main() {
  const command = process.argv[2];
  const api = new GitHubApi();
  if (command === "baseline") {
    const receipt = await createProviderBaseline({
      api,
      repository: process.env.GITHUB_REPOSITORY,
      verifiedSha: process.env.VERIFIED_SHA,
    });
    writeReceiptOutput(receipt);
    return;
  }
  if (command === "release-order") {
    await assertReleaseTagNewerThanPublished({
      api,
      repository: process.env.GITHUB_REPOSITORY,
      verifiedTag: process.env.VERIFIED_TAG,
    });
    return;
  }
  if (command === "inspect-release-response") {
    const response = parseOptionalIncludedGitHubResponse(
      readFileSync(0, "utf8"),
      "Release lookup response",
    );
    if (response.found) {
      exactPublishedRelease(response.value, process.env.VERIFIED_TAG, "existing Release");
      process.stdout.write("found\n");
    } else {
      process.stdout.write("missing\n");
    }
    return;
  }
  if (command === "validate-release") {
    exactPublishedRelease(
      parseJson(readFileSync(0, "utf8"), "Release response"),
      process.env.VERIFIED_TAG,
      "Release response",
    );
    return;
  }
  if (command === "revalidate-source") {
    await revalidateWorkflowSource(api, process.env.GITHUB_REPOSITORY, {
      defaultBranch: process.env.DEFAULT_BRANCH,
      eventName: process.env.EVENT_NAME,
      recoveryWorkflowSha: process.env.RECOVERY_WORKFLOW_SHA,
    });
    return;
  }
  if (command === "promote") {
    const receipt = await promoteWebsiteProduction({
      api,
      baselineReceipt: decodeProviderReceipt(process.env.BASELINE_RECEIPT, "BASELINE_RECEIPT"),
      defaultBranch: process.env.DEFAULT_BRANCH,
      eventName: process.env.EVENT_NAME,
      recoveryWorkflowSha: process.env.RECOVERY_WORKFLOW_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      verifiedSha: process.env.VERIFIED_SHA,
      verifiedTag: process.env.VERIFIED_TAG,
    });
    writeReceiptOutput(receipt);
    return;
  }
  if (command === "wait") {
    const testMode = process.env.WRENCH_PROVIDER_TEST_MODE === "1";
    const maxPolls = testMode
      ? Number(process.env.WRENCH_PROVIDER_MAX_POLLS ?? String(MAX_PROVIDER_POLLS))
      : MAX_PROVIDER_POLLS;
    const pollIntervalMilliseconds = testMode
      ? Number(process.env.WRENCH_PROVIDER_POLL_INTERVAL_MS ?? "0")
      : PROVIDER_POLL_INTERVAL_MILLISECONDS;
    const result = await waitForProviderOutcome({
      api,
      baselineReceipt: decodeProviderReceipt(process.env.BASELINE_RECEIPT, "BASELINE_RECEIPT"),
      defaultBranch: process.env.DEFAULT_BRANCH,
      eventName: process.env.EVENT_NAME,
      maxPolls,
      pollIntervalMilliseconds,
      promotionReceipt: decodeProviderReceipt(process.env.PROMOTION_RECEIPT, "PROMOTION_RECEIPT"),
      recoveryWorkflowSha: process.env.RECOVERY_WORKFLOW_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      verifiedSha: process.env.VERIFIED_SHA,
      verifiedTag: process.env.VERIFIED_TAG,
    });
    process.stdout.write(
      `Verified Vercel Production deployment ${String(result.deploymentId)} at status ${String(result.statusId)}\n`,
    );
    return;
  }
  fail("expected baseline, release-order, release validation, promote, or wait command");
}

const invokedPath = process.argv[1];
if (typeof invokedPath === "string" && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  });
}
