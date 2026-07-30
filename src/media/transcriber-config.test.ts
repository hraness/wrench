import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandArgv, ProcessResult, RunProcessOptions } from "./process";
import {
  RUNTIME_CLOSURE_PROFILE,
  buildWhisperRuntimeEnvironment,
  computeRuntimeClosureSha256,
  type AttestRuntimeClosureOptions,
  type RuntimeClosureAttestation,
} from "./runtime-closure";
import {
  WHISPER_CPP_PROFILE,
  WhisperCppTranscriberSetupError,
  loadConfiguredTranscriber,
  reverifyReadyTranscriber,
  reverifyReadyTranscriberAfterRun,
  setupWhisperCppTranscriber,
  type WhisperCppTranscriberDependencies,
} from "./transcriber-config";

const GOOD_HELP = [
  "usage: whisper-cli",
  "--model PATH",
  "--file PATH",
  "--language LANG",
  "--threads N",
  "--processors N",
  "--no-gpu",
  "--output-vtt",
  "--output-json-full",
  "--output-file PATH",
  "--no-prints",
].join("\n");

interface Fixture {
  readonly root: string;
  readonly executablePath: string;
  readonly modelPath: string;
  readonly otherModelPath: string;
  readonly runtimePath: string;
  readonly otherRuntimePath: string;
  readonly configPath: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<Fixture> {
  const requestedRoot = await mkdtemp(join(tmpdir(), "media-transcriber-config-"));
  temporaryRoots.push(requestedRoot);
  const root = await realpath(requestedRoot);
  const executablePath = join(root, "whisper-cli");
  const modelPath = join(root, "model.bin");
  const otherModelPath = join(root, "other-model.bin");
  const runtimePath = join(root, "runtime-a", "libwhisper.dylib");
  const otherRuntimePath = join(root, "runtime-b", "libwhisper.dylib");
  await mkdir(join(root, "runtime-a"));
  await mkdir(join(root, "runtime-b"));
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await chmod(executablePath, 0o755);
  await writeFile(modelPath, "model-one-contents");
  await writeFile(otherModelPath, "a-different-model");
  await writeFile(runtimePath, "runtime-one");
  await writeFile(otherRuntimePath, "runtime-two");
  return {
    root,
    executablePath,
    modelPath,
    otherModelPath,
    runtimePath,
    otherRuntimePath,
    configPath: join(root, "config", "transcriber.json"),
  };
}

function processSuccess(stdout = GOOD_HELP): ProcessResult {
  return {
    ok: true,
    command: ["whisper-cli", "--help"],
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    elapsedMs: 1,
  };
}

function runtimeClosure(
  executableSha256: string,
  physicalPath: string,
  options: Readonly<{
    dependencySha256?: string;
    dependencyBytes?: number;
  }> = {},
): RuntimeClosureAttestation {
  const dependency = {
    physicalPath,
    logicalName: "libwhisper.dylib",
    sha256: options.dependencySha256 ?? "b".repeat(64),
    bytes: options.dependencyBytes ?? 11,
  } as const;
  const dependencies = [dependency] as const;
  return {
    profile: RUNTIME_CLOSURE_PROFILE,
    platform: "darwin",
    evidence: "dynamic-loader",
    executableSha256,
    closureSha256: computeRuntimeClosureSha256("darwin", executableSha256, dependencies),
    dependencyCount: dependencies.length,
    dependencyBytes: dependency.bytes,
    dependencies,
  };
}

function dependencies(
  item: Fixture,
  options: Readonly<{
    help?: string;
    onRun?: (argv: CommandArgv, processOptions: RunProcessOptions) => void | Promise<void>;
    attest?: (
      options: AttestRuntimeClosureOptions,
      call: number,
    ) => RuntimeClosureAttestation | Promise<RuntimeClosureAttestation>;
    onAttest?: (options: AttestRuntimeClosureOptions, call: number) => void;
  }> = {},
): WhisperCppTranscriberDependencies {
  let token = 0;
  let attestCall = 0;
  return {
    findExecutable: (name) => Promise.resolve(name === "whisper-cli" ? item.executablePath : null),
    runProcess: async (argv, processOptions) => {
      await options.onRun?.(argv, processOptions);
      return processSuccess(options.help ?? GOOD_HELP);
    },
    attestRuntimeClosure: async (attestOptions) => {
      const call = attestCall;
      attestCall += 1;
      options.onAttest?.(attestOptions, call);
      return await (options.attest?.(attestOptions, call)
        ?? runtimeClosure(attestOptions.executableSha256, item.runtimePath));
    },
    randomToken: () => `fixture-${String(token += 1)}`,
  };
}

async function expectSetupError(
  action: () => Promise<unknown>,
  code: WhisperCppTranscriberSetupError["code"],
): Promise<WhisperCppTranscriberSetupError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(WhisperCppTranscriberSetupError);
    if (!(error instanceof WhisperCppTranscriberSetupError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected setup to fail with ${code}.`);
}

describe("whisper.cpp transcriber configuration", () => {
  test("reports an absent private configuration as not configured", async () => {
    const item = await fixture();

    expect(await loadConfiguredTranscriber({ configPath: item.configPath })).toEqual({
      kind: "not-configured",
    });
    expect(await loadConfiguredTranscriber({ configPath: "relative/config.json" })).toMatchObject({
      kind: "invalid",
      reason: "invalid-location",
    });
  });

  test("attests around a strict capability probe, persists the current schema, and reloads it", async () => {
    const item = await fixture();
    const events: string[] = [];
    const calls: Array<Readonly<{ argv: CommandArgv; options: RunProcessOptions }>> = [];
    const seams = dependencies(item, {
      onAttest: () => events.push("attest"),
      onRun: (argv, options) => {
        events.push("capability");
        calls.push({ argv, options });
      },
    });

    const configured = await setupWhisperCppTranscriber(
      {
        modelPath: item.modelPath,
        configPath: item.configPath,
        env: { PATH: item.root, DYLD_LIBRARY_PATH: "/secret/loader", CUDA_VISIBLE_DEVICES: "7" },
      },
      seams,
    );

    expect(events).toEqual(["attest", "capability", "attest"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      argv: [item.executablePath, "--help"],
      options: {
        env: buildWhisperRuntimeEnvironment(),
        timeoutMs: 5_000,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 256 * 1024,
      },
    });
    expect(configured).toMatchObject({
      executablePath: item.executablePath,
      modelPath: item.modelPath,
      descriptor: {
        adapter: "whisper-cpp",
        profile: WHISPER_CPP_PROFILE,
        modelBytes: 18,
        runtimeProfile: RUNTIME_CLOSURE_PROFILE,
        runtimeDependencyCount: 1,
      },
      runtimeClosure: {
        dependencies: [{ physicalPath: item.runtimePath }],
      },
    });
    expect(configured.descriptor.runtimeSha256).toBe(configured.runtimeClosure.closureSha256);
    expect(JSON.stringify(configured.descriptor)).not.toContain(item.runtimePath);
    expect(Number((await stat(item.configPath)).mode & 0o777)).toBe(0o600);

    const persisted = JSON.parse(await readFile(item.configPath, "utf8")) as Record<string, unknown>;
    expect(persisted["schemaVersion"]).toBe(1);
    expect(persisted["profile"]).toBe("wrench-media-whisper-cpp-v1");
    expect(persisted["runtimeClosure"]).toEqual(configured.runtimeClosure);
    expect(JSON.stringify(persisted)).not.toContain("DYLD_LIBRARY_PATH");
    expect(JSON.stringify(persisted)).not.toContain("CUDA_VISIBLE_DEVICES");

    events.length = 0;
    expect(await loadConfiguredTranscriber({ configPath: item.configPath }, seams)).toEqual({
      kind: "ready",
      transcriber: configured,
    });
    expect(events).toEqual(["attest", "capability", "attest"]);
  });

  test("resolves symlink inputs once and persists only physical targets", async () => {
    const item = await fixture();
    const executableLink = join(item.root, "whisper-link");
    const modelLink = join(item.root, "model-link");
    await symlink(item.executablePath, executableLink);
    await symlink(item.modelPath, modelLink);
    const seams = dependencies(item);

    const configured = await setupWhisperCppTranscriber(
      { executablePath: executableLink, modelPath: modelLink, configPath: item.configPath },
      seams,
    );

    expect(configured.executablePath).toBe(item.executablePath);
    expect(configured.modelPath).toBe(item.modelPath);
    expect(await loadConfiguredTranscriber({ configPath: item.configPath }, seams)).toEqual({
      kind: "ready",
      transcriber: configured,
    });
  });

  test("rejects symlinked and publicly readable configs without following them", async () => {
    const item = await fixture();
    const seams = dependencies(item);
    await setupWhisperCppTranscriber(
      { modelPath: item.modelPath, configPath: item.configPath },
      seams,
    );
    const target = join(item.root, "config-target.json");
    await rename(item.configPath, target);
    await symlink(target, item.configPath);

    expect(await loadConfiguredTranscriber({ configPath: item.configPath }, seams)).toMatchObject({
      kind: "invalid",
      reason: "unsafe-config",
    });

    await rm(item.configPath);
    await rename(target, item.configPath);
    await chmod(item.configPath, 0o644);
    expect(await loadConfiguredTranscriber({ configPath: item.configPath }, seams)).toMatchObject({
      kind: "invalid",
      reason: "config-permissions",
    });
  });

  test("detects dependency path drift even when the closure summary hash is unchanged", async () => {
    const item = await fixture();
    const stable = dependencies(item);
    const configured = await setupWhisperCppTranscriber(
      { modelPath: item.modelPath, configPath: item.configPath },
      stable,
    );
    const moved = runtimeClosure(
      configured.descriptor.executableSha256,
      item.otherRuntimePath,
    );
    expect(moved.closureSha256).toBe(configured.runtimeClosure.closureSha256);

    expect(await loadConfiguredTranscriber(
      { configPath: item.configPath },
      dependencies(item, { attest: () => moved }),
    )).toMatchObject({ kind: "invalid", reason: "runtime-closure-mismatch" });
  });

  test("detects runtime closure drift across the setup capability probe", async () => {
    const item = await fixture();
    await expectSetupError(
      async () => await setupWhisperCppTranscriber(
        { modelPath: item.modelPath, configPath: item.configPath },
        dependencies(item, {
          attest: (options, call) => runtimeClosure(
            options.executableSha256,
            call === 0 ? item.runtimePath : item.otherRuntimePath,
          ),
        }),
      ),
      "RUNTIME_CLOSURE_MISMATCH",
    );
  });

  test("detects model and executable corruption before runtime execution", async () => {
    const item = await fixture();
    const seams = dependencies(item);
    await setupWhisperCppTranscriber(
      { modelPath: item.modelPath, configPath: item.configPath },
      seams,
    );
    const model = await readFile(item.modelPath);
    await writeFile(item.modelPath, Buffer.alloc(model.byteLength, 0x78));
    expect(await loadConfiguredTranscriber({ configPath: item.configPath }, seams)).toMatchObject({
      kind: "invalid",
      reason: "model-hash-mismatch",
    });

    await writeFile(item.modelPath, model);
    const executable = await readFile(item.executablePath);
    await writeFile(item.executablePath, Buffer.alloc(executable.byteLength, 0x79));
    await chmod(item.executablePath, 0o755);
    expect(await loadConfiguredTranscriber({ configPath: item.configPath }, seams)).toMatchObject({
      kind: "invalid",
      reason: "executable-hash-mismatch",
    });
  });

  test("rejects model drift during the capability probe", async () => {
    const item = await fixture();
    const original = await readFile(item.modelPath);

    await expectSetupError(
      async () => await setupWhisperCppTranscriber(
        { modelPath: item.modelPath, configPath: item.configPath },
        dependencies(item, {
          onRun: async () => await writeFile(
            item.modelPath,
            Buffer.alloc(original.byteLength, 0x78),
          ),
        }),
      ),
      "UNSTABLE_FILE",
    );
  });

  test("requires exact whisper.cpp flags and keeps process diagnostics path-free", async () => {
    const item = await fixture();
    const spoofedHelp = GOOD_HELP.replace("--model PATH", "--model-path PATH");
    const error = await expectSetupError(
      async () => await setupWhisperCppTranscriber(
        { modelPath: item.modelPath, configPath: item.configPath },
        dependencies(item, { help: spoofedHelp }),
      ),
      "CAPABILITY_MISMATCH",
    );
    expect(error.message).not.toContain("model-path");

    for (const requiredFlag of ["--threads N", "--processors N", "--no-gpu"] as const) {
      await expectSetupError(
        async () => await setupWhisperCppTranscriber(
          { modelPath: item.modelPath, configPath: item.configPath },
          dependencies(item, { help: GOOD_HELP.replace(requiredFlag, "") }),
        ),
        "CAPABILITY_MISMATCH",
      );
    }

    const failure = await expectSetupError(
      async () => await setupWhisperCppTranscriber(
        { modelPath: item.modelPath, configPath: item.configPath },
        {
          ...dependencies(item),
          attestRuntimeClosure: () => Promise.reject(
            new Error(`secret runtime path: ${item.runtimePath}`),
          ),
        },
      ),
      "RUNTIME_ATTESTATION_FAILED",
    );
    expect(failure.message).not.toContain(item.root);
  });

  test("re-verifies model, executable, and exact closure after long preparation", async () => {
    const item = await fixture();
    const seams = dependencies(item);
    const configured = await setupWhisperCppTranscriber(
      { modelPath: item.modelPath, configPath: item.configPath },
      seams,
    );
    expect(await reverifyReadyTranscriber(configured, seams)).toEqual({
      kind: "ready",
      transcriber: configured,
    });
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    expect(await reverifyReadyTranscriber(
      configured,
      dependencies(item, {
        onAttest: (options) => { observedSignal = options.signal; },
      }),
      { signal: controller.signal },
    )).toMatchObject({ kind: "ready" });
    expect(observedSignal).toBe(controller.signal);

    const movedClosure = runtimeClosure(
      configured.descriptor.executableSha256,
      item.otherRuntimePath,
    );
    expect(await reverifyReadyTranscriber(
      configured,
      dependencies(item, { attest: () => movedClosure }),
    )).toMatchObject({ kind: "invalid", reason: "runtime-closure-mismatch" });

    const original = await readFile(item.modelPath);
    await writeFile(item.modelPath, Buffer.alloc(original.byteLength, 0x78));
    expect(await reverifyReadyTranscriber(configured, seams)).toMatchObject({
      kind: "invalid",
      reason: "model-hash-mismatch",
    });
  });

  test("uses the inference attestation for a no-process post-run file recheck", async () => {
    const item = await fixture();
    const configured = await setupWhisperCppTranscriber(
      { modelPath: item.modelPath, configPath: item.configPath },
      dependencies(item),
    );

    expect(await reverifyReadyTranscriberAfterRun(
      configured,
      configured.runtimeClosure,
    )).toEqual({ kind: "ready", transcriber: configured });

    const movedClosure = runtimeClosure(
      configured.descriptor.executableSha256,
      item.otherRuntimePath,
    );
    expect(await reverifyReadyTranscriberAfterRun(
      configured,
      movedClosure,
    )).toMatchObject({ kind: "invalid", reason: "runtime-closure-mismatch" });

    const executable = await readFile(item.executablePath);
    await writeFile(item.executablePath, Buffer.alloc(executable.byteLength, 0x79));
    await chmod(item.executablePath, 0o755);
    expect(await reverifyReadyTranscriberAfterRun(
      configured,
      configured.runtimeClosure,
    )).toMatchObject({ kind: "invalid", reason: "executable-hash-mismatch" });
  });

  test("returns an identical setup without rewriting its configuration", async () => {
    const item = await fixture();
    const seams = dependencies(item);
    const options = { modelPath: item.modelPath, configPath: item.configPath } as const;
    const first = await setupWhisperCppTranscriber(options, seams);
    const before = await lstat(item.configPath, { bigint: true });

    const second = await setupWhisperCppTranscriber(options, seams);
    const after = await lstat(item.configPath, { bigint: true });

    expect(second).toEqual(first);
    expect(after.ino).toBe(before.ino);
  });

  test("requires replace for a different model and reloads the replacement", async () => {
    const item = await fixture();
    const seams = dependencies(item);
    await setupWhisperCppTranscriber(
      { modelPath: item.modelPath, configPath: item.configPath },
      seams,
    );
    await expectSetupError(
      async () => await setupWhisperCppTranscriber(
        { modelPath: item.otherModelPath, configPath: item.configPath },
        seams,
      ),
      "CONFIG_EXISTS",
    );

    const replacement = await setupWhisperCppTranscriber(
      { modelPath: item.otherModelPath, configPath: item.configPath, replace: true },
      seams,
    );
    expect(await loadConfiguredTranscriber({ configPath: item.configPath }, seams)).toEqual({
      kind: "ready",
      transcriber: replacement,
    });
  });

  test("rejects a sparse model beyond the hashing cap before attestation", async () => {
    const item = await fixture();
    const oversizedPath = join(item.root, "oversized-model.bin");
    const handle = await open(oversizedPath, "w");
    try {
      await handle.truncate(8 * 1024 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }

    await expectSetupError(
      async () => await setupWhisperCppTranscriber(
        { modelPath: oversizedPath, configPath: item.configPath },
        dependencies(item),
      ),
      "FILE_TOO_LARGE",
    );
  });
});
