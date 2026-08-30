#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { withReleaseAppTokenFromEnvironment } from "./release-app-token.mjs";
import {
  parseIncludedGitHubResponse,
  scrubReadOnlyGithubEnvironment,
} from "./release-provider-outcome.mjs";

const EXPECTED_REPOSITORY = "hraness/wrench";
const EXPECTED_REPOSITORY_ID = 1_316_443_113;
const EXPECTED_ACTOR = "0thernet";
const EXPECTED_ACTOR_ID = 894_119;
const EXPECTED_WORKFLOW = "Prove release App canary";
const EXPECTED_WORKFLOW_PATH = ".github/workflows/release-app-canary.yml";
const DEFAULT_BRANCH = "main";
const MAIN_REF = "refs/heads/main";
const PRODUCTION_REF = "refs/heads/website-production";
const CANARY_BRANCH = "website-production-canary";
const CANARY_REF = `refs/heads/${CANARY_BRANCH}`;
const FIXED_REMOTE = "https://github.com/hraness/wrench.git";
const GIT_EXECUTABLE = "/usr/bin/git";
const GH_EXECUTABLE = "/usr/bin/gh";
const FIXED_PATH = "/usr/bin:/bin";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4096;
const COMMAND_TIMEOUT_MILLISECONDS = 60_000;
const API_TIMEOUT_MILLISECONDS = 10_000;
const TOKEN_REUSE_TIMEOUT_MILLISECONDS = 10_000;
const SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const SECOND_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u;
const NODE_ID = /^RRS_[A-Za-z0-9_-]+$/u;

// Replace only these two sentinels after #105 and the control PR are merged.
// P must be the #105 Vercel-exclusion merge. C must be its direct-child control merge.
export const CANARY_START_PLACEHOLDER = "1111111111111111111111111111111111111111";
export const CANARY_TARGET_PLACEHOLDER = "2222222222222222222222222222222222222222";

export const fixedCanaryCoordinate = Object.freeze({
  startSha: CANARY_START_PLACEHOLDER,
  targetSha: CANARY_TARGET_PLACEHOLDER,
});

const PLACEHOLDERS = new Set([CANARY_START_PLACEHOLDER, CANARY_TARGET_PLACEHOLDER]);

const CONTROL_DIFF = Object.freeze([
  "A\t.github/CODEOWNERS",
  "M\t.github/workflows/release.yml",
  "A\t.github/workflows/website-production.yml",
  "M\tAGENTS.md",
  "M\tdocs/publishing.md",
  "M\tscripts/npm-stage-workflow.test.ts",
  "A\tscripts/release-app-token.mjs",
  "M\tscripts/release-provider-outcome.mjs",
  "A\tscripts/release-ref-writer.mjs",
  "M\twebsite/AGENTS.md",
  "M\twebsite/README.md",
]);

const TEMPORARY_CANARY_DIFF = Object.freeze([
  "A\t.github/workflows/release-app-canary.yml",
  "M\tdocs/publishing.md",
  "M\tscripts/npm-stage-workflow.test.ts",
  "A\tscripts/release-app-canary.mjs",
]);

const ASKPASS = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' 'x-access-token' ;;
  *Password*) printf '%s\\n' "$WRENCH_RELEASE_APP_TOKEN" ;;
  *) exit 1 ;;
esac
`;

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
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail(`${label} has an unexpected shape`);
  }
}

function expectAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has an unexpected ${key} field`);
  }
}

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} is not one lowercase SHA`);
  return value;
}

function exactPositiveInteger(value, label) {
  if (typeof value !== "string" || !POSITIVE_INTEGER.test(value)) {
    fail(`${label} is not one canonical positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} exceeds the safe integer range`);
  return parsed;
}

function exactPositiveNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} is not a positive safe integer`);
  return value;
}

function exactSecondTimestamp(value, label) {
  const timestamp = expectString(value, label);
  if (!SECOND_TIMESTAMP.test(timestamp)) fail(`${label} is not one second-precision UTC timestamp`);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace(".000Z", "Z") !== timestamp) {
    fail(`${label} is not one real canonical timestamp`);
  }
  return timestamp;
}

function exactNodeId(value, label) {
  if (typeof value !== "string" || !NODE_ID.test(value)) fail(`${label} is not one ruleset node ID`);
  return value;
}

function exactEnvironmentString(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0) fail(`${key} is missing`);
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedDiagnostic(value, token = "") {
  if (typeof value !== "string") return "";
  const redacted = token.length === 0 ? value : value.replaceAll(token, "[redacted]");
  const trimmed = redacted.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= MAX_DIAGNOSTIC_BYTES) return trimmed;
  return `${Buffer.from(trimmed, "utf8").subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8")}…`;
}

export function parseCanaryCoordinate(value) {
  const coordinate = expectRecord(value, "canary coordinate");
  expectExactKeys(coordinate, ["startSha", "targetSha"], "canary coordinate");
  const startSha = exactSha(coordinate.startSha, "canary start SHA P");
  const targetSha = exactSha(coordinate.targetSha, "canary target SHA C");
  if (PLACEHOLDERS.has(startSha) || PLACEHOLDERS.has(targetSha)) {
    fail("temporary canary P/C placeholders have not been replaced");
  }
  if (startSha === targetSha) fail("canary P and C must be distinct commits");
  return Object.freeze({ startSha, targetSha });
}

