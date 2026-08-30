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
const MAX_TOKEN_BYTES = 4096;
const MAX_DIAGNOSTIC_BYTES = 4096;
const PUSH_TIMEOUT_MILLISECONDS = 60_000;
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

export function advanceWebsiteProductionRef(options) {
  if (options.repository !== EXPECTED_REPOSITORY) {
    fail(`release ref writer is bound to ${EXPECTED_REPOSITORY}`);
  }
  const token = exactToken(options.environment.WRENCH_RELEASE_APP_TOKEN);
  const arguments_ = websiteProductionPushArguments(options.expectedOldSha, options.verifiedSha);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "wrench-release-askpass-"));
  const askpassPath = join(temporaryDirectory, "askpass.sh");
  try {
    writeFileSync(askpassPath, ASKPASS, { encoding: "utf8", flag: "wx", mode: 0o700 });
    const result = options.spawnImplementation(GIT_EXECUTABLE, arguments_, {
      encoding: "utf8",
      env: {
        GIT_ASKPASS: askpassPath,
        GIT_ASKPASS_REQUIRE: "force",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        PATH: FIXED_PATH,
        WRENCH_RELEASE_APP_TOKEN: token,
      },
      maxBuffer: MAX_DIAGNOSTIC_BYTES,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PUSH_TIMEOUT_MILLISECONDS,
    });
    if (result.error !== undefined) {
      fail(`website-production Git push could not start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = boundedDiagnostic(result.stderr, token);
      fail(`website-production Git push failed${detail.length === 0 ? "" : `: ${detail}`}`);
    }
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
  });
}
