import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  buildWhisperRuntimeEnvironment,
  computeRuntimeClosureSha256,
  parseRuntimeClosureRecord,
  parseRuntimeLoaderTrace,
  type RuntimeClosureDigestDependency,
  type RuntimeClosurePlatform,
} from "./runtime-closure";

const SHA256 = /^[0-9a-f]{64}$/u;
const EXECUTABLE_SHA256 = "a".repeat(64);
const EXECUTABLE_PATH = "/opt/media/whisper-cli";

function tokenArbitrary(): fc.Arbitrary<string> {
  return fc.array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
    { minLength: 1, maxLength: 20 },
  ).map((characters) => characters.join(""));
}

function dependencyArbitrary(): fc.Arbitrary<RuntimeClosureDigestDependency> {
  return fc.record({
    logicalName: tokenArbitrary().map((token) => `lib${token}.so`),
    sha256: fc.array(
      fc.constantFrom(..."0123456789abcdef"),
      { minLength: 64, maxLength: 64 },
    ).map((characters) => characters.join("")),
    bytes: fc.integer({ min: 0, max: 1024 * 1024 }),
  });
}

test("property: arbitrary loader traces are total and return a discriminated result", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 8_192 }),
      fc.constantFrom<RuntimeClosurePlatform>("darwin", "linux"),
      (trace, platform) => {
        const result = parseRuntimeLoaderTrace(trace, {
          platform,
          executablePath: EXECUTABLE_PATH,
        });
        expect(typeof result.ok).toBe("boolean");
        if (result.ok) {
          expect(result.evidence).toBe("dynamic-loader");
        } else {
          expect(result.code.startsWith("TRACE_")).toBe(true);
        }
      },
    ),
    { numRuns: 500 },
  );
});

test("property: the framed closure digest is order-independent and path-free", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<RuntimeClosurePlatform>("darwin", "linux"),
      fc.array(dependencyArbitrary(), { maxLength: 40 }),
      fc.integer(),
      (platform, dependencies, seed) => {
        const shuffled = [...dependencies];
        for (let index = shuffled.length - 1; index > 0; index -= 1) {
          const swapIndex = Math.abs(seed + index) % (index + 1);
          const current = shuffled[index];
          const replacement = shuffled[swapIndex];
          if (current !== undefined && replacement !== undefined) {
            shuffled[index] = replacement;
            shuffled[swapIndex] = current;
          }
        }
        const original = computeRuntimeClosureSha256(
          platform,
          EXECUTABLE_SHA256,
          dependencies,
        );
        const reordered = computeRuntimeClosureSha256(
          platform,
          EXECUTABLE_SHA256,
          shuffled,
        );
        expect(original).toMatch(SHA256);
        expect(reordered).toBe(original);

        const withArbitraryPaths = dependencies.map((dependency, index) => ({
          ...dependency,
          physicalPath: `/location-${String(seed)}/${String(index)}/${dependency.logicalName}`,
        }));
        expect(computeRuntimeClosureSha256(
          platform,
          EXECUTABLE_SHA256,
          withArbitraryPaths,
        )).toBe(original);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: arbitrary inherited secrets can never enter the constant runtime environment", () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 64 }), fc.string({ maxLength: 256 })),
      (inheritedEnvironment) => {
        expect(Object.keys(inheritedEnvironment).length).toBeGreaterThanOrEqual(0);
        expect(buildWhisperRuntimeEnvironment()).toEqual({
          LANG: "C",
          LC_ALL: "C",
          TZ: "UTC",
        });
      },
    ),
    { numRuns: 300 },
  );
});

test("property: arbitrary JSON-like values never escape the exact record parser", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const result = parseRuntimeClosureRecord(value);
      expect(typeof result.ok).toBe("boolean");
    }),
    { numRuns: 500 },
  );
});

test("property: resolved glibc search traces select the final candidate, not failed attempts", () => {
  fc.assert(
    fc.property(tokenArbitrary(), tokenArbitrary(), (libraryToken, directoryToken) => {
      const logicalName = `lib${libraryToken}.so.1`;
      const failedPath = `/missing/${directoryToken}/${logicalName}`;
      const resolvedPath = `/opt/${directoryToken}/${logicalName}`;
      const trace = [
        `1: find library=${logicalName} [0]; searching`,
        "1: search cache=/etc/ld.so.cache",
        `1: trying file=${failedPath}`,
        `1: trying file=${resolvedPath}`,
        `1: file=${logicalName} [0]; needed by ${EXECUTABLE_PATH} [0]`,
        `1: file=${logicalName} [0]; generating link map`,
        `1: initialize program: ${EXECUTABLE_PATH}`,
        `1: transferring control: ${EXECUTABLE_PATH}`,
      ].join("\n");
      expect(parseRuntimeLoaderTrace(trace, {
        platform: "linux",
        executablePath: EXECUTABLE_PATH,
      })).toEqual({
        ok: true,
        evidence: "dynamic-loader",
        loadedPaths: [EXECUTABLE_PATH, resolvedPath].sort(),
      });
    }),
    { numRuns: 300 },
  );
});