export function parseCanaryInvocation(environment) {
  const repository = exactEnvironmentString(environment, "GITHUB_REPOSITORY");
  const repositoryId = exactPositiveInteger(
    exactEnvironmentString(environment, "GITHUB_REPOSITORY_ID"),
    "GITHUB_REPOSITORY_ID",
  );
  const actorId = exactPositiveInteger(
    exactEnvironmentString(environment, "GITHUB_ACTOR_ID"),
    "GITHUB_ACTOR_ID",
  );
  const runAttempt = exactPositiveInteger(
    exactEnvironmentString(environment, "GITHUB_RUN_ATTEMPT"),
    "GITHUB_RUN_ATTEMPT",
  );
  const runId = exactPositiveInteger(
    exactEnvironmentString(environment, "GITHUB_RUN_ID"),
    "GITHUB_RUN_ID",
  );
  const workflowSha = exactSha(
    exactEnvironmentString(environment, "GITHUB_WORKFLOW_SHA"),
    "GITHUB_WORKFLOW_SHA",
  );
  const eventSha = exactSha(
    exactEnvironmentString(environment, "GITHUB_SHA"),
    "GITHUB_SHA",
  );
  if (
    repository !== EXPECTED_REPOSITORY ||
    repositoryId !== EXPECTED_REPOSITORY_ID ||
    exactEnvironmentString(environment, "GITHUB_EVENT_NAME") !== "workflow_dispatch" ||
    exactEnvironmentString(environment, "GITHUB_REF") !== MAIN_REF ||
    exactEnvironmentString(environment, "GITHUB_REF_PROTECTED") !== "true" ||
    exactEnvironmentString(environment, "GITHUB_ACTOR") !== EXPECTED_ACTOR ||
    actorId !== EXPECTED_ACTOR_ID ||
    exactEnvironmentString(environment, "GITHUB_TRIGGERING_ACTOR") !== EXPECTED_ACTOR ||
    exactEnvironmentString(environment, "GITHUB_WORKFLOW") !== EXPECTED_WORKFLOW ||
    exactEnvironmentString(environment, "GITHUB_WORKFLOW_REF") !==
      `${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW_PATH}@${MAIN_REF}` ||
    runAttempt !== 1 ||
    workflowSha !== eventSha
  ) {
    fail("canary must be one first-attempt dispatch by exact maintainer from exact protected Wrench main");
  }
  return Object.freeze({ actorId, repository, repositoryId, runId, workflowSha });
}

function gitEnvironment(environment) {
  return Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    PATH: FIXED_PATH,
    ...environment,
  });
}

function runGitRead(arguments_, cwd, spawnImplementation = spawnSync) {
  const result = spawnImplementation(GIT_EXECUTABLE, [...arguments_], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment({}),
    maxBuffer: MAX_RESPONSE_BYTES,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MILLISECONDS,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = boundedDiagnostic(result.error?.message ?? result.stderr);
    fail(`canary Git topology read failed${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > MAX_RESPONSE_BYTES) {
    fail("canary Git topology read exceeded its response bound");
  }
  return result.stdout;
}

function exactParentLine(value, child, parent, label) {
  if (value !== `${child} ${parent}\n`) fail(`${label} is not one exact direct-parent edge`);
}

function exactNameStatus(value, expected, label) {
  const actual = value.trimEnd().length === 0 ? [] : value.trimEnd().split("\n");
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} changed an unexpected path or status`);
}

function exactVercelExclusion(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`${label} vercel.json is not valid JSON`);
  }
  const manifest = expectRecord(parsed, `${label} vercel.json`);
  const git = expectRecord(manifest.git, `${label} vercel.json git`);
  const enabled = expectRecord(git.deploymentEnabled, `${label} vercel.json deploymentEnabled`);
  if (enabled[CANARY_BRANCH] !== false) fail(`${label} does not suppress the persistent canary Vercel preview`);
}

