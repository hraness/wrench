import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "hraness/wrench";
const REPOSITORY_URL = `https://github.com/${REPOSITORY}.git`;
const MAIN_BRANCH = "main";
const MAIN_REF = `refs/heads/${MAIN_BRANCH}`;
const LOCAL_MAIN_REF = `refs/remotes/origin/${MAIN_BRANCH}`;
const STAGE_MAIN_REF = "refs/wrench-release/stage-main";
const MAXIMUM_SNAPSHOT_BYTES = 64 * 1_024;
const MAXIMUM_SNAPSHOT_ROWS = 500;
const MAXIMUM_GIT_OUTPUT_BYTES = 256 * 1_024;
const GIT_TIMEOUT_MILLISECONDS = 120_000;
const SHA = /^[0-9a-f]{40}$/u;
const STABLE_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const TAG_REF = /^refs\/tags\/(v[A-Za-z0-9][A-Za-z0-9._-]{0,126})$/u;

export type GitCommandResult = Readonly<{
  exitCode: number;
  stderr: Uint8Array;
  stdout: Uint8Array;
}>;

export type GitCommandRunner = (arguments_: readonly string[]) => GitCommandResult;

type RemoteRef = Readonly<{
  oid: string;
  ref: string;
}>;

export type RemoteTagSnapshot = Readonly<{
  canonical: string;
  entries: readonly RemoteRef[];
  requestedTagOid: string;
}>;

export type GovernedRemoteSnapshot = Readonly<{
  canonical: string;
  mainOid: string;
  requestedTagOid: string;
}>;

export type ReleaseRefAuthority = Readonly<{
  mainSha: string;
  sha: string;
  tag: string;
}>;

export type ReleaseRefAuthorityInput = Readonly<{
  expectedReleaseSha?: string;
  mode: "promotion" | "release";
  requestedTag: string;
  runner?: GitCommandRunner;
  workingDirectory?: string;
  workflowSha?: string;
}>;

export type StageSourceAuthorityInput = Readonly<{
  expectedHeadSha: string;
  previousSha?: string;
  runner?: GitCommandRunner;
  workingDirectory?: string;
}>;

export type StageSourceAuthority = Readonly<{
  previousSha?: string;
  sourceSha: string;
}>;

export type RemoteTagAbsenceInput = Readonly<{
  expectedHeadSha?: string;
  runner?: GitCommandRunner;
  tag: string;
  workingDirectory?: string;
}>;

function fail(message: string): never {
  throw new Error(message);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return fail(`${label} is not valid UTF-8.`);
  }
}

function countRows(value: Uint8Array | string): number {
  const input = typeof value === "string" ? bytes(value) : value;
  let rows = 0;
  for (const byte of input) if (byte === 0x0a) rows += 1;
  return rows;
}

function createDefaultGitRunner(workingDirectory: string): GitCommandRunner {
  return (arguments_) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "core.hooksPath=/dev/null",
        ...arguments_,
      ],
      {
        cwd: workingDirectory,
        encoding: "buffer",
        env: {
          ...process.env,
          GIT_ASKPASS: "/bin/false",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          SSH_ASKPASS: "/bin/false",
        },
        maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_TIMEOUT_MILLISECONDS,
      },
    );
    if (result.error !== undefined) {
      return fail("Git command could not complete within its fixed resource bounds.");
    }
    if (result.status === null) return fail("Git command did not report an exit status.");
    return Object.freeze({
      exitCode: result.status,
      stderr: new Uint8Array(result.stderr),
      stdout: new Uint8Array(result.stdout),
    });
  };
}

function command(
  runner: GitCommandRunner,
  arguments_: readonly string[],
  label: string,
): Uint8Array {
  const result = runner(arguments_);
  if (result.exitCode !== 0) fail(`${label} failed closed.`);
  return result.stdout;
}

function stableVersion(tag: string): readonly [bigint, bigint, bigint] | undefined {
  const match = STABLE_TAG.exec(tag);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    return undefined;
  }
  return Object.freeze([BigInt(match[1]), BigInt(match[2]), BigInt(match[3])]);
}

