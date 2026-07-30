import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import {
  RUNTIME_CLOSURE_PROFILE,
  computeRuntimeClosureSha256,
  type RuntimeClosureRecord,
} from "./runtime-closure";
import {
  loadConfiguredTranscriber,
  type WhisperCppTranscriberDependencies,
} from "./transcriber-config";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function propertyConfigPath(): Promise<string> {
  const requestedRoot = await mkdtemp(join(tmpdir(), "media-transcriber-property-"));
  temporaryRoots.push(requestedRoot);
  return join(await realpath(requestedRoot), "transcriber.json");
}

const unusedDependencies: WhisperCppTranscriberDependencies = {
  findExecutable: () => Promise.resolve(null),
  runProcess: () => Promise.reject(
    new Error("Malformed configurations must not reach process execution."),
  ),
  attestRuntimeClosure: () => Promise.reject(
    new Error("Malformed configurations must not reach runtime attestation."),
  ),
  randomToken: () => "unused",
};

function validRuntimeClosure(): RuntimeClosureRecord {
  const executableSha256 = "a".repeat(64);
  const dependencies = [{
    physicalPath: "/physical/libwhisper.dylib",
    logicalName: "libwhisper.dylib",
    sha256: "c".repeat(64),
    bytes: 17,
  }] as const;
  return {
    profile: RUNTIME_CLOSURE_PROFILE,
    platform: "darwin",
    evidence: "dynamic-loader",
    executableSha256,
    closureSha256: computeRuntimeClosureSha256("darwin", executableSha256, dependencies),
    dependencyCount: dependencies.length,
    dependencyBytes: dependencies[0].bytes,
    dependencies,
  };
}

function validConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    adapter: "whisper-cpp",
    profile: "wrench-media-whisper-cpp-v1",
    executablePath: "/physical/whisper-cli",
    modelPath: "/physical/model.bin",
    executableSha256: "a".repeat(64),
    modelSha256: "b".repeat(64),
    modelBytes: 1,
    runtimeClosure: validRuntimeClosure(),
  };
}

async function writePrivateConfig(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

test("property: arbitrary bounded config bytes never throw or become ready", async () => {
  const configPath = await propertyConfigPath();
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 4_096 }),
      async (bytes) => {
        await writeFile(configPath, bytes, { mode: 0o600 });
        await chmod(configPath, 0o600);

        const result = await loadConfiguredTranscriber({ configPath }, unusedDependencies);

        expect(result.kind).toBe("invalid");
      },
    ),
    { numRuns: 200 },
  );
});

test("property: an arbitrary extra root field violates the exact schema", async () => {
  const configPath = await propertyConfigPath();
  const reservedKeys = new Set(Object.keys(validConfig()));
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 32 }),
      fc.jsonValue(),
      async (key, value) => {
        fc.pre(!reservedKeys.has(key));
        await writePrivateConfig(configPath, { ...validConfig(), [key]: value });

        const result = await loadConfiguredTranscriber({ configPath }, unusedDependencies);

        expect(result).toMatchObject({ kind: "invalid", reason: "malformed-config" });
      },
    ),
    { numRuns: 200 },
  );
});

test("property: an arbitrary extra runtime field violates the nested exact schema", async () => {
  const configPath = await propertyConfigPath();
  const reservedKeys = new Set(Object.keys(validRuntimeClosure()));
  await fc.assert(
    fc.asyncProperty(
      fc.string({ minLength: 1, maxLength: 32 }),
      fc.jsonValue(),
      async (key, value) => {
        fc.pre(!reservedKeys.has(key));
        await writePrivateConfig(configPath, {
          ...validConfig(),
          runtimeClosure: { ...validRuntimeClosure(), [key]: value },
        });

        const result = await loadConfiguredTranscriber({ configPath }, unusedDependencies);

        expect(result).toMatchObject({ kind: "invalid", reason: "malformed-config" });
      },
    ),
    { numRuns: 200 },
  );
});

test("property: forged closure summaries never reach filesystem or process seams", async () => {
  const configPath = await propertyConfigPath();
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom("dependencyCount", "dependencyBytes", "closureSha256"),
      fc.integer({ min: 1, max: 1_000 }),
      async (field, delta) => {
        const closure = validRuntimeClosure();
        const forged = {
          ...closure,
          [field]: field === "closureSha256"
            ? "f".repeat(64)
            : field === "dependencyCount"
              ? closure.dependencyCount + delta
              : closure.dependencyBytes + delta,
        };
        await writePrivateConfig(configPath, { ...validConfig(), runtimeClosure: forged });

        const result = await loadConfiguredTranscriber({ configPath }, unusedDependencies);

        expect(result).toMatchObject({ kind: "invalid", reason: "malformed-config" });
      },
    ),
    { numRuns: 100 },
  );
});