export function assertCanaryGitTopology(options) {
  const coordinate = parseCanaryCoordinate(options.coordinate ?? fixedCanaryCoordinate);
  const workflowSha = exactSha(options.workflowSha, "canary workflow SHA D");
  if (workflowSha === coordinate.startSha || workflowSha === coordinate.targetSha) {
    fail("canary workflow SHA D must be distinct from P and C");
  }
  const read = (arguments_) => runGitRead(arguments_, options.cwd, options.spawnImplementation);
  if (read(["rev-parse", "--verify", "HEAD^{commit}"]) !== `${workflowSha}\n`) {
    fail("checked-out canary source is not exact workflow SHA D");
  }
  exactParentLine(
    read(["rev-list", "--parents", "-n", "1", coordinate.targetSha]),
    coordinate.targetSha,
    coordinate.startSha,
    "control commit C",
  );
  exactParentLine(
    read(["rev-list", "--parents", "-n", "1", workflowSha]),
    workflowSha,
    coordinate.targetSha,
    "temporary canary source D",
  );
  exactNameStatus(
    read(["diff", "--name-status", "--no-renames", coordinate.startSha, coordinate.targetSha]),
    CONTROL_DIFF,
    "P to C control edge",
  );
  exactNameStatus(
    read(["diff", "--name-status", "--no-renames", coordinate.targetSha, workflowSha]),
    TEMPORARY_CANARY_DIFF,
    "C to D temporary canary edge",
  );
  const vercelAtP = read(["show", `${coordinate.startSha}:vercel.json`]);
  const vercelAtC = read(["show", `${coordinate.targetSha}:vercel.json`]);
  const vercelAtD = read(["show", `${workflowSha}:vercel.json`]);
  if (vercelAtP !== vercelAtC || vercelAtC !== vercelAtD) {
    fail("P, C, and D do not retain one byte-identical Vercel canary exclusion");
  }
  exactVercelExclusion(vercelAtP, "P");
  return Object.freeze({ ...coordinate, workflowSha });
}

function parseRepository(value) {
  const repository = expectRecord(value, "repository readback");
  if (
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.full_name !== EXPECTED_REPOSITORY ||
    repository.default_branch !== DEFAULT_BRANCH
  ) {
    fail("repository readback is not exact Wrench with default branch main");
  }
}

export function parseSingleCanaryRun(value, invocation) {
  const listing = expectRecord(value, "canary workflow-run history");
  expectExactKeys(listing, ["total_count", "workflow_runs"], "canary workflow-run history");
  const runs = expectArray(listing.workflow_runs, "canary workflow runs");
  if (listing.total_count !== 1 || runs.length !== 1) {
    fail("temporary canary is not one unique first and only workflow run");
  }
  const run = expectRecord(runs[0], "canary workflow run");
  const actor = expectRecord(run.actor, "canary workflow run actor");
  const triggeringActor = expectRecord(
    run.triggering_actor,
    "canary workflow run triggering actor",
  );
  const repository = expectRecord(run.repository, "canary workflow run repository");
  if (
    run.id !== invocation.runId ||
    run.run_attempt !== 1 ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== DEFAULT_BRANCH ||
    run.head_sha !== invocation.workflowSha ||
    run.path !== EXPECTED_WORKFLOW_PATH ||
    !["in_progress", "waiting"].includes(run.status) ||
    actor.id !== EXPECTED_ACTOR_ID ||
    actor.login !== EXPECTED_ACTOR ||
    actor.type !== "User" ||
    triggeringActor.id !== EXPECTED_ACTOR_ID ||
    triggeringActor.login !== EXPECTED_ACTOR ||
    triggeringActor.type !== "User" ||
    repository.id !== EXPECTED_REPOSITORY_ID ||
    repository.full_name !== EXPECTED_REPOSITORY
  ) {
    fail("temporary canary workflow-run history does not match this exact active dispatch");
  }
  return exactPositiveNumber(run.workflow_id, "canary workflow ID");
}

async function assertSingleCanaryRun(api, invocation) {
  return parseSingleCanaryRun(
    await api.get(
      `/repos/${EXPECTED_REPOSITORY}/actions/workflows/release-app-canary.yml/runs` +
        "?event=workflow_dispatch&per_page=2",
    ),
    invocation,
  );
}

function parseRef(value, expectedRef, label) {
  const record = expectRecord(value, label);
  const object = expectRecord(record.object, `${label} object`);
  if (record.ref !== expectedRef || object.type !== "commit") fail(`${label} is not the exact commit ref`);
  return exactSha(object.sha, `${label} SHA`);
}

function exactApplicableRule(value, label) {
  const rule = expectRecord(value, label);
  const expectedKeys = rule.type === "update"
    ? ["parameters", "ruleset_id", "ruleset_source", "ruleset_source_type", "type"]
    : ["ruleset_id", "ruleset_source", "ruleset_source_type", "type"];
  expectExactKeys(rule, expectedKeys, label);
  if (
    rule.ruleset_source !== EXPECTED_REPOSITORY ||
    rule.ruleset_source_type !== "Repository"
  ) {
    fail(`${label} is not owned by the exact repository`);
  }
  const rulesetId = exactPositiveNumber(rule.ruleset_id, `${label} ruleset ID`);
  if (!["creation", "deletion", "non_fast_forward", "update"].includes(rule.type)) {
    fail(`${label} has an unexpected rule type`);
  }
  if (rule.type === "update") {
    const parameters = expectRecord(rule.parameters, `${label} parameters`);
    expectExactKeys(parameters, ["update_allows_fetch_and_merge"], `${label} parameters`);
    if (parameters.update_allows_fetch_and_merge !== false) {
      fail(`${label} unexpectedly allows fetch-and-merge updates`);
    }
  }
  return Object.freeze({ rulesetId, type: rule.type });
}