function compareVersions(
  left: readonly [bigint, bigint, bigint],
  right: readonly [bigint, bigint, bigint],
): number {
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) fail("Stable version is incomplete.");
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function validTagRef(ref: string): boolean {
  const name = TAG_REF.exec(ref)?.[1];
  return name !== undefined
    && !name.includes("..")
    && !name.includes("@{")
    && !name.endsWith(".")
    && !name.endsWith(".lock");
}

function parseInventoryRows(
  value: Uint8Array | string,
  label: string,
  allowEmpty = false,
): Readonly<{ canonical: string; entries: readonly RemoteRef[] }> {
  const inputBytes = typeof value === "string" ? bytes(value) : value;
  if (inputBytes.byteLength > MAXIMUM_SNAPSHOT_BYTES) {
    fail(`${label} exceeds its byte bound.`);
  }
  if (inputBytes.byteLength === 0) {
    if (!allowEmpty) fail(`${label} is empty.`);
    return Object.freeze({ canonical: "", entries: Object.freeze([]) });
  }
  const input = typeof value === "string" ? value : decode(value, label);
  if (input.includes("\0") || input.includes("\r") || !input.endsWith("\n")) {
    fail(`${label} is not canonical line-oriented output.`);
  }
  const lines = input.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.length > MAXIMUM_SNAPSHOT_ROWS || lines.some((line) => line === "")) {
    fail(`${label} has an invalid row count.`);
  }

  const entries: RemoteRef[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== 2) fail(`${label} row is malformed.`);
    const [oid, ref] = fields;
    if (oid === undefined || ref === undefined || !SHA.test(oid)) {
      fail(`${label} row has a malformed object ID.`);
    }
    if (seen.has(ref)) fail(`${label} contains duplicate ref ${ref}.`);
    seen.add(ref);
    entries.push(Object.freeze({ oid, ref }));
  }
  const canonical = entries
    .toSorted((left, right) => left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0)
    .map((entry) => `${entry.oid}\t${entry.ref}\n`)
    .join("");
  if (canonical !== input) fail(`${label} is not in canonical ref order.`);
  return Object.freeze({ canonical, entries: Object.freeze(entries) });
}

export function parseRemoteMainSnapshot(value: Uint8Array | string): string {
  const parsed = parseInventoryRows(value, "Remote main-ref inventory");
  if (parsed.entries.length !== 1 || parsed.entries[0]?.ref !== MAIN_REF) {
    fail(`Remote main-ref inventory must contain exactly ${MAIN_REF}.`);
  }
  const oid = parsed.entries[0].oid;
  if (!SHA.test(oid)) fail("Remote main-ref inventory has no exact commit.");
  return oid;
}

export function parseRemoteTagSnapshot(
  value: Uint8Array | string,
  requestedTag: string,
): RemoteTagSnapshot {
  if (stableVersion(requestedTag) === undefined) {
    fail("Requested release tag is not one canonical stable version.");
  }
  const parsed = parseInventoryRows(value, "Remote tag inventory");
  for (const entry of parsed.entries) {
    if (!validTagRef(entry.ref)) fail(`Remote tag inventory contains unexpected ref ${entry.ref}.`);
  }
  const requestedTagOid = parsed.entries.find(
    (entry) => entry.ref === `refs/tags/${requestedTag}`,
  )?.oid;
  if (requestedTagOid === undefined) {
    fail(`Remote tag inventory is missing refs/tags/${requestedTag}.`);
  }

  let newestTag: string | undefined;
  let newestVersion: readonly [bigint, bigint, bigint] | undefined;
  for (const entry of parsed.entries) {
    const tag = entry.ref.slice("refs/tags/".length);
    const version = stableVersion(tag);
    if (version === undefined) continue;
    if (newestVersion === undefined || compareVersions(version, newestVersion) > 0) {
      newestTag = tag;
      newestVersion = version;
    }
  }
  if (newestTag !== requestedTag) {
    fail(`Requested release tag is not the newest advertised stable tag (${newestTag ?? "none"}).`);
  }
  return Object.freeze({
    canonical: parsed.canonical,
    entries: parsed.entries,
    requestedTagOid,
  });
}

