import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRemoteTagAbsent,
  type GitCommandResult,
  type GitCommandRunner,
  parseGovernedRemoteSnapshot,
  parseRemoteMainSnapshot,
  parseRemoteTagSnapshot,
  verifyReleasePublicationAuthority,
  verifyReleaseRefAuthority,
  verifyStageSourceAuthority,
} from "./release-ref-authority";

const repositoryUrl = "https://github.com/hraness/wrench.git";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function git(cwd: string, arguments_: readonly string[]): Uint8Array {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "buffer",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
    maxBuffer: 512 * 1_024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
  return new Uint8Array(result.stdout);
}

function text(cwd: string, arguments_: readonly string[]): string {
  return new TextDecoder().decode(git(cwd, arguments_)).trim();
}

function inventory(...rows: readonly (readonly [string, string])[]): string {
  return rows.map(([oid, ref]) => `${oid}\t${ref}\n`).join("");
}

type Fixture = Readonly<{
  mainSha: string;
  previousSha: string;
  releaseSha: string;
  remote: string;
  root: string;
  tagObjectSha: string;
  work: string;
  workflowSha: string;
}>;

function fixture(options: Readonly<{
  divergent?: boolean;
  higherTagKind?: "annotated" | "lightweight";
  mainAtRelease?: boolean;
  releaseControlDrift?: boolean;
  requestedTagKind?: "annotated" | "lightweight";
  workflowDrift?: boolean;
}> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "wrench-release-ref-authority-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, ["init", "--initial-branch=main", source]);
  git(source, ["config", "user.email", "release-ref-authority@example.invalid"]);
  git(source, ["config", "user.name", "Release Ref Authority Fixture"]);
  writeFileSync(join(source, "package.json"), '{"name":"@hraness/wrench","version":"1.0.0"}\n');
  if (options.releaseControlDrift === true) {
    mkdirSync(join(source, "scripts"), { recursive: true });
    writeFileSync(join(source, "scripts", "release-provider-outcome.mjs"), "export const revision = 1;\n");
  }
  git(source, ["add", "."]);
  git(source, ["commit", "--no-gpg-sign", "-m", "release"]);
  const previousSha = text(source, ["rev-parse", "HEAD"]);

  let releaseSha = previousSha;
  if (options.divergent === true) {
    git(source, ["switch", "--create", "release-side"]);
    writeFileSync(join(source, "side.txt"), "side\n");
    git(source, ["add", "side.txt"]);
    git(source, ["commit", "--no-gpg-sign", "-m", "release side"]);
    releaseSha = text(source, ["rev-parse", "HEAD"]);
    git(source, ["switch", "main"]);
  }

  if (options.requestedTagKind === "annotated") {
    git(source, ["tag", "--annotate", "v1.0.0", "--message", "annotated", releaseSha]);
  } else {
    git(source, ["tag", "v1.0.0", releaseSha]);
  }

  let workflowSha = releaseSha;
  if (options.mainAtRelease !== true) {
    for (const value of ["one", "two"] as const) {
      writeFileSync(join(source, `${value}.txt`), `${value}\n`);
      git(source, ["add", `${value}.txt`]);
      if (value === "one" && options.workflowDrift === true) {
        mkdirSync(join(source, ".github", "workflows"), { recursive: true });
        writeFileSync(join(source, ".github", "workflows", "drift.yml"), "name: drift\n");
        git(source, ["add", ".github/workflows/drift.yml"]);
      }
      if (value === "one" && options.releaseControlDrift === true) {
        writeFileSync(join(source, "scripts", "release-provider-outcome.mjs"), "export const revision = 2;\n");
        git(source, ["add", "scripts/release-provider-outcome.mjs"]);
      }
      git(source, ["commit", "--no-gpg-sign", "-m", value]);
      if (value === "one") workflowSha = text(source, ["rev-parse", "HEAD"]);
    }
  }
  const mainSha = text(source, ["rev-parse", "HEAD"]);
  if (options.higherTagKind === "annotated") {
    git(source, ["tag", "--annotate", "v1.0.1", "--message", "higher", mainSha]);
  } else if (options.higherTagKind === "lightweight") {
    git(source, ["tag", "v1.0.1", mainSha]);
  }

  git(root, ["init", "--bare", remote]);
  git(source, ["remote", "add", "fixture-origin", remote]);
  git(source, ["push", "fixture-origin", "refs/heads/main:refs/heads/main"]);
  git(source, ["push", "fixture-origin", "refs/tags/v1.0.0:refs/tags/v1.0.0"]);
  if (options.higherTagKind !== undefined) {
    git(source, ["push", "fixture-origin", "refs/tags/v1.0.1:refs/tags/v1.0.1"]);
  }
  const tagObjectSha = text(source, ["rev-parse", "refs/tags/v1.0.0"]);
  git(root, ["init", work]);
  return Object.freeze({
    mainSha,
    previousSha,
    releaseSha,
    remote,
    root,
    tagObjectSha,
    work,
    workflowSha,
  });
}