export function parseApplicableRules(value, label = "applicable rules") {
  const rules = expectArray(value, label).map((rule, index) =>
    exactApplicableRule(rule, `${label} row ${String(index)}`));
  if (rules.length !== 4) fail(`${label} does not contain exactly four controls`);
  const byType = new Map(rules.map((rule) => [rule.type, rule]));
  if (byType.size !== 4) fail(`${label} contains a duplicate rule type`);
  const creation = byType.get("creation");
  const deletion = byType.get("deletion");
  const nonFastForward = byType.get("non_fast_forward");
  const update = byType.get("update");
  if (
    creation === undefined ||
    deletion === undefined ||
    nonFastForward === undefined ||
    update === undefined ||
    creation.rulesetId !== deletion.rulesetId ||
    deletion.rulesetId !== nonFastForward.rulesetId ||
    update.rulesetId === creation.rulesetId
  ) {
    fail(`${label} does not separate one lifecycle layer from one update layer`);
  }
  return Object.freeze({
    lifecycleRulesetId: creation.rulesetId,
    updateRulesetId: update.rulesetId,
  });
}

function parseRulesetLinks(value, rulesetId) {
  const links = expectRecord(value, "ruleset links");
  expectExactKeys(links, ["html", "self"], "ruleset links");
  const self = expectRecord(links.self, "ruleset self link");
  const html = expectRecord(links.html, "ruleset html link");
  expectExactKeys(self, ["href"], "ruleset self link");
  expectExactKeys(html, ["href"], "ruleset html link");
  if (
    self.href !== `https://api.github.com/repos/${EXPECTED_REPOSITORY}/rulesets/${String(rulesetId)}` ||
    html.href !== `https://github.com/${EXPECTED_REPOSITORY}/rules/${String(rulesetId)}`
  ) {
    fail("ruleset links are not exact repository links");
  }
}

function parseRulesetConditions(value) {
  const conditions = expectRecord(value, "ruleset conditions");
  expectExactKeys(conditions, ["ref_name"], "ruleset conditions");
  const refName = expectRecord(conditions.ref_name, "ruleset ref condition");
  expectExactKeys(refName, ["exclude", "include"], "ruleset ref condition");
  const include = expectArray(refName.include, "ruleset included refs");
  const exclude = expectArray(refName.exclude, "ruleset excluded refs");
  if (
    JSON.stringify([...include].sort()) !== JSON.stringify([CANARY_REF, PRODUCTION_REF].sort()) ||
    exclude.length !== 0
  ) {
    fail("ruleset does not target exactly production and persistent canary refs");
  }
}

function parseDetailedRule(value, kind, label) {
  const rule = expectRecord(value, label);
  if (kind === "update") {
    expectExactKeys(rule, ["parameters", "type"], label);
    const parameters = expectRecord(rule.parameters, `${label} parameters`);
    expectExactKeys(parameters, ["update_allows_fetch_and_merge"], `${label} parameters`);
    if (rule.type !== "update" || parameters.update_allows_fetch_and_merge !== false) {
      fail(`${label} is not the exact update restriction`);
    }
    return;
  }
  expectExactKeys(rule, ["type"], label);
  if (rule.type !== kind) fail(`${label} is not the expected ${kind} rule`);
}