export function parseGovernedRemoteSnapshot(
  mainValue: Uint8Array | string,
  tagValue: Uint8Array | string,
  requestedTag: string,
): GovernedRemoteSnapshot {
  const mainBytes = typeof mainValue === "string" ? bytes(mainValue) : mainValue;
  const tagBytes = typeof tagValue === "string" ? bytes(tagValue) : tagValue;
  if (mainBytes.byteLength + tagBytes.byteLength > MAXIMUM_SNAPSHOT_BYTES) {
    fail("Combined governed remote ref inventory exceeds its byte bound.");
  }
  if (countRows(mainValue) + countRows(tagValue) > MAXIMUM_SNAPSHOT_ROWS) {
    fail("Combined governed remote ref inventory exceeds its row bound.");
  }
  const mainOid = parseRemoteMainSnapshot(mainValue);
  const tags = parseRemoteTagSnapshot(tagValue, requestedTag);
  return Object.freeze({
    canonical: `${typeof mainValue === "string" ? mainValue : decode(mainValue, "Remote main-ref inventory")}${tags.canonical}`,
    mainOid,
    requestedTagOid: tags.requestedTagOid,
  });
}

function readReleaseSnapshot(
  runner: GitCommandRunner,
  requestedTag: string,
): GovernedRemoteSnapshot {
  const main = command(
    runner,
    ["ls-remote", "--refs", REPOSITORY_URL, MAIN_REF],
    "Remote main-ref inventory",
  );
  const tags = command(
    runner,
    ["ls-remote", "--refs", "--tags", REPOSITORY_URL, "refs/tags/v*"],
    "Remote tag inventory",
  );
  return parseGovernedRemoteSnapshot(main, tags, requestedTag);
}

function readMainSnapshot(runner: GitCommandRunner): Readonly<{ canonical: string; oid: string }> {
  const value = command(
    runner,
    ["ls-remote", "--refs", REPOSITORY_URL, MAIN_REF],
    "Remote main-ref inventory",
  );
  return Object.freeze({
    canonical: decode(value, "Remote main-ref inventory"),
    oid: parseRemoteMainSnapshot(value),
  });
}

function removeStaleFetchHead(runner: GitCommandRunner): string {
  const gitDirectory = decode(command(
    runner,
    ["rev-parse", "--absolute-git-dir"],
    "Git directory identity",
  ), "Git directory identity").trim();
  const fetchHead = decode(command(
    runner,
    ["rev-parse", "--git-path", "FETCH_HEAD"],
    "FETCH_HEAD path identity",
  ), "FETCH_HEAD path identity").trim();
  if (gitDirectory === "" || fetchHead === "") fail("Git administrative paths are empty.");
  const expected = join(resolve(gitDirectory), "FETCH_HEAD");
  const actual = fetchHead.startsWith("/") ? resolve(fetchHead) : expected;
  if (!fetchHead.startsWith("/") && fetchHead !== ".git/FETCH_HEAD" && fetchHead !== "FETCH_HEAD") {
    fail("Relative FETCH_HEAD path is not canonical.");
  }
  if (actual !== expected) fail("FETCH_HEAD path escaped the exact Git administrative directory.");
  if (existsSync(actual)) {
    const information = lstatSync(actual);
    if (!information.isFile() || information.isSymbolicLink()) {
      fail("Preexisting FETCH_HEAD is not one removable regular file.");
    }
    unlinkSync(actual);
  }
  if (existsSync(actual)) fail("Preexisting FETCH_HEAD could not be removed.");
  return actual;
}

type LocalRef = Readonly<{
  objectName: string;
  objectType: string;
  peeledName: string;
  peeledType: string;
  ref: string;
}>;

