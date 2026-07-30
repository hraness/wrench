import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ProcessResult, RunProcessOptions } from "./process";
import {
  MAX_RUNTIME_DEPENDENCIES,
  MAX_RUNTIME_TRACE_BYTES,
  RUNTIME_CLOSURE_PROFILE,
  RuntimeClosureError,
  attestRuntimeClosure,
  buildRuntimeTraceEnvironment,
  buildWhisperRuntimeEnvironment,
  computeRuntimeClosureSha256,
  isPlatformOwnedRuntimePath,
  parseRuntimeClosureRecord,
  parseRuntimeLoaderTrace,
  runAttestedRuntimeProcess,
  sameRuntimeClosure,
  sameRuntimeClosureRecord,
  stripRuntimeClosureRecord,
  type RuntimeClosureDependencies,
} from "./runtime-closure";

const EXECUTABLE_CONTENT = "fixture whisper executable";
const EXECUTABLE_SHA256 = createHash("sha256").update(EXECUTABLE_CONTENT).digest("hex");
const UUIDS = [
  "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
  "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
  "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
] as const;

interface Fixture {
  readonly root: string;
  readonly executablePath: string;
  readonly whisperPath: string;
  readonly ggmlPath: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function fixture(prefix = "media-runtime-closure-"): Promise<Fixture> {
  const requestedRoot = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(requestedRoot);
  const root = await realpath(requestedRoot);
  const executablePath = join(root, "whisper-cli");
  const whisperPath = join(root, "libwhisper.dylib");
  const ggmlPath = join(root, "libggml.dylib");
  await writeFile(executablePath, EXECUTABLE_CONTENT, { mode: 0o755 });
  await chmod(executablePath, 0o755);
  await writeFile(whisperPath, "whisper-library");
  await writeFile(ggmlPath, "ggml-library");
  return { root, executablePath, whisperPath, ggmlPath };
}

function darwinTrace(item: Fixture, paths: readonly string[] = [item.whisperPath, item.ggmlPath]): string {
  const records = [item.executablePath, "/usr/lib/libSystem.B.dylib", ...paths];
  return records.map((path, index) => (
    `dyld[1234]: <${UUIDS[index % UUIDS.length] ?? UUIDS[0]}> ${path}`
  )).concat("dyld[1234]: move loaded to delayed: CoreML").join("\n");
}

function glibcTrace(
  executablePath: string,
  paths: readonly string[],
): string {
  const records: string[] = [];
  for (const path of paths) {
    records.push(`  4321:\tfile=${basename(path)} [0];  needed by ${executablePath} [0]`);
    records.push(`  4321:\tfile=${basename(path)} [0];  generating link map`);
    records.push(`  4321:\tcalling init: ${path}`);
  }
  records.push(`  4321:\tinitialize program: ${executablePath}`);
  records.push(`  4321:\ttransferring control: ${executablePath}`);
  return records.join("\n");
}

function elf64(programHeaderTypes: readonly number[]): Uint8Array {
  const entryBytes = 56;
  const bytes = new Uint8Array(64 + entryBytes * programHeaderTypes.length);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 0x3e, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, entryBytes, true);
  view.setUint16(56, programHeaderTypes.length, true);
  programHeaderTypes.forEach((type, index) => {
    view.setUint32(64 + index * entryBytes, type, true);
  });
  return bytes;
}

function processSuccess(trace: string, stream: "stdout" | "stderr" = "stderr"): ProcessResult {
  return {
    ok: true,
    command: ["whisper-cli", "--help"],
    exitCode: 0,
    stdout: stream === "stdout" ? trace : "usage: whisper-cli",
    stderr: stream === "stderr" ? trace : "usage: whisper-cli",
    stdoutTruncated: false,
    stderrTruncated: false,
    elapsedMs: 1,
  };
}

function runner(
  result: ProcessResult,
  onRun?: (options: RunProcessOptions) => void | Promise<void>,
): RuntimeClosureDependencies {
  return {
    runProcess: async (_argv, options) => {
      await onRun?.(options);
      return Promise.resolve(result);
    },
  };
}