function checkoutRelease(input: Fixture): void {
  git(input.work, [
    "fetch",
    "--depth=1",
    "--no-tags",
    input.remote,
    "refs/tags/v1.0.0:refs/tags/v1.0.0",
  ]);
  git(input.work, ["checkout", "--detach", "refs/tags/v1.0.0^{commit}"]);
}

function checkoutMain(input: Fixture): void {
  git(input.work, ["fetch", "--depth=1", "--no-tags", input.remote, input.mainSha]);
  git(input.work, ["checkout", "--detach", "FETCH_HEAD"]);
}

function checkoutSha(input: Fixture, sha: string): void {
  git(input.work, ["fetch", "--depth=1", "--no-tags", input.remote, sha]);
  git(input.work, ["checkout", "--detach", "FETCH_HEAD"]);
}

type RunnerOptions = Readonly<{
  mutateResult?: (
    arguments_: readonly string[],
    invocation: number,
    result: GitCommandResult,
  ) => GitCommandResult;
}>;

function runnerFor(
  input: Fixture,
  options: RunnerOptions = {},
): Readonly<{ calls: readonly (readonly string[])[]; runner: GitCommandRunner }> {
  const calls: (readonly string[])[] = [];
  let invocation = 0;
  return Object.freeze({
    calls,
    runner: (arguments_) => {
      calls.push(Object.freeze([...arguments_]));
      invocation += 1;
      const rewritten = arguments_.map((argument) => argument === repositoryUrl ? input.remote : argument);
      const result = spawnSync("git", rewritten, {
        cwd: input.work,
        encoding: "buffer",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
        maxBuffer: 512 * 1_024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
      const value: GitCommandResult = Object.freeze({
        exitCode: result.status ?? 127,
        stderr: new Uint8Array(result.stderr),
        stdout: new Uint8Array(result.stdout),
      });
      return options.mutateResult?.(arguments_, invocation, value) ?? value;
    },
  });
}

describe("bounded Wrench remote ref inventories", () => {
  const main = "1".repeat(40);
  const tag = "2".repeat(40);

  test("accepts one exact main and binds the requested tag without treating raw tags as releases", () => {
    const mainRow = inventory([main, "refs/heads/main"]);
    const tags = inventory(
      [tag, "refs/tags/v1.0.0"],
      [tag, "refs/tags/v1.0.1-rc.1"],
    );
    expect(parseRemoteMainSnapshot(mainRow)).toBe(main);
    expect(parseRemoteTagSnapshot(tags, "v1.0.0").requestedTagOid).toBe(tag);
    expect(parseGovernedRemoteSnapshot(`${mainRow}${tags}`, "v1.0.0")).toEqual({
      canonical: `${mainRow}${tags}`,
      mainOid: main,
      requestedTagOid: tag,
    });
    const queuedHigherTag = inventory(
      [tag, "refs/tags/v1.0.0"],
      [main, "refs/tags/v1.0.1"],
    );
    expect(parseRemoteTagSnapshot(queuedHigherTag, "v1.0.0").requestedTagOid).toBe(tag);
    expect(parseGovernedRemoteSnapshot(`${mainRow}${queuedHigherTag}`, "v1.0.0").requestedTagOid)
      .toBe(tag);
  });

  test("rejects malformed, duplicate, unexpected, noncanonical, oversized, and stale snapshots", () => {
    for (const value of [
      "",
      inventory([tag, "refs/tags/v0.9.9"]),
      inventory([tag, "refs/tags/v1.0.0"], [tag, "refs/tags/v1.0.0"]),
      `${tag} refs/tags/v1.0.0\n`,
      inventory(["z".repeat(40), "refs/tags/v1.0.0"]),
      inventory([tag, "refs/tags/v1..0.0"]),
      inventory([main, "refs/heads/main"], [tag, "refs/tags/v1.0.0"]),
      inventory([tag, "refs/tags/v1.0.0^{}"]),
      `${tag}\trefs/tags/v1.0.0\r\n`,
      `${tag}\trefs/tags/v1.0.0`,
    ]) expect(() => parseRemoteTagSnapshot(value, "v1.0.0")).toThrow();
    expect(() => parseRemoteTagSnapshot(new Uint8Array([0xff]), "v1.0.0"))
      .toThrow("valid UTF-8");
    for (const value of [
      "",
      inventory([main, "refs/heads/other"]),
      inventory([main, "refs/heads/main"], [main, "refs/heads/main"]),
      inventory(["z".repeat(40), "refs/heads/main"]),
    ]) expect(() => parseRemoteMainSnapshot(value)).toThrow();

    const tooMany = Array.from({ length: 501 }, (_, index) =>
      inventory([tag, `refs/tags/v1.0.0-${String(index).padStart(3, "0")}`])).join("");
    expect(() => parseRemoteTagSnapshot(tooMany, "v1.0.0")).toThrow("row count");
    const tooLarge = `${tag}\trefs/tags/v1.0.0${"x".repeat(65_536)}\n`;
    expect(() => parseRemoteTagSnapshot(tooLarge, "v1.0.0")).toThrow("byte bound");
  });

  test("rejects malformed combined governed-ref advertisements", () => {
    const validMain = inventory([main, "refs/heads/main"]);
    const validTag = inventory([tag, "refs/tags/v1.0.0"]);
    for (const value of [
      "",
      validMain,
      validTag,
      `${validMain}${validMain}${validTag}`,
      `${inventory([main, "refs/heads/main"])}${inventory([tag, "refs/heads/main"])}${validTag}`,
      `${validMain}${validTag}${validTag}`,
      `${validMain}${inventory([main, "refs/heads/unexpected"])}${validTag}`,
      `${validMain}${validTag}${inventory([tag, "refs/tags/release-1.0.0"])}`,
      `${inventory(["a".repeat(39), "refs/heads/main"])}${validTag}`,
      `${inventory(["A".repeat(40), "refs/heads/main"])}${validTag}`,
      `${validMain}${inventory(["z".repeat(40), "refs/tags/v1.0.0"])}`,
      `${main} refs/heads/main\n${validTag}`,
      `${validMain}${tag}\trefs/tags/v1.0.0\r\n`,
      `${validMain}${tag}\trefs/tags/v1.0.0`,
      `${validTag}${validMain}`,
    ]) expect(() => parseGovernedRemoteSnapshot(value, "v1.0.0")).toThrow();
    expect(() => parseGovernedRemoteSnapshot(new Uint8Array([0xff]), "v1.0.0"))
      .toThrow("valid UTF-8");
    expect(() => parseGovernedRemoteSnapshot(
      `${validMain}${validTag}${"x".repeat(65_536)}`,
      "v1.0.0",
    )).toThrow("byte bound");
    const tooMany = `${validMain}${Array.from({ length: 500 }, (_, index) =>
      inventory([tag, `refs/tags/v1.0.0-${String(index).padStart(3, "0")}`])).join("")}`;
    expect(() => parseGovernedRemoteSnapshot(tooMany, "v1.0.0")).toThrow("row count");
  });
});

describe("Wrench release and promotion ref authority", () => {
  test("accepts one lightweight release tag below protected current main", () => {
    const input = fixture();
    checkoutRelease(input);
    const { calls, runner } = runnerFor(input);
    expect(verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner,
      workingDirectory: input.work,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });
    expect(calls.filter((call) => call[0] === "fetch")).toHaveLength(1);
    expect(calls.filter((call) => call[0] === "ls-remote")).toEqual([
      ["ls-remote", "--sort=refname", "--refs", repositoryUrl, "refs/heads/main", "refs/tags/v*"],
      ["ls-remote", "--sort=refname", "--refs", repositoryUrl, "refs/heads/main", "refs/tags/v*"],
    ]);
    const fetch = calls.find((call) => call[0] === "fetch") ?? [];
    expect(fetch).toContain("--no-write-fetch-head");
    expect(fetch).toContain("--no-tags");
    expect(fetch).toContain("--no-recurse-submodules");
    expect(fetch.some((value) => value === "--force" || value.startsWith("+"))).toBe(false);
    expect(fetch).not.toContain("FETCH_HEAD");
    expect(calls.some((call) => call[0] === "rev-parse" && call.at(-1) === "FETCH_HEAD"))
      .toBe(true);
    expect(text(input.work, ["for-each-ref", "--format=%(refname)"])).toBe(
      "refs/remotes/origin/main\nrefs/tags/v1.0.0",
    );
  });

  test("accepts a release below a workflow source below protected current main", () => {
    const input = fixture();
    checkoutSha(input, input.workflowSha);
    const { runner } = runnerFor(input);
    expect(verifyReleaseRefAuthority({
      expectedReleaseSha: input.releaseSha,
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner,
      workingDirectory: input.work,
      workflowSha: input.workflowSha,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });
  });

  test("rejects annotated requested tags without treating later raw tags as completed releases", () => {
    const annotated = fixture({ requestedTagKind: "annotated" });
    checkoutRelease(annotated);
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(annotated).runner,
      workingDirectory: annotated.work,
    })).toThrow("lightweight");

    for (const higherTagKind of ["lightweight", "annotated"] as const) {
      const input = fixture({ higherTagKind });
      checkoutRelease(input);
      expect(verifyReleaseRefAuthority({
        mode: "release",
        requestedTag: "v1.0.0",
        runner: runnerFor(input).runner,
        workingDirectory: input.work,
      })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });
    }
  });

  test("rejects divergence, wrong workflow coordinates, unexpected refs, and remote drift", () => {
    const divergent = fixture({ divergent: true });
    checkoutMain(divergent);
    expect(() => verifyReleaseRefAuthority({
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: runnerFor(divergent).runner,
      workflowSha: divergent.mainSha,
    })).toThrow("not an ancestor");

    const releaseDivergence = fixture({ divergent: true });
    checkoutRelease(releaseDivergence);
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(releaseDivergence).runner,
      workingDirectory: releaseDivergence.work,
    })).toThrow("Verified release commit is not an ancestor of exact advertised main");

    const wrongReleaseCheckout = fixture();
    checkoutRelease(wrongReleaseCheckout);
    checkoutSha(wrongReleaseCheckout, wrongReleaseCheckout.mainSha);
    expect(() => verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner: runnerFor(wrongReleaseCheckout).runner,
      workingDirectory: wrongReleaseCheckout.work,
    })).toThrow("Release tag and checkout must name one commit");

    const workflowDivergence = fixture();
    checkoutSha(workflowDivergence, workflowDivergence.workflowSha);
    const workflowDivergenceRunner = runnerFor(workflowDivergence, {
      mutateResult: (arguments_, _invocation, result) => {
        if (
          arguments_[0] === "merge-base"
          && arguments_[1] === "--is-ancestor"
          && arguments_[2] === workflowDivergence.workflowSha
          && arguments_[3] === "refs/remotes/origin/main"
        ) {
          return Object.freeze({ ...result, exitCode: 1 });
        }
        return result;
      },
    });
    expect(() => verifyReleaseRefAuthority({
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: workflowDivergenceRunner.runner,
      workingDirectory: workflowDivergence.work,
      workflowSha: workflowDivergence.workflowSha,
    })).toThrow("Promotion workflow source is not an ancestor of exact advertised main");

    const input = fixture();
    checkoutMain(input);
    expect(() => verifyReleaseRefAuthority({
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: runnerFor(input).runner,
      workflowSha: "9".repeat(40),
    })).toThrow("exact verified workflow source");

    git(input.work, ["update-ref", "refs/heads/unexpected", input.mainSha]);
    expect(() => verifyReleaseRefAuthority({
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: runnerFor(input).runner,
      workflowSha: input.mainSha,
    })).toThrow("exact governed ref set");

    const driftInput = fixture();
    checkoutMain(driftInput);
    let governedReads = 0;
    const drift = runnerFor(driftInput, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] === "ls-remote" && arguments_.at(-1) === "refs/tags/v*") {
          governedReads += 1;
          if (governedReads === 2) {
            return Object.freeze({
              ...result,
              stdout: new TextEncoder().encode(
                new TextDecoder().decode(result.stdout).replace(
                  driftInput.mainSha,
                  "8".repeat(40),
                ),
              ),
            });
          }
        }
        return result;
      },
    });
    expect(() => verifyReleaseRefAuthority({
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: drift.runner,
      workflowSha: driftInput.mainSha,
    })).toThrow("changed during verification");

    for (const driftOptions of [
      { workflowDrift: true },
      { releaseControlDrift: true },
    ] as const) {
      const releaseControlDrift = fixture(driftOptions);
      checkoutRelease(releaseControlDrift);
      expect(() => verifyReleaseRefAuthority({
        mode: "release",
        requestedTag: "v1.0.0",
        runner: runnerFor(releaseControlDrift).runner,
        workingDirectory: releaseControlDrift.work,
      })).toThrow("different release-control definitions");
    }
  });

  test("binds two combined advertisements immediately before publication", () => {
    const input = fixture();
    checkoutSha(input, input.releaseSha);
    const success = runnerFor(input);
    expect(verifyReleasePublicationAuthority({
      expectedMainSha: input.mainSha,
      expectedReleaseSha: input.releaseSha,
      phase: "prewrite",
      requestedTag: "v1.0.0",
      runner: success.runner,
      workingDirectory: input.work,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });
    expect(success.calls.filter((call) => call[0] === "ls-remote")).toEqual([
      ["ls-remote", "--sort=refname", "--refs", repositoryUrl, "refs/heads/main", "refs/tags/v*"],
      ["ls-remote", "--sort=refname", "--refs", repositoryUrl, "refs/heads/main", "refs/tags/v*"],
    ]);
    expect(success.calls.find((call) => call[0] === "diff")).toEqual([
      "diff",
      "--quiet",
      "--no-ext-diff",
      "--no-textconv",
      input.releaseSha,
      "refs/wrench-release/publication-main",
      "--",
      ".github/workflows",
      "scripts/release-ref-authority.ts",
      "scripts/release-provider-outcome.mjs",
      "scripts/release-app-token.mjs",
      "scripts/release-ref-writer.mjs",
    ]);
  });

  test("rejects an annotated request and a changed terminal advertisement", () => {
    const rejectedInput = fixture({ mainAtRelease: true, requestedTagKind: "annotated" });
    checkoutSha(rejectedInput, rejectedInput.releaseSha);
    expect(() => verifyReleasePublicationAuthority({
      expectedMainSha: rejectedInput.mainSha,
      expectedReleaseSha: rejectedInput.releaseSha,
      phase: "prewrite",
      requestedTag: "v1.0.0",
      runner: runnerFor(rejectedInput).runner,
      workingDirectory: rejectedInput.work,
    })).toThrow();

    const input = fixture();
    checkoutSha(input, input.releaseSha);
    let reads = 0;
    const drift = runnerFor(input, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] === "ls-remote" && arguments_.at(-1) === "refs/tags/v*") {
          reads += 1;
          if (reads === 2) {
            return Object.freeze({
              ...result,
              stdout: new TextEncoder().encode(
                new TextDecoder().decode(result.stdout).replace(input.mainSha, "8".repeat(40)),
              ),
            });
          }
        }
        return result;
      },
    });
    expect(() => verifyReleasePublicationAuthority({
      expectedMainSha: input.mainSha,
      expectedReleaseSha: input.releaseSha,
      phase: "prewrite",
      requestedTag: "v1.0.0",
      runner: drift.runner,
      workingDirectory: input.work,
    })).toThrow("changed at the publication boundary");
  });

  test("treats a higher raw tag as incomplete in both publication phases", () => {
    const supersededRawTag = fixture({ higherTagKind: "lightweight" });
    checkoutSha(supersededRawTag, supersededRawTag.releaseSha);
    for (const phase of ["prewrite", "postwrite"] as const) {
      expect(verifyReleasePublicationAuthority({
        expectedMainSha: supersededRawTag.mainSha,
        expectedReleaseSha: supersededRawTag.releaseSha,
        phase,
        requestedTag: "v1.0.0",
        runner: runnerFor(supersededRawTag).runner,
        workingDirectory: supersededRawTag.work,
      })).toEqual({
        mainSha: supersededRawTag.mainSha,
        sha: supersededRawTag.releaseSha,
        tag: "v1.0.0",
      });
    }
  });

  for (const phase of ["prewrite", "postwrite"] as const) {
    test(`rejects release-control drift at ${phase}`, () => {
      for (const driftOptions of [
        { workflowDrift: true },
        { releaseControlDrift: true },
      ] as const) {
        const releaseControlDrift = fixture(driftOptions);
        checkoutSha(releaseControlDrift, releaseControlDrift.releaseSha);
        expect(() => verifyReleasePublicationAuthority({
          expectedMainSha: releaseControlDrift.mainSha,
          expectedReleaseSha: releaseControlDrift.releaseSha,
          phase,
          requestedTag: "v1.0.0",
          runner: runnerFor(releaseControlDrift).runner,
          workingDirectory: releaseControlDrift.work,
        })).toThrow(`different release-control definitions at ${phase}`);
      }
    });
  }
});

