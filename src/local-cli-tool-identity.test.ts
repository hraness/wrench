import { describe, expect, test } from "bun:test";

import { assertProperty, fc } from "./test-support";
import { parseLocalCliContractIdentityV1 } from "./local-cli-contracts";
import { parseLocalCliToolIdentityV1 } from "./local-cli-tool-identity";

const digest = (character: string): string => character.repeat(64);

function tool(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "example-cli",
    implementation: "example/cli:v1",
    versionScheme: "semver",
    version: "1.2.3",
    releaseCommit: "a".repeat(40),
    releaseManifestSha256: digest("b"),
    releaseManifestUrl: "https://downloads.example.com/cli/v1.2.3/manifest.json",
    sourceUrl: "https://github.com/example/cli",
    artifacts: [
      {
        platform: "linux",
        arch: "x64",
        executableSha256: digest("c"),
      },
      {
        platform: "darwin",
        arch: "arm64",
        executableSha256: digest("d"),
        archiveSha256: digest("e"),
        downloadUrl: "https://downloads.example.com/cli/v1.2.3/darwin-arm64.tar.gz",
      },
    ],
  };
}

describe("local CLI tool identity", () => {
  test("canonicalizes artifact order and round trips the exact identity", () => {
    const forward = parseLocalCliToolIdentityV1(tool());
    const reversedValue = tool();
    (reversedValue.artifacts as unknown[]).reverse();
    const reversed = parseLocalCliToolIdentityV1(reversedValue);

    expect(reversed).toEqual(forward);
    expect(forward.artifacts.map(({ platform, arch }) => `${platform}/${arch}`))
      .toEqual(["darwin/arm64", "linux/x64"]);
    expect(parseLocalCliToolIdentityV1(structuredClone(forward))).toEqual(forward);
    expect(Object.isFrozen(forward)).toBeTrue();
    expect(Object.isFrozen(forward.artifacts)).toBeTrue();
  });

  test("supports exact opaque versions and optional provenance", () => {
    const minimal = tool();
    minimal.versionScheme = "opaque";
    minimal.version = "release 2026.08 stable";
    delete minimal.releaseCommit;
    delete minimal.releaseManifestSha256;
    delete minimal.releaseManifestUrl;
    delete minimal.sourceUrl;
    const artifacts = minimal.artifacts as Record<string, unknown>[];
    delete artifacts[1]?.archiveSha256;
    delete artifacts[1]?.downloadUrl;

    expect(parseLocalCliToolIdentityV1(minimal)).toMatchObject({
      versionScheme: "opaque",
      version: "release 2026.08 stable",
    });
    for (const invalid of [
      "latest\tstable",
      "latest\u001bstable",
      String.fromCharCode(0xd800),
    ]) {
      const candidate = structuredClone(minimal);
      candidate.version = invalid;
      expect(() => parseLocalCliToolIdentityV1(candidate)).toThrow("version is malformed");
    }
  });

  test("enforces semantic versions and paired provenance fields", () => {
    for (const invalid of ["1.2", "01.2.3", "1.02.3", "1.2.03", "latest"]) {
      const candidate = tool();
      candidate.version = invalid;
      expect(() => parseLocalCliToolIdentityV1(candidate)).toThrow("version is malformed");
    }
    for (const field of ["releaseManifestSha256", "releaseManifestUrl"] as const) {
      const candidate = tool();
      delete candidate[field];
      expect(() => parseLocalCliToolIdentityV1(candidate)).toThrow(
        "release manifest URL and digest must be declared together",
      );
    }
    for (const field of ["archiveSha256", "downloadUrl"] as const) {
      const candidate = tool();
      const artifact = (candidate.artifacts as Record<string, unknown>[])[1];
      if (artifact === undefined) throw new Error("missing fixture artifact");
      delete artifact[field];
      expect(() => parseLocalCliToolIdentityV1(candidate)).toThrow(
        "archive URL and digest must be declared together",
      );
    }
    for (const suffix of ["?token=secret", "#fragment"]) {
      const candidate = tool();
      candidate.releaseManifestUrl = `${String(candidate.releaseManifestUrl)}${suffix}`;
      expect(() => parseLocalCliToolIdentityV1(candidate)).toThrow(
        "without a query or fragment",
      );
    }
  });

  test("rejects duplicate coordinates, extra keys, and hostile data shapes", () => {
    const duplicate = tool();
    (duplicate.artifacts as unknown[]).push({
      platform: "linux",
      arch: "x64",
      executableSha256: digest("f"),
    });
    expect(() => parseLocalCliToolIdentityV1(duplicate)).toThrow("repeats");

    expect(() => parseLocalCliToolIdentityV1({ ...tool(), extra: true }))
      .toThrow("unsupported keys");
    expect(() => parseLocalCliToolIdentityV1(new Proxy(tool(), {})))
      .toThrow("must be an object");
    expect(() => parseLocalCliToolIdentityV1(Object.create({ inherited: true })))
      .toThrow("unsupported prototype");

    let getterCalls = 0;
    const accessor = tool();
    Object.defineProperty(accessor, "id", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "example-cli";
      },
    });
    expect(() => parseLocalCliToolIdentityV1(accessor)).toThrow("accessor");
    expect(getterCalls).toBe(0);

    const symbol = tool();
    Object.defineProperty(symbol, Symbol("secret"), {
      enumerable: true,
      value: "hidden",
    });
    expect(() => parseLocalCliToolIdentityV1(symbol)).toThrow("symbol");

    const sparse = tool();
    const artifacts = sparse.artifacts as unknown[];
    delete artifacts[0];
    expect(() => parseLocalCliToolIdentityV1(sparse)).toThrow("malformed");
  });

  test("artifact permutations always canonicalize", () => {
    assertProperty(fc.property(
      fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }),
      (order) => {
        const value = tool();
        value.artifacts = order.map((index) => ({
          platform: index < 2 ? "darwin" : "linux",
          arch: index % 2 === 0 ? "arm64" : "x64",
          executableSha256: digest(String(index + 1)),
        }));
        expect(parseLocalCliToolIdentityV1(value).artifacts.map((artifact) =>
          `${artifact.platform}/${artifact.arch}`))
          .toEqual(["darwin/arm64", "darwin/x64", "linux/arm64", "linux/x64"]);
      },
    ));
  });

  test("arbitrary foreign values fail closed without escaping Error", () => {
    assertProperty(fc.property(fc.anything({ withBigInt: true }), (value) => {
      try {
        parseLocalCliToolIdentityV1(value);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }));
  });

  test("shares exact provider identifiers and version bounds with contract identities", () => {
    const longSegment = `a${"b".repeat(39)}`;
    const identity = {
      surface: `a${"b".repeat(62)}`,
      action: [longSegment, longSegment, longSegment, longSegment].join("."),
      version: 1_000_000,
      hash: digest("f"),
      tool: { ...tool(), versionScheme: "opaque", version: " release stable " },
    };
    expect(parseLocalCliContractIdentityV1(identity)).toMatchObject({
      surface: identity.surface,
      action: identity.action,
      version: 1_000_000,
      tool: { version: " release stable " },
    });

    for (const changes of [
      { surface: "bad--surface" },
      { action: "single" },
      { action: "one.two.three.four.five" },
      { action: `${"a".repeat(41)}.read` },
      { version: 1_000_001 },
    ]) {
      expect(() => parseLocalCliContractIdentityV1({ ...identity, ...changes }))
        .toThrow("local CLI contract identity is malformed");
    }
  });
});
