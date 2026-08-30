#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_REPOSITORY = "hraness/wrench";
const PRODUCTION_REF = "refs/heads/website-production";
const FIXED_REMOTE = "https://github.com/hraness/wrench.git";
const GIT_EXECUTABLE = "/usr/bin/git";
const FIXED_PATH = "/usr/bin:/bin";
const SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const MAX_TOKEN_BYTES = 4096;
const MAX_DIAGNOSTIC_BYTES = 4096;
const GIT_TIMEOUT_MILLISECONDS = 60_000;
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

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA.test(value)) fail(`${label} is not one exact lowercase SHA`);
  return value;
}

function exactToken(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    /[\0\r\n]/u.test(value)
  ) {
    fail("WRENCH_RELEASE_APP_TOKEN is missing or malformed");
  }
  return value;
}

function exactStableTag(value) {
  if (typeof value !== "string" || !STABLE_TAG.test(value)) {
    fail("verified release tag is not one stable semantic-version tag");
  }
  return value;
}

function boundedDiagnostic(value, token) {
  if (typeof value !== "string") return "";
  const redacted = value.replaceAll(token, "[redacted]").trim();
  return Buffer.byteLength(redacted, "utf8") <= MAX_DIAGNOSTIC_BYTES
    ? redacted
    : `${Buffer.from(redacted, "utf8").subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8")}…`;
}

export function websiteProductionPushArguments(expectedOldSha, verifiedSha) {
  const expectedOld = exactSha(expectedOldSha, "expected website-production SHA");
  const verified = exactSha(verifiedSha, "verified release SHA");
  if (expectedOld === verified) fail("website-production is already exact");
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
    `--force-with-lease=${PRODUCTION_REF}:${expectedOld}`,
    "--no-follow-tags",
    "--no-tags",
    "--no-signed",
    "--no-verify",
    "--recurse-submodules=no",
    FIXED_REMOTE,
    `${verified}:${PRODUCTION_REF}`,
  ]);
}

export function verifiedReleaseFetchArguments(verifiedTag) {
  const tag = exactStableTag(verifiedTag);
  return Object.freeze([
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
    FIXED_REMOTE,
    `refs/tags/${tag}`,
  ]);
}

function fetchedReleaseVerificationArguments() {
  return Object.freeze([
    "-c",
    "core.hooksPath=/dev/null",
    "rev-parse",
    "--verify",
    "FETCH_HEAD^{commit}",
  ]);
}

function runGit(spawnImplementation, arguments_, environment, label, token) {
  const result = spawnImplementation(GIT_EXECUTABLE, arguments_, {
    encoding: "utf8",
    env: environment,
    maxBuffer: MAX_DIAGNOSTIC_BYTES,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MILLISECONDS,
  });
  if (result.error !== undefined) {
    const detail = boundedDiagnostic(result.error.message, token);
    fail(`${label} could not start${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  if (result.status !== 0) {
    const detail = boundedDiagnostic(result.stderr, token);
    fail(`${label} failed${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  return result;
}

export function advanceWebsiteProductionRef(options) {
  if (options.repository !== EXPECTED_REPOSITORY) {
    fail(`release ref writer is bound to ${EXPECTED_REPOSITORY}`);
  }
  const token = exactToken(options.environment.WRENCH_RELEASE_APP_TOKEN);
  const verifiedSha = exactSha(options.verifiedSha, "verified release SHA");
  const fetchArguments = verifiedReleaseFetchArguments(options.verifiedTag);
  const pushArguments = websiteProductionPushArguments(options.expectedOldSha, verifiedSha);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "wrench-release-askpass-"));
  const askpassPath = join(temporaryDirectory, "askpass.sh");
  try {
    writeFileSync(askpassPath, ASKPASS, { encoding: "utf8", flag: "wx", mode: 0o700 });
    const commonGitEnvironment = Object.freeze({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      PATH: FIXED_PATH,
    });
    const authenticatedGitEnvironment = Object.freeze({
      ...commonGitEnvironment,
      GIT_ASKPASS: askpassPath,
      GIT_ASKPASS_REQUIRE: "force",
      WRENCH_RELEASE_APP_TOKEN: token,
    });
    runGit(
      options.spawnImplementation,
      fetchArguments,
      authenticatedGitEnvironment,
      "verified release tag fetch",
      token,
    );
    const resolved = runGit(
      options.spawnImplementation,
      fetchedReleaseVerificationArguments(),
      commonGitEnvironment,
      "fetched release commit verification",
      token,
    );
    if (resolved.stdout !== `${verifiedSha}\n`) {
      fail("fetched release tag does not peel to the verified release SHA");
    }
    runGit(
      options.spawnImplementation,
      pushArguments,
      authenticatedGitEnvironment,
      "website-production Git push",
      token,
    );
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function advanceWebsiteProductionRefFromEnvironment(input) {
  advanceWebsiteProductionRef({
    environment: input.environment,
    expectedOldSha: input.expectedOldSha,
    repository: input.repository,
    spawnImplementation: spawnSync,
    verifiedSha: input.verifiedSha,
    verifiedTag: input.verifiedTag,
  });
}