describe("Wrench staging ref authority", () => {
  test("accepts an artifact source at or below protected main and imports history without FETCH_HEAD", () => {
    const input = fixture();
    checkoutMain(input);
    const currentOnly = runnerFor(input);
    expect(verifyStageSourceAuthority({
      expectedHeadSha: input.mainSha,
      runner: currentOnly.runner,
      workingDirectory: input.work,
    })).toEqual({ sourceSha: input.mainSha });

    const pushedInput = fixture();
    checkoutMain(pushedInput);
    const pushed = runnerFor(pushedInput);
    expect(verifyStageSourceAuthority({
      expectedHeadSha: pushedInput.mainSha,
      previousSha: pushedInput.previousSha,
      runner: pushed.runner,
      workingDirectory: pushedInput.work,
    })).toEqual({ previousSha: pushedInput.previousSha, sourceSha: pushedInput.mainSha });
    const fetch = pushed.calls.find((call) => call[0] === "fetch") ?? [];
    expect(fetch).toEqual([
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--unshallow",
      repositoryUrl,
      "refs/heads/main:refs/wrench-release/stage-main",
    ]);
    expect(text(pushedInput.work, ["for-each-ref", "--format=%(refname)"])).toBe("");
    expect(text(pushedInput.work, ["show", `${pushedInput.previousSha}:package.json`])).toContain("@hraness/wrench");

    const advanced = fixture();
    checkoutSha(advanced, advanced.releaseSha);
    expect(verifyStageSourceAuthority({
      expectedHeadSha: advanced.releaseSha,
      runner: runnerFor(advanced).runner,
      workingDirectory: advanced.work,
    })).toEqual({ sourceSha: advanced.releaseSha });

    const divergent = fixture({ divergent: true });
    checkoutSha(divergent, divergent.releaseSha);
    expect(() => verifyStageSourceAuthority({
      expectedHeadSha: divergent.releaseSha,
      runner: runnerFor(divergent).runner,
      workingDirectory: divergent.work,
    })).toThrow("not an ancestor of protected main");
  });

  test("rejects invalid event bases, stale main, hidden refs, and main drift", () => {
    const input = fixture();
    checkoutMain(input);
    for (const previousSha of ["0".repeat(40), input.mainSha, "not-a-sha"]) {
      expect(() => verifyStageSourceAuthority({
        expectedHeadSha: input.mainSha,
        previousSha,
        runner: runnerFor(input).runner,
      })).toThrow("invalid prior main commit");
    }
    expect(() => verifyStageSourceAuthority({
      expectedHeadSha: "9".repeat(40),
      runner: runnerFor(input).runner,
    })).toThrow("does not match the verified artifact source");

    const divergent = fixture({ divergent: true });
    checkoutMain(divergent);
    expect(() => verifyStageSourceAuthority({
      expectedHeadSha: divergent.mainSha,
      previousSha: divergent.releaseSha,
      runner: runnerFor(divergent).runner,
    })).toThrow("not available in exact governed main history");

    git(input.work, ["update-ref", "refs/heads/hidden", input.mainSha]);
    expect(() => verifyStageSourceAuthority({
      expectedHeadSha: input.mainSha,
      runner: runnerFor(input).runner,
    })).toThrow("exact governed ref set");
    git(input.work, ["update-ref", "-d", "refs/heads/hidden"]);

    let mainReads = 0;
    const drift = runnerFor(input, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] === "ls-remote" && arguments_.at(-1) === "refs/heads/main") {
          mainReads += 1;
          if (mainReads === 2) {
            return Object.freeze({
              ...result,
              stdout: new TextEncoder().encode(`${"7".repeat(40)}\trefs/heads/main\n`),
            });
          }
        }
        return result;
      },
    });
    expect(() => verifyStageSourceAuthority({
      expectedHeadSha: input.mainSha,
      runner: drift.runner,
    })).toThrow("changed during staging verification");
  });

  test("proves exact tag absence with two combined governed-ref advertisements", () => {
    const input = fixture();
    checkoutMain(input);
    const success = runnerFor(input);
    expect(assertRemoteTagAbsent({
      expectedHeadSha: input.mainSha,
      runner: success.runner,
      tag: "v1.0.1",
    })).toEqual({ mainSha: input.mainSha, tag: "v1.0.1" });
    expect(success.calls).toEqual([
      ["ls-remote", "--sort=refname", "--refs", repositoryUrl, "refs/heads/main", "refs/tags/v1.0.1"],
      ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)"],
      ["rev-parse", "--absolute-git-dir"],
      ["rev-parse", "--git-path", "FETCH_HEAD"],
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["rev-parse", "--is-shallow-repository"],
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--unshallow",
        repositoryUrl,
        "refs/heads/main:refs/wrench-release/stage-main",
      ],
      ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)"],
      ["merge-base", "--is-ancestor", input.mainSha, "refs/wrench-release/stage-main"],
      ["update-ref", "-d", "refs/wrench-release/stage-main", input.mainSha],
      ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)"],
      ["ls-remote", "--sort=refname", "--refs", repositoryUrl, "refs/heads/main", "refs/tags/v1.0.1"],
    ]);
    expect(() => assertRemoteTagAbsent({
      runner: runnerFor(input).runner,
      tag: "v1.0.0",
    })).toThrow("already exists");
    expect(() => assertRemoteTagAbsent({
      runner: runnerFor(input).runner,
      tag: "v1.0.1-rc.1",
    })).toThrow("canonical stable version");

    let reads = 0;
    const drift = runnerFor(input, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] === "ls-remote" && arguments_.at(-1) === "refs/tags/v1.0.1") {
          reads += 1;
          if (reads === 2) {
            return Object.freeze({
              ...result,
              stdout: new TextEncoder().encode(`${"8".repeat(40)}\trefs/heads/main\n`),
            });
          }
        }
        return result;
      },
    });
    expect(() => assertRemoteTagAbsent({
      expectedHeadSha: input.mainSha,
      runner: drift.runner,
      tag: "v1.0.1",
    })).toThrow("changed during absence verification");
  });
});