function parseRuleset(value, input) {
  const ruleset = expectRecord(value, `${input.kind} ruleset`);
  expectAllowedKeys(
    ruleset,
    [
      "_links",
      "conditions",
      "created_at",
      "current_user_can_bypass",
      "enforcement",
      "id",
      "name",
      "node_id",
      "rules",
      "source",
      "source_type",
      "target",
      "updated_at",
    ],
    `${input.kind} ruleset`,
  );
  for (const required of [
    "_links",
    "conditions",
    "created_at",
    "enforcement",
    "id",
    "name",
    "node_id",
    "rules",
    "source",
    "source_type",
    "target",
    "updated_at",
  ]) {
    if (!Object.hasOwn(ruleset, required)) fail(`${input.kind} ruleset is missing ${required}`);
  }
  if (Object.hasOwn(ruleset, "bypass_actors")) {
    fail(`${input.kind} read-only ruleset response unexpectedly disclosed bypass actors`);
  }
  if (
    ruleset.id !== input.id ||
    ruleset.name !== input.name ||
    ruleset.target !== "branch" ||
    ruleset.source_type !== "Repository" ||
    ruleset.source !== EXPECTED_REPOSITORY ||
    ruleset.enforcement !== "active"
  ) {
    fail(`${input.kind} ruleset identity or enforcement drifted`);
  }
  if (Object.hasOwn(ruleset, "current_user_can_bypass") && ruleset.current_user_can_bypass !== "never") {
    fail(`${input.kind} read-only workflow unexpectedly can bypass its ruleset`);
  }
  parseRulesetLinks(ruleset._links, input.id);
  parseRulesetConditions(ruleset.conditions);
  const rules = expectArray(ruleset.rules, `${input.kind} ruleset rules`);
  const expectedKinds = input.kind === "lifecycle"
    ? ["creation", "deletion", "non_fast_forward"]
    : ["update"];
  if (rules.length !== expectedKinds.length) fail(`${input.kind} ruleset has an unexpected rule count`);
  for (let index = 0; index < expectedKinds.length; index += 1) {
    parseDetailedRule(rules[index], expectedKinds[index], `${input.kind} ruleset row ${String(index)}`);
  }
  const createdAt = exactSecondTimestamp(ruleset.created_at, `${input.kind} ruleset created_at`);
  const updatedAt = exactSecondTimestamp(ruleset.updated_at, `${input.kind} ruleset updated_at`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail(`${input.kind} ruleset update predates creation`);
  return Object.freeze({
    createdAt,
    id: input.id,
    name: input.name,
    nodeId: exactNodeId(ruleset.node_id, `${input.kind} ruleset node ID`),
    updatedAt,
  });
}

function parseRulesetEnvironment(environment) {
  const lifecycleRulesetId = exactPositiveInteger(
    exactEnvironmentString(environment, "WRENCH_RELEASE_LIFECYCLE_RULESET_ID"),
    "WRENCH_RELEASE_LIFECYCLE_RULESET_ID",
  );
  const updateRulesetId = exactPositiveInteger(
    exactEnvironmentString(environment, "WRENCH_RELEASE_UPDATE_RULESET_ID"),
    "WRENCH_RELEASE_UPDATE_RULESET_ID",
  );
  if (lifecycleRulesetId === updateRulesetId) fail("lifecycle and update rulesets must be distinct");
  return Object.freeze({
    appId: exactPositiveInteger(
      exactEnvironmentString(environment, "WRENCH_RELEASE_APP_ID"),
      "WRENCH_RELEASE_APP_ID",
    ),
    lifecycleRulesetId,
    lifecycleUpdatedAt: exactSecondTimestamp(
      exactEnvironmentString(environment, "WRENCH_RELEASE_LIFECYCLE_RULESET_UPDATED_AT"),
      "WRENCH_RELEASE_LIFECYCLE_RULESET_UPDATED_AT",
    ),
    updateRulesetId,
    updateUpdatedAt: exactSecondTimestamp(
      exactEnvironmentString(environment, "WRENCH_RELEASE_UPDATE_RULESET_UPDATED_AT"),
      "WRENCH_RELEASE_UPDATE_RULESET_UPDATED_AT",
    ),
  });
}

async function readControlSnapshot(api) {
  const server = await api.getWithServerDate(`/repos/${EXPECTED_REPOSITORY}`);
  parseRepository(server.body);
  const [main, canary, production, canaryRules, productionRules] = await Promise.all([
    api.get(`/repos/${EXPECTED_REPOSITORY}/git/ref/heads/${DEFAULT_BRANCH}`),
    api.get(`/repos/${EXPECTED_REPOSITORY}/git/ref/heads/${CANARY_BRANCH}`),
    api.get(`/repos/${EXPECTED_REPOSITORY}/git/ref/heads/website-production`),
    api.get(`/repos/${EXPECTED_REPOSITORY}/rules/branches/${CANARY_BRANCH}`),
    api.get(`/repos/${EXPECTED_REPOSITORY}/rules/branches/website-production`),
  ]);
  const canaryApplicable = parseApplicableRules(canaryRules, "canary applicable rules");
  const productionApplicable = parseApplicableRules(productionRules, "production applicable rules");
  if (canonicalJson(canaryApplicable) !== canonicalJson(productionApplicable)) {
    fail("production and canary applicable-rule projections are not identical");
  }
  const [lifecycleRuleset, updateRuleset] = await Promise.all([
    api.get(`/repos/${EXPECTED_REPOSITORY}/rulesets/${String(canaryApplicable.lifecycleRulesetId)}`),
    api.get(`/repos/${EXPECTED_REPOSITORY}/rulesets/${String(canaryApplicable.updateRulesetId)}`),
  ]);
  return Object.freeze({
    canarySha: parseRef(canary, CANARY_REF, "canary ref"),
    lifecycleRuleset: parseRuleset(lifecycleRuleset, {
      id: canaryApplicable.lifecycleRulesetId,
      kind: "lifecycle",
      name: "Immutable website-production lifecycle",
    }),
    mainSha: parseRef(main, MAIN_REF, "main ref"),
    productionSha: parseRef(production, PRODUCTION_REF, "production ref"),
    serverDate: server.serverDate,
    updateRuleset: parseRuleset(updateRuleset, {
      id: canaryApplicable.updateRulesetId,
      kind: "update",
      name: "Wrench release App update exception",
    }),
  });
}

function canonicalSnapshot(value) {
  return Object.freeze({
    canarySha: value.canarySha,
    lifecycleRuleset: value.lifecycleRuleset,
    mainSha: value.mainSha,
    productionSha: value.productionSha,
    updateRuleset: value.updateRuleset,
  });
}

function assertSnapshotEqual(actual, expected, label) {
  if (canonicalJson(canonicalSnapshot(actual)) !== canonicalJson(canonicalSnapshot(expected))) {
    fail(`${label} control snapshot drifted`);
  }
}

function parsePreflightReceipt(value) {
  const receipt = expectRecord(value, "canary preflight receipt");
  expectExactKeys(
    receipt,
    [
      "actorId",
      "canarySha",
      "lifecycleRuleset",
      "productionSha",
      "runId",
      "schema",
      "serverDate",
      "startSha",
      "targetSha",
      "updateRuleset",
      "workflowId",
      "workflowSha",
    ],
    "canary preflight receipt",
  );
  if (receipt.schema !== "wrench-release-app-canary-preflight/v1") {
    fail("canary preflight receipt schema is unsupported");
  }
  const lifecycleRuleset = expectRecord(receipt.lifecycleRuleset, "receipt lifecycle ruleset");
  const updateRuleset = expectRecord(receipt.updateRuleset, "receipt update ruleset");
  return Object.freeze({
    actorId: exactPositiveNumber(receipt.actorId, "receipt actor ID"),
    canarySha: exactSha(receipt.canarySha, "receipt canary SHA"),
    lifecycleRuleset,
    productionSha: exactSha(receipt.productionSha, "receipt production SHA"),
    runId: exactPositiveNumber(receipt.runId, "receipt run ID"),
    schema: receipt.schema,
    serverDate: exactSecondTimestamp(receipt.serverDate, "receipt server Date"),
    startSha: exactSha(receipt.startSha, "receipt P"),
    targetSha: exactSha(receipt.targetSha, "receipt C"),
    updateRuleset,
    workflowId: exactPositiveNumber(receipt.workflowId, "receipt workflow ID"),
    workflowSha: exactSha(receipt.workflowSha, "receipt D"),
  });
}

export function encodeCanaryReceipt(value) {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) fail("canary receipt exceeds its bound");
  return Buffer.from(text, "utf8").toString("base64url");
}

