import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRemoteTagAbsent,
  type GitCommandResult,
  type GitCommandRunner,
  parseGovernedRemoteSnapshot,
  parseRemoteMainSnapshot,
  parseRemoteTagSnapshot,
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
}>;

function fixture(options: Readonly<{
  divergent?: boolean;
  higherTagKind?: "annotated" | "lightweight";
  mainAtRelease?: boolean;
  requestedTagKind?: "annotated" | "lightweight";
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
  git(source, ["add", "package.json"]);
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

  if (options.mainAtRelease !== true) {
    for (const value of ["one", "two"] as const) {
      writeFileSync(join(source, `${value}.txt`), `${value}\n`);
      git(source, ["add", `${value}.txt`]);
      git(source, ["commit", "--no-gpg-sign", "-m", value]);
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
  return Object.freeze({ mainSha, previousSha, releaseSha, remote, root, tagObjectSha, work });
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

  test("accepts one exact main and the newest stable tag in canonical order", () => {
    const mainRow = inventory([main, "refs/heads/main"]);
    const tags = inventory(
      [tag, "refs/tags/v1.0.0"],
      [tag, "refs/tags/v1.0.1-rc.1"],
    );
    expect(parseRemoteMainSnapshot(mainRow)).toBe(main);
    expect(parseRemoteTagSnapshot(tags, "v1.0.0").requestedTagOid).toBe(tag);
    expect(parseGovernedRemoteSnapshot(mainRow, tags, "v1.0.0")).toEqual({
      canonical: `${mainRow}${tags}`,
      mainOid: main,
      requestedTagOid: tag,
    });
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
      inventory([tag, "refs/tags/v1.0.1"], [tag, "refs/tags/v1.0.0"]),
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
});

describe("Wrench release and promotion ref authority", () => {
  test("accepts only one lightweight release tag equal to checkout and current main", () => {
    const input = fixture({ mainAtRelease: true });
    checkoutRelease(input);
    const { calls, runner } = runnerFor(input);
    expect(verifyReleaseRefAuthority({
      mode: "release",
      requestedTag: "v1.0.0",
      runner,
      workingDirectory: input.work,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });
    expect(calls.filter((call) => call[0] === "fetch")).toHaveLength(1);
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

  test("accepts a lightweight release ancestor from exact current-main workflow source", () => {
    const input = fixture();
    checkoutMain(input);
    const { runner } = runnerFor(input);
    expect(verifyReleaseRefAuthority({
      expectedReleaseSha: input.releaseSha,
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner,
      workingDirectory: input.work,
      workflowSha: input.mainSha,
    })).toEqual({ mainSha: input.mainSha, sha: input.releaseSha, tag: "v1.0.0" });
  });

  test("rejects annotated requested tags and newer lightweight or annotated stable tags", () => {
    for (const options of [
      { mainAtRelease: true, requestedTagKind: "annotated" as const },
      { higherTagKind: "lightweight" as const },
      { higherTagKind: "annotated" as const },
    ]) {
      const input = fixture(options);
      if (options.mainAtRelease === true) checkoutRelease(input);
      else checkoutMain(input);
      expect(() => verifyReleaseRefAuthority({
        mode: options.mainAtRelease === true ? "release" : "promotion",
        requestedTag: "v1.0.0",
        runner: runnerFor(input).runner,
        workingDirectory: input.work,
        ...(options.mainAtRelease === true ? {} : { workflowSha: input.mainSha }),
      })).toThrow();
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

    const input = fixture();
    checkoutMain(input);
    expect(() => verifyReleaseRefAuthority({
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: runnerFor(input).runner,
      workflowSha: "9".repeat(40),
    })).toThrow("exact advertised current main");

    git(input.work, ["update-ref", "refs/heads/unexpected", input.mainSha]);
    expect(() => verifyReleaseRefAuthority({
      mode: "promotion",
      requestedTag: "v1.0.0",
      runner: runnerFor(input).runner,
      workflowSha: input.mainSha,
    })).toThrow("exact governed ref set");

    const driftInput = fixture();
    checkoutMain(driftInput);
    let mainReads = 0;
    const drift = runnerFor(driftInput, {
      mutateResult: (arguments_, _invocation, result) => {
        if (arguments_[0] === "ls-remote" && arguments_.at(-1) === "refs/heads/main") {
          mainReads += 1;
          if (mainReads === 2) {
            return Object.freeze({
              ...result,
              stdout: new TextEncoder().encode(`${"8".repeat(40)}\trefs/heads/main\n`),
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
  });
});

describe("Wrench staging ref authority", () => {
  test("accepts exact current main and imports a multi-commit push base without FETCH_HEAD", () => {
    const input = fixture();
    checkoutMain(input);
    const currentOnly = runnerFor(input);
    expect(verifyStageSourceAuthority({
      expectedHeadSha: input.mainSha,
      runner: currentOnly.runner,
      workingDirectory: input.work,
    })).toEqual({ sourceSha: input.mainSha });

    const pushed = runnerFor(input);
    expect(verifyStageSourceAuthority({
      expectedHeadSha: input.mainSha,
      previousSha: input.previousSha,
      runner: pushed.runner,
      workingDirectory: input.work,
    })).toEqual({ previousSha: input.previousSha, sourceSha: input.mainSha });
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
    expect(text(input.work, ["for-each-ref", "--format=%(refname)"])).toBe("");
    expect(text(input.work, ["show", `${input.previousSha}:package.json`])).toContain("@hraness/wrench");
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
    })).toThrow("not exact advertised main head");

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

  test("proves exact tag absence with a stable main/tag/main/tag sandwich", () => {
    const input = fixture();
    const success = runnerFor(input);
    expect(assertRemoteTagAbsent({
      expectedHeadSha: input.mainSha,
      runner: success.runner,
      tag: "v1.0.1",
    })).toEqual({ mainSha: input.mainSha, tag: "v1.0.1" });
    expect(success.calls).toEqual([
      ["ls-remote", "--refs", repositoryUrl, "refs/heads/main"],
      ["ls-remote", "--refs", "--tags", repositoryUrl, "refs/tags/v1.0.1"],
      ["ls-remote", "--refs", repositoryUrl, "refs/heads/main"],
      ["ls-remote", "--refs", "--tags", repositoryUrl, "refs/tags/v1.0.1"],
    ]);
    expect(() => assertRemoteTagAbsent({
      runner: runnerFor(input).runner,
      tag: "v1.0.0",
    })).toThrow("already exists");
    expect(() => assertRemoteTagAbsent({
      runner: runnerFor(input).runner,
      tag: "v1.0.1-rc.1",
    })).toThrow("canonical stable version");
  });
});