function readLocalRefs(runner: GitCommandRunner): readonly LocalRef[] {
  const value = decode(command(
    runner,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
    ],
    "Local ref inventory",
  ), "Local ref inventory");
  if (value === "") return Object.freeze([]);
  if (value.includes("\r") || !value.endsWith("\n")) fail("Local ref inventory is malformed.");
  return Object.freeze(value.slice(0, -1).split("\n").map((line) => {
    const [ref, objectName, objectType, peeledName, peeledType, ...extra] = line.split("\0");
    if (
      extra.length > 0
      || ref === undefined
      || objectName === undefined
      || objectType === undefined
      || peeledName === undefined
      || peeledType === undefined
      || ref === ""
      || !SHA.test(objectName)
    ) fail("Local ref inventory record is incomplete.");
    return Object.freeze({ objectName, objectType, peeledName, peeledType, ref });
  }));
}

function expectExactLocalRefs(
  runner: GitCommandRunner,
  expected: readonly string[],
  label: string,
): readonly LocalRef[] {
  const refs = readLocalRefs(runner);
  const names = refs.map((entry) => entry.ref);
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    fail(`${label} does not contain the exact governed ref set.`);
  }
  return refs;
}

function checkedHead(runner: GitCommandRunner): string {
  const head = decode(command(
    runner,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "Checked-out workflow source identity",
  ), "Checked-out workflow source identity").trim();
  if (!SHA.test(head)) fail("Checked-out workflow source identity is malformed.");
  return head;
}

export function verifyReleaseRefAuthority(input: ReleaseRefAuthorityInput): ReleaseRefAuthority {
  if (stableVersion(input.requestedTag) === undefined) {
    fail("Requested release tag is not one canonical stable version.");
  }
  if (input.mode === "release") {
    if (input.workflowSha !== undefined || input.expectedReleaseSha !== undefined) {
      fail("Release authority received unexpected promotion coordinates.");
    }
  } else {
    if (input.workflowSha === undefined || !SHA.test(input.workflowSha)) {
      fail("Promotion authority requires one exact current-main workflow SHA.");
    }
    if (input.expectedReleaseSha !== undefined && !SHA.test(input.expectedReleaseSha)) {
      fail("Promotion authority received a malformed upstream release SHA.");
    }
  }

  const runner = input.runner ?? createDefaultGitRunner(resolve(input.workingDirectory ?? process.cwd()));
  const first = readReleaseSnapshot(runner, input.requestedTag);
  const localTagRef = `refs/tags/${input.requestedTag}`;
  expectExactLocalRefs(
    runner,
    input.mode === "release" ? [localTagRef] : [],
    "Local release-ref preflight",
  );
  const fetchHead = removeStaleFetchHead(runner);
  const shallow = decode(command(
    runner,
    ["rev-parse", "--is-shallow-repository"],
    "Repository shallow-state check",
  ), "Repository shallow-state check").trim();
  if (shallow !== "true" && shallow !== "false") fail("Repository shallow-state check was not exact.");
  command(
    runner,
    [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      ...(shallow === "true" ? ["--unshallow"] : []),
      REPOSITORY_URL,
      `${MAIN_REF}:${LOCAL_MAIN_REF}`,
      `${localTagRef}:${localTagRef}`,
    ],
    "Exact governed release-ref import",
  );
  if (existsSync(fetchHead)) fail("Exact governed import wrote forbidden FETCH_HEAD state.");

  const refs = expectExactLocalRefs(
    runner,
    [LOCAL_MAIN_REF, localTagRef],
    "Local release-ref post-import inventory",
  );
  const main = refs[0];
  const tag = refs[1];
  if (
    main === undefined
    || main.objectType !== "commit"
    || main.objectName !== first.mainOid
    || main.peeledName !== ""
    || main.peeledType !== ""
  ) fail("Imported main ref does not match the advertised exact commit.");
  if (
    tag === undefined
    || tag.objectType !== "commit"
    || tag.objectName !== first.requestedTagOid
    || tag.peeledName !== ""
    || tag.peeledType !== ""
  ) fail("Imported requested ref is not the advertised lightweight commit tag.");

  const head = checkedHead(runner);
  if (input.mode === "release") {
    if (head !== tag.objectName || main.objectName !== tag.objectName) {
      fail("Release tag, checkout, and exact advertised main must name one commit.");
    }
  } else {
    if (head !== first.mainOid || input.workflowSha !== head) {
      fail("Promotion helper is not executing from the exact advertised current main.");
    }
    if (input.expectedReleaseSha !== undefined && input.expectedReleaseSha !== tag.objectName) {
      fail("Successful Release run and lightweight tag target different commits.");
    }
    if (runner(["merge-base", "--is-ancestor", tag.objectName, LOCAL_MAIN_REF]).exitCode !== 0) {
      fail("Verified release commit is not an ancestor of exact advertised main.");
    }
  }

  const second = readReleaseSnapshot(runner, input.requestedTag);
  if (second.canonical !== first.canonical) {
    fail("Remote release-ref inventory changed during verification.");
  }
  return Object.freeze({ mainSha: first.mainOid, sha: tag.objectName, tag: input.requestedTag });
}