export function decodeCanaryReceipt(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(MAX_RECEIPT_BYTES * 4 / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    fail("canary receipt is not one bounded canonical base64url value");
  }
  let bytes;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    fail("canary receipt is not decodable");
  }
  if (bytes.toString("base64url") !== value || bytes.byteLength > MAX_RECEIPT_BYTES) {
    fail("canary receipt is not canonical or exceeds its bound");
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("canary receipt is not bounded UTF-8 JSON");
  }
  return parsePreflightReceipt(parsed);
}

export async function preflightCanary(options) {
  const invocation = parseCanaryInvocation(options.environment);
  const coordinate = assertCanaryGitTopology({
    coordinate: options.coordinate,
    cwd: options.cwd,
    spawnImplementation: options.spawnImplementation,
    workflowSha: invocation.workflowSha,
  });
  const workflowId = await assertSingleCanaryRun(options.api, invocation);
  const snapshot = await readControlSnapshot(options.api);
  if (snapshot.mainSha !== coordinate.workflowSha || snapshot.canarySha !== coordinate.startSha) {
    fail("preflight main D or persistent canary P is not exact");
  }
  return Object.freeze({
    actorId: invocation.actorId,
    canarySha: snapshot.canarySha,
    lifecycleRuleset: snapshot.lifecycleRuleset,
    productionSha: snapshot.productionSha,
    runId: invocation.runId,
    schema: "wrench-release-app-canary-preflight/v1",
    serverDate: snapshot.serverDate,
    startSha: coordinate.startSha,
    targetSha: coordinate.targetSha,
    updateRuleset: snapshot.updateRuleset,
    workflowId,
    workflowSha: coordinate.workflowSha,
  });
}

export function canaryPushArguments(expectedOldSha, targetSha) {
  const expectedOld = exactSha(expectedOldSha, "expected canary SHA");
  const target = exactSha(targetSha, "target canary SHA");
  if (expectedOld === target) fail("canary is already exact");
  return Object.freeze([
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
    `--force-with-lease=${CANARY_REF}:${expectedOld}`,
    "--no-follow-tags",
    "--no-tags",
    "--no-signed",
    "--no-verify",
    "--recurse-submodules=no",
    FIXED_REMOTE,
    `${target}:${CANARY_REF}`,
  ]);
}

function runCanaryPush(spawnImplementation, arguments_, environment, token) {
  return spawnImplementation(GIT_EXECUTABLE, arguments_, {
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MILLISECONDS,
  });
}

