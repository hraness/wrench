import { describe, expect, test } from "bun:test";

import {
  collectBoundedChildOutput,
  fetchPublicJson,
  loadProductionReleaseEvidence,
  parseGithubTagCommit,
  parseProductionReleaseIdentity,
  readBoundedJsonResponse,
  readBoundedStream,
  verifyProductionRelease,
  verifyProductionReleaseEvidence,
  type BoundedChildProcess,
  type ProductionReleaseEvidence,
} from "./production-release-verifier";

const packageValue = Object.freeze({
  name: "@hraness/wrench",
  version: "0.16.2",
});
const headSha = "1234567890abcdef1234567890abcdef12345678";
const packageIntegrity = `sha512-${"A".repeat(86)}==`;

function streamFrom(
  chunks: readonly Uint8Array[],
  onCancel: () => void = () => {},
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    cancel: onCancel,
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

function validEvidence(): ProductionReleaseEvidence {
  const githubRelease = {
    draft: false,
    id: 162,
    immutable: true,
    prerelease: false,
    tag_name: "v0.16.2",
  };
  return {
    githubRelease,
    githubTagCommit: { sha: headSha },
    headSha,
    latestGithubRelease: { ...githubRelease },
    npmManifest: {
      dist: { integrity: packageIntegrity },
      name: "@hraness/wrench",
      version: "0.16.2",
    },
  };
}

describe("production website release verification", () => {
  test("parses the package version into one exact release tag", () => {
    expect(parseProductionReleaseIdentity(packageValue)).toEqual({
      name: "@hraness/wrench",
      tag: "v0.16.2",
      version: "0.16.2",
    });
    expect(() => parseProductionReleaseIdentity({ ...packageValue, version: "0.16.2-rc.1" }))
      .toThrow("stable semantic version");
    expect(() => parseProductionReleaseIdentity({ ...packageValue, name: "wrench" }))
      .toThrow("must name @hraness/wrench");
  });

  test("streams bytes up to the exact bound and cancels before oversize accumulation", async () => {
    const encoder = new TextEncoder();
    expect(new TextDecoder().decode(
      await readBoundedStream(
        streamFrom([encoder.encode("abc"), encoder.encode("def")]),
        6,
        "fixture",
      ),
    )).toBe("abcdef");

    let cancelled = false;
    await expect(readBoundedStream(
      streamFrom(
        [encoder.encode("1234"), encoder.encode("5678")],
        () => { cancelled = true; },
      ),
      7,
      "oversize fixture",
    )).rejects.toThrow("exceeded 7 bytes");
    expect(cancelled).toBe(true);
  });

  test("streams and bounds JSON responses instead of buffering them implicitly", async () => {
    const encoder = new TextEncoder();
    const parsed = await readBoundedJsonResponse(
      new Response(streamFrom([encoder.encode('{"ok":'), encoder.encode("true}")])),
      11,
      "JSON fixture",
    );
    expect(parsed).toEqual({ ok: true });

    let cancelled = false;
    await expect(readBoundedJsonResponse(
      new Response(streamFrom(
        [encoder.encode('{"large":"'), encoder.encode("xxxxxxxxxxxxxxxx\"}")],
        () => { cancelled = true; },
      )),
      16,
      "oversize JSON fixture",
    )).rejects.toThrow("exceeded 16 bytes");
    expect(cancelled).toBe(true);

    let contentLengthCancelled = false;
    await expect(readBoundedJsonResponse(
      new Response(
        streamFrom([encoder.encode('{"ok":true}')], () => {
          contentLengthCancelled = true;
        }),
        { headers: { "Content-Length": "17" } },
      ),
      16,
      "declared oversize fixture",
    )).rejects.toThrow("exceeded 16 bytes");
    expect(contentLengthCancelled).toBe(true);
  });

  test("aborts a public JSON read at its fixed deadline", async () => {
    await expect(fetchPublicJson(
      "https://api.github.com/example",
      "timeout fixture",
      async (_url, init) => {
        const signal = init.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("timeout fixture has no AbortSignal");
        }
        return new Promise<Response>((_resolve, reject) => {
          const rejectFromAbort = () => { reject(signal.reason); };
          if (signal.aborted) rejectFromAbort();
          else signal.addEventListener("abort", rejectFromAbort, { once: true });
        });
      },
      1,
    )).rejects.toHaveProperty("name", "TimeoutError");
  });

  test("kills a child when streamed command output crosses its bound", async () => {
    const encoder = new TextEncoder();
    let killed = false;
    const child: BoundedChildProcess = {
      exited: Promise.resolve(0),
      kill: () => { killed = true; },
      stderr: streamFrom([]),
      stdout: streamFrom([encoder.encode("1234"), encoder.encode("5678")]),
    };
    await expect(collectBoundedChildOutput(child, "git fixture", 7, 7))
      .rejects.toThrow("stdout exceeded 7 bytes");
    expect(killed).toBe(true);

    killed = false;
    await expect(collectBoundedChildOutput({
      exited: Promise.resolve(0),
      kill: () => { killed = true; },
      stderr: streamFrom([encoder.encode("1234"), encoder.encode("5678")]),
      stdout: streamFrom([]),
    }, "git stderr fixture", 7, 7)).rejects.toThrow("stderr exceeded 7 bytes");
    expect(killed).toBe(true);

    await expect(collectBoundedChildOutput({
      exited: Promise.resolve(128),
      kill: () => {},
      stderr: streamFrom([encoder.encode("not a git repository")]),
      stdout: streamFrom([]),
    }, "production HEAD fixture", 64, 64)).rejects.toThrow("exit code 128");
  });

  test("accepts exact HEAD, npm, immutable release, and Latest evidence", async () => {
    expect(verifyProductionReleaseEvidence(packageValue, validEvidence())).toEqual({
      name: "@hraness/wrench",
      tag: "v0.16.2",
      version: "0.16.2",
    });
    expect(parseGithubTagCommit({ sha: headSha, verification: {} })).toBe(headSha);

    let requestedIdentity: unknown;
    await expect(verifyProductionRelease(packageValue, async (identity) => {
      requestedIdentity = identity;
      return validEvidence();
    })).resolves.toEqual(parseProductionReleaseIdentity(packageValue));
    expect(requestedIdentity).toEqual(parseProductionReleaseIdentity(packageValue));
  });

  test("loads the tag commit through bounded GitHub JSON and never invokes remote Git", async () => {
    const identity = parseProductionReleaseIdentity(packageValue);
    const requested: string[] = [];
    const expected = validEvidence();
    await expect(loadProductionReleaseEvidence(identity, {
      fetchJson: async (url) => {
        requested.push(url);
        if (url.includes("/commits/tags/")) return expected.githubTagCommit;
        if (url.includes("registry.npmjs.org")) return expected.npmManifest;
        if (url.endsWith("/releases/latest")) return expected.latestGithubRelease;
        return expected.githubRelease;
      },
      readHeadSha: async () => headSha,
    })).resolves.toEqual(expected);
    expect(requested).toEqual([
      "https://api.github.com/repos/hraness/wrench/commits/tags/v0.16.2",
      "https://registry.npmjs.org/%40hraness%2Fwrench/0.16.2",
      "https://api.github.com/repos/hraness/wrench/releases/tags/v0.16.2",
      "https://api.github.com/repos/hraness/wrench/releases/latest",
    ]);
    const source = await Bun.file(new URL("./production-release-verifier.ts", import.meta.url)).text();
    expect(source).not.toContain("ls-remote");
    expect(source).toContain('["git", "rev-parse", "--verify", "HEAD^{commit}"]');
  });

  test("rejects hostile GitHub tag commit evidence", () => {
    for (const value of [
      null,
      {},
      { sha: headSha.toUpperCase() },
      { sha: headSha.slice(1) },
      { sha: `${headSha}\n` },
    ]) {
      expect(() => parseGithubTagCommit(value)).toThrow();
    }
  });

  test("rejects missing evidence and every release-coordinate mismatch", () => {
    const evidence = validEvidence();
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      latestGithubRelease: undefined,
    })).toThrow("Latest GitHub Release must be an object");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    })).toThrow("is not exact GitHub tag v0.16.2 commit");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      headSha: "",
    })).toThrow("lowercase 40-character commit SHA");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      githubTagCommit: {},
    })).toThrow("must expose one lowercase 40-character commit SHA");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      githubTagCommit: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    })).toThrow("is not exact GitHub tag v0.16.2 commit");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      npmManifest: { ...(evidence.npmManifest as object), version: "0.16.1" },
    })).toThrow("does not contain exact @hraness/wrench@0.16.2");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      npmManifest: {
        ...(evidence.npmManifest as object),
        dist: { integrity: "sha256-YWJjZA==" },
      },
    })).toThrow("SHA-512 package integrity");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      githubRelease: { ...(evidence.githubRelease as object), immutable: false },
    })).toThrow("must be immutable");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      githubRelease: { ...(evidence.githubRelease as object), draft: true },
    })).toThrow("must not be a draft");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      latestGithubRelease: { ...(evidence.latestGithubRelease as object), id: 161 },
    })).toThrow("is not Latest");
    expect(() => verifyProductionReleaseEvidence(packageValue, {
      ...evidence,
      latestGithubRelease: {
        ...(evidence.latestGithubRelease as object),
        tag_name: "v0.16.1",
      },
    })).toThrow("is not Latest");
    const { latestGithubRelease: _missing, ...missingEvidence } = evidence;
    expect(() => verifyProductionReleaseEvidence(packageValue, missingEvidence))
      .toThrow("must contain exactly");
    expect(() => verifyProductionReleaseEvidence(
      { ...packageValue, version: "0.16.3" },
      evidence,
    )).toThrow("does not contain exact @hraness/wrench@0.16.3");
  });
});