export function verifyStageSourceAuthority(
  input: StageSourceAuthorityInput,
): StageSourceAuthority {
  if (!SHA.test(input.expectedHeadSha)) fail("Staging authority requires one exact head commit.");
  if (
    input.previousSha !== undefined
    && (!SHA.test(input.previousSha)
      || input.previousSha === "0".repeat(40)
      || input.previousSha === input.expectedHeadSha)
  ) fail("Staging authority received an invalid prior main commit.");

  const runner = input.runner ?? createDefaultGitRunner(resolve(input.workingDirectory ?? process.cwd()));
  const first = readMainSnapshot(runner);
  if (first.oid !== input.expectedHeadSha) {
    fail(`Staging source is not exact advertised ${MAIN_BRANCH} head.`);
  }
  expectExactLocalRefs(runner, [], "Local staging-ref preflight");
  const fetchHead = removeStaleFetchHead(runner);
  if (checkedHead(runner) !== input.expectedHeadSha) {
    fail("Checked-out staging source does not match the exact advertised main commit.");
  }

  if (input.previousSha !== undefined) {
    const shallow = decode(command(
      runner,
      ["rev-parse", "--is-shallow-repository"],
      "Repository shallow-state check",
    ), "Repository shallow-state check").trim();
    if (shallow !== "true" && shallow !== "false") {
      fail("Repository shallow-state check was not exact.");
    }
    command(
      runner,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        ...(shallow === "true" ? ["--unshallow"] : []),
        REPOSITORY_URL,
        `${MAIN_REF}:${STAGE_MAIN_REF}`,
      ],
      "Exact governed main-history import",
    );
    if (existsSync(fetchHead)) fail("Exact governed main-history import wrote forbidden FETCH_HEAD state.");
    const importedMain = expectExactLocalRefs(
      runner,
      [STAGE_MAIN_REF],
      "Local staging-ref import",
    )[0];
    if (
      importedMain === undefined
      || importedMain.objectType !== "commit"
      || importedMain.objectName !== input.expectedHeadSha
      || importedMain.peeledName !== ""
      || importedMain.peeledType !== ""
    ) fail("Imported governed main ref is not the exact advertised head commit.");
    if (runner(["cat-file", "-e", `${input.previousSha}^{commit}`]).exitCode !== 0) {
      fail("Prior push tip is not available in exact governed main history.");
    }
    if (runner(["merge-base", "--is-ancestor", input.previousSha, STAGE_MAIN_REF]).exitCode !== 0) {
      fail("Prior push tip is not an ancestor of exact advertised main.");
    }
    command(
      runner,
      ["update-ref", "-d", STAGE_MAIN_REF, input.expectedHeadSha],
      "Temporary governed main ref cleanup",
    );
    expectExactLocalRefs(runner, [], "Local staging-ref cleanup");
  }

  const second = readMainSnapshot(runner);
  if (second.canonical !== first.canonical) fail("Remote main ref changed during staging verification.");
  return Object.freeze({
    sourceSha: input.expectedHeadSha,
    ...(input.previousSha === undefined ? {} : { previousSha: input.previousSha }),
  });
}

function readExactTagRef(runner: GitCommandRunner, tag: string): string {
  const value = command(
    runner,
    ["ls-remote", "--refs", "--tags", REPOSITORY_URL, `refs/tags/${tag}`],
    "Exact remote tag lookup",
  );
  const parsed = parseInventoryRows(value, "Exact remote tag lookup", true);
  for (const entry of parsed.entries) {
    if (entry.ref !== `refs/tags/${tag}`) fail("Exact remote tag lookup returned an unexpected ref.");
  }
  return parsed.canonical;
}