async function expectRuntimeError(
  action: () => Promise<unknown>,
  code: RuntimeClosureError["code"],
): Promise<RuntimeClosureError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeClosureError);
    if (!(error instanceof RuntimeClosureError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected runtime closure failure ${code}.`);
}

describe("runtime environment", () => {
  test("constructs a constant environment with no inherited loader or backend controls", () => {
    const environment = buildWhisperRuntimeEnvironment();

    expect(environment).toEqual({
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    });
    expect(buildRuntimeTraceEnvironment("darwin")).toEqual({
      ...environment,
      DYLD_PRINT_LIBRARIES: "1",
    });
    expect(buildRuntimeTraceEnvironment("linux")).toEqual({
      ...environment,
      LD_DEBUG: "files",
    });
    expect(environment).not.toHaveProperty("DYLD_PRINT_LIBRARIES");
    expect(Object.isFrozen(environment)).toBe(true);
  });

  test("passes the exact minimal environment to the trace plus one tracer variable", async () => {
    const item = await fixture();
    let observed: RunProcessOptions | undefined;

    const attestation = await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item)), (options) => {
      observed = options;
    }));

    expect(attestation).not.toHaveProperty("executionEnvironment");
    expect(observed?.env).toEqual({
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
      DYLD_PRINT_LIBRARIES: "1",
    });
    expect(observed).toMatchObject({
      timeoutMs: 10_000,
      maxStdoutBytes: MAX_RUNTIME_TRACE_BYTES,
      maxStderrBytes: MAX_RUNTIME_TRACE_BYTES,
    });
  });
});

describe("loader trace parsing", () => {
  test("parses modern Darwin image records and ignores only known delayed-image records", async () => {
    const item = await fixture();
    const trace = darwinTrace(item);

    expect(parseRuntimeLoaderTrace(trace, {
      platform: "darwin",
      executablePath: item.executablePath,
    })).toEqual({
      ok: true,
      evidence: "dynamic-loader",
      loadedPaths: [
        item.ggmlPath,
        item.whisperPath,
        item.executablePath,
        "/usr/lib/libSystem.B.dylib",
      ].sort(),
    });
    expect(parseRuntimeLoaderTrace(
      `${trace}\ndyld[1234]: an unknown loader record /tmp/hidden.dylib`,
      { platform: "darwin", executablePath: item.executablePath },
    )).toMatchObject({ ok: false, code: "TRACE_MALFORMED" });
  });

  test("parses resolved glibc file and phase records from stderr only", async () => {
    const item = await fixture();
    const linuxWhisperPath = join(item.root, "libwhisper.so.1");
    await writeFile(linuxWhisperPath, "linux-whisper-library");
    const trace = glibcTrace(item.executablePath, [linuxWhisperPath]);

    expect(parseRuntimeLoaderTrace(trace, {
      platform: "linux",
      executablePath: item.executablePath,
    })).toEqual({
      ok: true,
      evidence: "dynamic-loader",
      loadedPaths: [item.executablePath, linuxWhisperPath].sort(),
    });

    const attestation = await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "linux",
    }, runner(processSuccess(trace)));
    expect(attestation.dependencies).toEqual([{
      physicalPath: linuxWhisperPath,
      logicalName: "libwhisper.so.1",
      bytes: 21,
      sha256: createHash("sha256").update("linux-whisper-library").digest("hex"),
    }]);

    await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item), "stdout"))), "TRACE_MISSING");
  });

  test("treats glibc search candidates as untrusted until a link-map record selects one", async () => {
    const item = await fixture();
    const libraryPath = join(item.root, "libwhisper.so.1");
    const rejectedCandidate = join(item.root, "missing", "libwhisper.so.1");
    const trace = [
      "  77:\tfind library=libwhisper.so.1 [0]; searching",
      `  77:\t search path=${item.root}\t\t(RUNPATH from file ${item.executablePath})`,
      `  77:\t  trying file=${rejectedCandidate}`,
      `  77:\t  trying file=${libraryPath}`,
      `  77:\tfile=libwhisper.so.1 [0]; needed by ${item.executablePath} [0]`,
      "  77:\tfile=libwhisper.so.1 [0]; generating link map",
      `  77:\tinitialize program: ${item.executablePath}`,
      `  77:\ttransferring control: ${item.executablePath}`,
    ].join("\n");

    expect(parseRuntimeLoaderTrace(trace, {
      platform: "linux",
      executablePath: item.executablePath,
    })).toEqual({
      ok: true,
      evidence: "dynamic-loader",
      loadedPaths: [item.executablePath, libraryPath].sort(),
    });
  });

  test("fails closed on absent, unresolved, relative, control-bearing, and unknown path records", async () => {
    const item = await fixture();
    const baseOptions = { platform: "linux" as const, executablePath: item.executablePath };

    expect(parseRuntimeLoaderTrace("usage: whisper-cli", baseOptions)).toMatchObject({
      ok: false,
      code: "TRACE_MISSING",
    });
    expect(parseRuntimeLoaderTrace(
      `1: file=libmissing.so [0]; needed by ${item.executablePath} [0]\n`
        + `1: initialize program: ${item.executablePath}`,
      baseOptions,
    )).toMatchObject({ ok: false, code: "TRACE_UNRESOLVED" });
    expect(parseRuntimeLoaderTrace(
      `1: file=./libwhisper.so [0]; needed by ${item.executablePath} [0]\n`
        + `1: initialize program: ${item.executablePath}`,
      baseOptions,
    )).toMatchObject({ ok: false, code: "TRACE_MALFORMED" });
    expect(parseRuntimeLoaderTrace(
      `1: calling init: /tmp/lib\u0000whisper.so\n1: initialize program: ${item.executablePath}`,
      baseOptions,
    )).toMatchObject({ ok: false, code: "TRACE_MALFORMED" });
    expect(parseRuntimeLoaderTrace(
      `1: an unknown record /tmp/libwhisper.so\n1: initialize program: ${item.executablePath}`,
      baseOptions,
    )).toMatchObject({ ok: false, code: "TRACE_MALFORMED" });
    expect(parseRuntimeLoaderTrace(
      `1: error while loading shared libraries: libwhisper.so: cannot open shared object file`,
      baseOptions,
    )).toMatchObject({ ok: false, code: "TRACE_UNRESOLVED" });
  });

  test("rejects a loaderless executable even when its ELF headers are identity-bound", async () => {
    const item = await fixture();
    const withoutEvidence = parseRuntimeLoaderTrace("usage: whisper-cli", {
      platform: "linux",
      executablePath: item.executablePath,
    });
    expect(withoutEvidence).toMatchObject({ ok: false, code: "TRACE_MISSING" });

    const loaderlessElf = elf64([1, 4, 6]);
    const loaderlessSha256 = createHash("sha256").update(loaderlessElf).digest("hex");
    await writeFile(item.executablePath, loaderlessElf, { mode: 0o755 });
    await chmod(item.executablePath, 0o755);
    let failure: unknown;
    try {
      await attestRuntimeClosure({
        executablePath: item.executablePath,
        executableSha256: loaderlessSha256,
        platform: "linux",
      }, runner(processSuccess("usage: whisper-cli")));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "TRACE_MISSING",
    });
  });
});

describe("runtime closure attestation", () => {
  test("stable-hashes every non-platform image and returns exact physical records", async () => {
    const item = await fixture();
    const attestation = await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item))));

    expect(attestation).toMatchObject({
      profile: RUNTIME_CLOSURE_PROFILE,
      platform: "darwin",
      evidence: "dynamic-loader",
      executableSha256: EXECUTABLE_SHA256,
      dependencyCount: 2,
      dependencyBytes: 27,
    });
    expect(attestation.closureSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(attestation.dependencies).toEqual([
      {
        physicalPath: item.ggmlPath,
        logicalName: "libggml.dylib",
        sha256: createHash("sha256").update("ggml-library").digest("hex"),
        bytes: 12,
      },
      {
        physicalPath: item.whisperPath,
        logicalName: "libwhisper.dylib",
        sha256: createHash("sha256").update("whisper-library").digest("hex"),
        bytes: 15,
      },
    ]);
    expect(JSON.stringify(attestation)).not.toContain("/usr/lib");
    expect(stripRuntimeClosureRecord(attestation)).toEqual(attestation);
  });

  test("supports an empty non-platform closure while requiring real dynamic trace evidence", async () => {
    const item = await fixture();
    const trace = [
      `dyld[1234]: <${UUIDS[0]}> ${item.executablePath}`,
      `dyld[1234]: <${UUIDS[1]}> /usr/lib/libSystem.B.dylib`,
      `dyld[1234]: <${UUIDS[2]}> /System/Library/Frameworks/Metal.framework/Versions/A/Metal`,
    ].join("\n");

    const attestation = await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(trace)));
    expect(attestation).toMatchObject({
      evidence: "dynamic-loader",
      dependencyCount: 0,
      dependencyBytes: 0,
    });

    await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess("usage: whisper-cli"))), "TRACE_MISSING");
  });

  test("resolves a symlink to a stable physical dependency without putting its target path in identity", async () => {
    const item = await fixture();
    const versionedPath = join(item.root, "libwhisper.1.dylib");
    const linkPath = join(item.root, "libwhisper.dylib");
    await rm(item.whisperPath);
    await writeFile(versionedPath, "whisper-library");
    await symlink(versionedPath, linkPath);

    const attestation = await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item, [linkPath]))));

    expect(attestation.dependencies).toEqual([{
      physicalPath: versionedPath,
      logicalName: "libwhisper.dylib",
      sha256: createHash("sha256").update("whisper-library").digest("hex"),
      bytes: 15,
    }]);
  });

  test("rejects duplicate logical names even when their bytes are identical", async () => {
    const item = await fixture();
    const firstDirectory = join(item.root, "first");
    const secondDirectory = join(item.root, "second");
    await mkdir(firstDirectory);
    await mkdir(secondDirectory);
    const first = join(firstDirectory, "libwhisper.dylib");
    const second = join(secondDirectory, "libwhisper.dylib");
    await writeFile(first, "identical");
    await writeFile(second, "identical");

    const error = await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item, [first, second])))), "DEPENDENCY_AMBIGUOUS");
    expect(error.message).not.toContain(item.root);
  });

  test("rejects missing dependencies, count overflow, process failure, and truncated traces", async () => {
    const item = await fixture();
    const missingPath = join(item.root, "libmissing.dylib");
    await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item, [missingPath])))), "DEPENDENCY_MISSING");

    const excess = Array.from(
      { length: MAX_RUNTIME_DEPENDENCIES + 1 },
      (_, index) => join(item.root, `library-${String(index)}.dylib`),
    );
    await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item, excess)))), "DEPENDENCY_LIMIT");

    const failed: ProcessResult = {
      ok: false,
      reason: "exit",
      diagnostic: `failed at ${item.root}`,
      command: [item.executablePath, "--help"],
      exitCode: 1,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      elapsedMs: 1,
    };
    const failedError = await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(failed)), "TRACE_PROCESS_FAILED");
    expect(failedError.message).not.toContain(item.root);

    const truncated = processSuccess(darwinTrace(item));
    if (!truncated.ok) throw new Error("fixture must be successful");
    await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner({ ...truncated, stderrTruncated: true })), "TRACE_TOO_LARGE");
  });

  test("returns the successful process, accepts truncated stdout, and applies bounded overrides", async () => {
    const item = await fixture();
    const success = processSuccess(darwinTrace(item));
    if (!success.ok) throw new Error("fixture must be successful");
    const controller = new AbortController();
    let observed: RunProcessOptions | undefined;
    const result = await runAttestedRuntimeProcess({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      signal: controller.signal,
      platform: "darwin",
      probeArguments: ["--model", "/absolute/model.bin"],
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 1024 * 1024,
    }, runner({
      ...success,
      stdout: "timed segment output",
      stdoutTruncated: true,
    }, (options) => {
      observed = options;
    }));

    expect(result.process.stdoutTruncated).toBe(true);
    expect(result.attestation.dependencyCount).toBe(2);
    expect(observed?.signal).toBe(controller.signal);
    expect(observed).toMatchObject({
      timeoutMs: 2 * 60 * 60 * 1_000,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
  });

  test("detects a same-byte, same-size executable path replacement during the process", async () => {
    const item = await fixture();
    const replacement = join(item.root, "replacement-whisper-cli");
    const error = await expectRuntimeError(async () => await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item)), async () => {
      await writeFile(replacement, EXECUTABLE_CONTENT, { mode: 0o755 });
      await chmod(replacement, 0o755);
      await rename(replacement, item.executablePath);
    })), "EXECUTABLE_UNSTABLE");
    expect(error.message).not.toContain(item.root);
  });

  test("moves an identical runtime without changing its path-free digest", async () => {
    const first = await fixture("media-runtime-first-");
    const second = await fixture("media-runtime-second-");
    const firstAttestation = await attestRuntimeClosure({
      executablePath: first.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(first))));
    const secondAttestation = await attestRuntimeClosure({
      executablePath: second.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(second))));

    expect(secondAttestation.closureSha256).toBe(firstAttestation.closureSha256);
    expect(sameRuntimeClosure(firstAttestation, secondAttestation)).toBe(false);
    expect(sameRuntimeClosureRecord(firstAttestation, secondAttestation)).toBe(false);

    await writeFile(second.ggmlPath, "changed-bytes");
    const changedAttestation = await attestRuntimeClosure({
      executablePath: second.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(second))));
    expect(changedAttestation.closureSha256).not.toBe(firstAttestation.closureSha256);
    expect(sameRuntimeClosure(firstAttestation, changedAttestation)).toBe(false);
  });

  test("round-trips the exact persisted record and rejects extra or inconsistent fields", async () => {
    const item = await fixture();
    const attestation = await attestRuntimeClosure({
      executablePath: item.executablePath,
      executableSha256: EXECUTABLE_SHA256,
      platform: "darwin",
    }, runner(processSuccess(darwinTrace(item))));
    const record = stripRuntimeClosureRecord(attestation);
    expect(parseRuntimeClosureRecord(JSON.parse(JSON.stringify(record)))).toEqual({
      ok: true,
      record,
    });
    expect(parseRuntimeClosureRecord({ ...record, executionEnvironment: { SECRET: "value" } }))
      .toMatchObject({ ok: false });
    expect(parseRuntimeClosureRecord({ ...record, dependencyBytes: record.dependencyBytes + 1 }))
      .toMatchObject({ ok: false });

    const movedRecord = {
      ...record,
      dependencies: record.dependencies.map((dependency) => ({
        ...dependency,
        physicalPath: `/relocated/${dependency.logicalName}`,
      })),
    };
    const parsedMoved = parseRuntimeClosureRecord(movedRecord);
    expect(parsedMoved.ok).toBe(true);
    if (!parsedMoved.ok) throw new Error("relocated record should be structurally valid");
    expect(parsedMoved.record.closureSha256).toBe(record.closureSha256);
    expect(sameRuntimeClosureRecord(record, parsedMoved.record)).toBe(false);
  });
});

describe("path-free digest", () => {
  test("is order-independent, framed, and sensitive to every semantic field", () => {
    const dependencies = [
      { logicalName: "libwhisper.so", bytes: 10, sha256: "b".repeat(64) },
      { logicalName: "libggml.so", bytes: 20, sha256: "c".repeat(64) },
    ] as const;
    const original = computeRuntimeClosureSha256("linux", "a".repeat(64), dependencies);
    expect(computeRuntimeClosureSha256("linux", "a".repeat(64), [...dependencies].reverse()))
      .toBe(original);
    expect(computeRuntimeClosureSha256("darwin", "a".repeat(64), dependencies)).not.toBe(original);
    expect(computeRuntimeClosureSha256("linux", "d".repeat(64), dependencies)).not.toBe(original);
    expect(computeRuntimeClosureSha256("linux", "a".repeat(64), [
      { ...dependencies[0], bytes: 11 },
      dependencies[1],
    ])).not.toBe(original);
    expect(computeRuntimeClosureSha256("linux", "a".repeat(64), [
      { ...dependencies[0], logicalName: "libwhisper-v2.so" },
      dependencies[1],
    ])).not.toBe(original);
  });

  test("classifies only explicit platform ABI paths as ambient on Linux", () => {
    expect(isPlatformOwnedRuntimePath("/usr/lib/libc.so.6", "linux")).toBe(true);
    expect(isPlatformOwnedRuntimePath("/lib64/ld-linux-x86-64.so.2", "linux")).toBe(true);
    expect(isPlatformOwnedRuntimePath("/usr/lib/libwhisper.so.1", "linux")).toBe(false);
    expect(isPlatformOwnedRuntimePath("/usr/local/lib/libc.so.6", "linux")).toBe(false);
    expect(isPlatformOwnedRuntimePath("/System/Library/Frameworks/Metal.framework/Metal", "darwin"))
      .toBe(true);
    expect(isPlatformOwnedRuntimePath("/opt/homebrew/lib/libwhisper.dylib", "darwin"))
      .toBe(false);
  });
});