export function advanceCanaryRef(options) {
  const token = expectString(options.token, "release App token");
  if (token.length === 0 || Buffer.byteLength(token, "utf8") > 4096 || /[\0\r\n]/u.test(token)) {
    fail("release App token is malformed");
  }
  const workflowSha = exactSha(options.workflowSha, "temporary canary workflow SHA D");
  if (workflowSha === options.startSha || workflowSha === options.targetSha) {
    fail("stale-lease target D must be distinct from P and C");
  }
  const arguments_ = canaryPushArguments(options.startSha, options.targetSha);
  const staleArguments = canaryPushArguments(options.startSha, workflowSha);
  const directory = mkdtempSync(join(tmpdir(), "wrench-release-canary-askpass-"));
  const askpassPath = join(directory, "askpass.sh");
  try {
    writeFileSync(askpassPath, ASKPASS, { encoding: "utf8", flag: "wx", mode: 0o700 });
    const environment = gitEnvironment({
      GIT_ASKPASS: askpassPath,
      GIT_ASKPASS_REQUIRE: "force",
      WRENCH_RELEASE_APP_TOKEN: token,
    });
    const first = runCanaryPush(options.spawnImplementation, arguments_, environment, token);
    if (first.error !== undefined || first.status !== 0) {
      const detail = boundedDiagnostic(first.error?.message ?? first.stderr, token);
      fail(`canary leased fast-forward failed${detail.length === 0 ? "" : `: ${detail}`}`);
    }
    const firstOutput = `${boundedDiagnostic(first.stdout, token)}\n${boundedDiagnostic(first.stderr, token)}`;
    if (firstOutput.includes("[up to date]")) {
      fail("canary leased fast-forward did not perform the P to C update");
    }
    const stale = runCanaryPush(options.spawnImplementation, staleArguments, environment, token);
    if (stale.error !== undefined) {
      const detail = boundedDiagnostic(stale.error.message, token);
      fail(`stale-lease rejection could not start${detail.length === 0 ? "" : `: ${detail}`}`);
    }
    if (stale.status === 0) fail("stale canary lease unexpectedly succeeded");
    const staleOutput = `${boundedDiagnostic(stale.stdout, token)}\n${boundedDiagnostic(stale.stderr, token)}`;
    if (!staleOutput.includes("stale info")) fail("canary lease failed without an exact stale-lease rejection");
    return Object.freeze({
      pushOutputSha256: sha256(firstOutput),
      staleLeaseOutputSha256: sha256(staleOutput),
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
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
        // This rejected response is already unusable.
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

export async function assertRevokedTokenCannotBeReused(token, fetchImplementation = fetch) {
  const response = await fetchImplementation("https://api.github.com/installation/repositories", {
    headers: Object.freeze({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "wrench-release-writer-canary",
      "X-GitHub-Api-Version": "2022-11-28",
    }),
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_REUSE_TIMEOUT_MILLISECONDS),
  });
  if (response.status !== 401 || response.headers.get("location") !== null) {
    fail(`revoked release App token reuse returned HTTP ${String(response.status)}`);
  }
  await readBoundedBytes(response, "revoked token denial response");
}

function assertRulesetConfiguration(snapshot, configuration) {
  if (
    snapshot.lifecycleRuleset.id !== configuration.lifecycleRulesetId ||
    snapshot.lifecycleRuleset.updatedAt !== configuration.lifecycleUpdatedAt ||
    snapshot.updateRuleset.id !== configuration.updateRulesetId ||
    snapshot.updateRuleset.updatedAt !== configuration.updateUpdatedAt
  ) {
    fail("runtime ruleset IDs or updated_at values do not match the privileged fingerprint variables");
  }
}

function parseEvidence(value) {
  const evidence = expectRecord(value, "canary evidence");
  return evidence;
}

export async function proveCanary(options) {
  const invocation = parseCanaryInvocation(options.environment);
  const coordinate = assertCanaryGitTopology({
    coordinate: options.coordinate,
    cwd: options.cwd,
    spawnImplementation: options.spawnImplementation,
    workflowSha: invocation.workflowSha,
  });
  const receipt = decodeCanaryReceipt(options.preflightReceipt);
  if (
    receipt.actorId !== invocation.actorId ||
    receipt.runId !== invocation.runId ||
    receipt.workflowSha !== coordinate.workflowSha ||
    receipt.startSha !== coordinate.startSha ||
    receipt.targetSha !== coordinate.targetSha
  ) {
    fail("preflight receipt does not belong to this exact canary run and coordinate");
  }
  const initialWorkflowId = await assertSingleCanaryRun(options.api, invocation);
  if (receipt.workflowId !== initialWorkflowId) fail("canary workflow identity drifted after preflight");
  const before = await readControlSnapshot(options.api);
  assertSnapshotEqual(before, {
    canarySha: receipt.canarySha,
    lifecycleRuleset: receipt.lifecycleRuleset,
    mainSha: receipt.workflowSha,
    productionSha: receipt.productionSha,
    updateRuleset: receipt.updateRuleset,
  }, "pre-mutation");
  if (before.canarySha !== coordinate.startSha || Date.parse(before.serverDate) < Date.parse(receipt.serverDate)) {
    fail("pre-mutation canary or GitHub server time regressed");
  }
  const rulesetConfiguration = parseRulesetEnvironment(options.environment);
  assertRulesetConfiguration(before, rulesetConfiguration);

  let revokedToken;
  const operation = await options.withToken(options.environment, async (token, app) => {
    if (app.appId !== rulesetConfiguration.appId) fail("release App identity does not match ruleset bypass actor ID");
    revokedToken = token;
    const writeBoundWorkflowId = await assertSingleCanaryRun(options.api, invocation);
    if (writeBoundWorkflowId !== receipt.workflowId) fail("canary workflow identity drifted before write");
    const writeBound = await readControlSnapshot(options.api);
    assertSnapshotEqual(writeBound, before, "immediate pre-write");
    if (Date.parse(writeBound.serverDate) < Date.parse(before.serverDate)) {
      fail("immediate pre-write GitHub server time regressed");
    }
    assertRulesetConfiguration(writeBound, rulesetConfiguration);
    return Object.freeze({
      app,
      ...advanceCanaryRef({
        spawnImplementation: options.spawnImplementation,
        startSha: coordinate.startSha,
        targetSha: coordinate.targetSha,
        token,
        workflowSha: coordinate.workflowSha,
      }),
      writeBoundServerDate: writeBound.serverDate,
    });
  });
  if (revokedToken === undefined) fail("release App token operation did not run");
  try {
    await assertRevokedTokenCannotBeReused(revokedToken, options.fetchImplementation);
  } finally {
    revokedToken = undefined;
  }

  const terminalWorkflowId = await assertSingleCanaryRun(options.api, invocation);
  if (terminalWorkflowId !== receipt.workflowId) fail("canary workflow identity drifted after write");
  const after = await readControlSnapshot(options.api);
  if (
    after.mainSha !== coordinate.workflowSha ||
    after.productionSha !== receipt.productionSha ||
    after.canarySha !== coordinate.targetSha ||
    canonicalJson(after.lifecycleRuleset) !== canonicalJson(before.lifecycleRuleset) ||
    canonicalJson(after.updateRuleset) !== canonicalJson(before.updateRuleset) ||
    Date.parse(after.serverDate) < Date.parse(operation.writeBoundServerDate)
  ) {
    fail("terminal main, production, canary, ruleset, or server-time readback drifted");
  }
  return parseEvidence(Object.freeze({
    actorId: invocation.actorId,
    afterServerDate: after.serverDate,
    app: operation.app,
    beforeServerDate: before.serverDate,
    canaryAfter: after.canarySha,
    canaryBefore: before.canarySha,
    lifecycleRuleset: after.lifecycleRuleset,
    productionSha: after.productionSha,
    pushOutputSha256: operation.pushOutputSha256,
    repositoryId: invocation.repositoryId,
    runId: invocation.runId,
    schema: "wrench-release-app-canary-evidence/v1",
    staleLeaseOutputSha256: operation.staleLeaseOutputSha256,
    updateRuleset: after.updateRuleset,
    workflowId: terminalWorkflowId,
    writeBoundServerDate: operation.writeBoundServerDate,
    workflowSha: coordinate.workflowSha,
  }));
}

class ReadOnlyGitHubApi {
  #environment;

  constructor(environment) {
    this.#environment = Object.freeze(scrubReadOnlyGithubEnvironment(environment));
  }

  #run(arguments_, label) {
    const result = spawnSync(GH_EXECUTABLE, ["api", ...arguments_], {
      encoding: "utf8",
      env: this.#environment,
      maxBuffer: MAX_RESPONSE_BYTES,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: API_TIMEOUT_MILLISECONDS,
    });
    if (result.error !== undefined || result.status !== 0) {
      const detail = boundedDiagnostic(result.error?.message ?? result.stderr);
      fail(`${label} failed${detail.length === 0 ? "" : `: ${detail}`}`);
    }
    if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout, "utf8") > MAX_RESPONSE_BYTES) {
      fail(`${label} exceeded its response bound`);
    }
    return result.stdout;
  }

  async get(endpoint) {
    try {
      return JSON.parse(this.#run([endpoint], `GET ${endpoint}`));
    } catch (error) {
      if (error instanceof SyntaxError) fail(`GET ${endpoint} returned invalid JSON`);
      throw error;
    }
  }

  async getWithServerDate(endpoint) {
    return parseIncludedGitHubResponse(this.#run(["--include", endpoint], `GET with Date ${endpoint}`));
  }
}

function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (typeof output !== "string" || output.length === 0) fail("GITHUB_OUTPUT is unavailable");
  if (!/^[a-z][a-z0-9_]*$/u.test(name) || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail("canary output name or value is malformed");
  }
  appendFileSync(output, `${name}=${value}\n`, { encoding: "utf8" });
}

async function main() {
  const command = process.argv[2];
  const api = new ReadOnlyGitHubApi(process.env);
  if (command === "preflight") {
    const receipt = await preflightCanary({
      api,
      coordinate: fixedCanaryCoordinate,
      cwd: process.cwd(),
      environment: process.env,
      spawnImplementation: spawnSync,
    });
    writeOutput("receipt", encodeCanaryReceipt(receipt));
    return;
  }
  if (command === "prove") {
    const evidence = await proveCanary({
      api,
      coordinate: fixedCanaryCoordinate,
      cwd: process.cwd(),
      environment: process.env,
      fetchImplementation: fetch,
      preflightReceipt: process.env.PREFLIGHT_RECEIPT,
      spawnImplementation: spawnSync,
      withToken: withReleaseAppTokenFromEnvironment,
    });
    const encoded = encodeCanaryReceipt(evidence);
    writeOutput("evidence", encoded);
    process.stdout.write(`CANARY_EVIDENCE=${encoded}\n`);
    return;
  }
  fail("expected preflight or prove command");
}

const invokedPath = process.argv[1];
if (typeof invokedPath === "string" && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  });
}