export function assertRemoteTagAbsent(
  input: RemoteTagAbsenceInput,
): Readonly<{ mainSha: string; tag: string }> {
  if (stableVersion(input.tag) === undefined) fail("Absent tag check requires one canonical stable version.");
  if (input.expectedHeadSha !== undefined && !SHA.test(input.expectedHeadSha)) {
    fail("Absent tag check received a malformed expected main commit.");
  }
  const runner = input.runner ?? createDefaultGitRunner(resolve(input.workingDirectory ?? process.cwd()));
  const firstMain = readMainSnapshot(runner);
  if (input.expectedHeadSha !== undefined && firstMain.oid !== input.expectedHeadSha) {
    fail("Absent tag check does not match exact advertised main.");
  }
  const firstTag = readExactTagRef(runner, input.tag);
  if (firstTag !== "") fail(`Remote tag ${input.tag} already exists.`);
  const secondMain = readMainSnapshot(runner);
  const secondTag = readExactTagRef(runner, input.tag);
  if (firstMain.canonical !== secondMain.canonical || firstTag !== secondTag) {
    fail("Remote main or tag state changed during absence verification.");
  }
  return Object.freeze({ mainSha: firstMain.oid, tag: input.tag });
}

function assertWorkflowIdentity(): void {
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.DEFAULT_BRANCH !== MAIN_BRANCH) {
    fail(`Release-ref authority must run for ${REPOSITORY} on exact default branch ${MAIN_BRANCH}.`);
  }
}

function main(): void {
  assertWorkflowIdentity();
  const [mode, first, second, third, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || mode === undefined || first === undefined) {
    fail("Unsupported release-ref authority invocation.");
  }
  if (mode === "release") {
    if (second !== undefined || third !== undefined) fail("Usage: release-ref-authority.ts release TAG");
    const authority = verifyReleaseRefAuthority({ mode, requestedTag: first });
    process.stdout.write(`sha=${authority.sha}\ntag=${authority.tag}\nmain_sha=${authority.mainSha}\n`);
    return;
  }
  if (mode === "promotion") {
    if (second === undefined) {
      fail("Usage: release-ref-authority.ts promotion TAG WORKFLOW_SHA [EXPECTED_RELEASE_SHA]");
    }
    const authority = verifyReleaseRefAuthority({
      mode,
      requestedTag: first,
      workflowSha: second,
      ...(third === undefined || third === "" ? {} : { expectedReleaseSha: third }),
    });
    process.stdout.write(`sha=${authority.sha}\ntag=${authority.tag}\nmain_sha=${authority.mainSha}\n`);
    return;
  }
  if (mode === "stage-current") {
    if (second !== undefined || third !== undefined) {
      fail("Usage: release-ref-authority.ts stage-current EXPECTED_HEAD_SHA");
    }
    const authority = verifyStageSourceAuthority({ expectedHeadSha: first });
    process.stdout.write(`source_sha=${authority.sourceSha}\n`);
    return;
  }
  if (mode === "stage-push") {
    if (second === undefined || third !== undefined) {
      fail("Usage: release-ref-authority.ts stage-push EXPECTED_HEAD_SHA PREVIOUS_SHA");
    }
    const authority = verifyStageSourceAuthority({ expectedHeadSha: first, previousSha: second });
    process.stdout.write(`source_sha=${authority.sourceSha}\nprevious_sha=${authority.previousSha ?? ""}\n`);
    return;
  }
  if (mode === "tag-absent") {
    if (third !== undefined) fail("Usage: release-ref-authority.ts tag-absent TAG [EXPECTED_HEAD_SHA]");
    const authority = assertRemoteTagAbsent({
      tag: first,
      ...(second === undefined || second === "" ? {} : { expectedHeadSha: second }),
    });
    process.stdout.write(`tag=${authority.tag}\nmain_sha=${authority.mainSha}\n`);
    return;
  }
  fail("Unsupported release-ref authority mode.");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
