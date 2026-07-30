import {
  afterEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWrenchCliProcess } from "./cli";
import { listRunReceipts } from "./runtime";
import {
  ensurePrivateStateDirectory,
  wrenchStateHome,
} from "./storage";
import { wrenchUsage } from "./usage";

setDefaultTimeout(60_000);

const repositoryRoot = process.cwd();
const cliPath = join(import.meta.dir, "cli.ts");
const localInstallerPath = join(import.meta.dir, "scripts", "install-local.sh");
const sampleCount = 5;
const strictPerformanceBudgets = process.env.WRENCH_STRICT_PERF === "1";
const warmCapabilitiesLimitMilliseconds = strictPerformanceBudgets
  ? 2_500
  : 5_000;
const durableReceiptsLimitMilliseconds = strictPerformanceBudgets
  ? 1_000
  : 2_000;
const warmInstallerLimitMilliseconds = 10_000;
const roots: string[] = [];

type CliMeasurement = {
  readonly elapsedMilliseconds: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `wrench-performance-${label}-`));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function median(values: readonly number[]): number {
  if (values.length === 0 || values.length % 2 === 0) {
    throw new Error("performance samples must contain an odd non-zero count");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.floor(sorted.length / 2)];
  if (value === undefined) throw new Error("performance median is absent");
  return value;
}

function reportMedian(
  label: string,
  values: readonly number[],
  limitMilliseconds: number,
): number {
  const value = median(values);
  if (process.env.WRENCH_PERFORMANCE_REPORT === "1") {
    process.stdout.write(
      `[wrench-performance] ${label}: median ${value.toFixed(2)}ms `
      + `(n=${values.length}, limit=${limitMilliseconds}ms)\n`,
    );
  }
  return value;
}

async function measureCli(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CliMeasurement> {
  const startedAt = performance.now();
  const child = Bun.spawn(
    [process.execPath, cliPath, ...arguments_],
    {
      cwd: repositoryRoot,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    elapsedMilliseconds: performance.now() - startedAt,
    exitCode,
    stderr,
    stdout,
  };
}

async function measureInstaller(
  binDirectory: string,
  stateDirectory: string,
): Promise<CliMeasurement> {
  const startedAt = performance.now();
  const child = Bun.spawn(
    ["/bin/sh", localInstallerPath],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        WRENCH_BIN_DIR: binDirectory,
        WRENCH_BUN: process.execPath,
        WRENCH_STATE_HOME: stateDirectory,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return {
    elapsedMilliseconds: performance.now() - startedAt,
    exitCode,
    stderr,
    stdout,
  };
}

function expectSuccessfulCli(measurement: CliMeasurement): void {
  expect(measurement.exitCode).toBe(0);
  expect(measurement.stderr).toBe("");
}

function runtimeImportDeclarations(source: string): readonly string[] {
  return source.match(/^import\s+(?!type\b)[^;]+;/gmu) ?? [];
}

function receipt(index: number): Readonly<Record<string, unknown>> {
  const runId =
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const startedAt = new Date(
    Date.UTC(2026, 6, 25, 12, 0, 0, index),
  ).toISOString();
  return {
    schemaVersion: 2,
    runId,
    planDigest: null,
    adapter: {
      id: "example",
      version: "1.0.0",
      hash: "a".repeat(64),
    },
    operation: "messaging.send",
    risk: "R1",
    inputHash: "b".repeat(64),
    auth: {
      id: "example",
      hash: "c".repeat(64),
      kind: "cookie-source",
    },
    transport: "browser",
    status: "succeeded",
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
    startedAt,
    finishedAt: startedAt,
    finalOrigin: null,
    error: null,
  };
}

describe("Wrench hardening performance gates", () => {
  test("keeps static help lazy and fast without provider or state initialization", async () => {
    const cliSource = readFileSync(cliPath, "utf8");
    const usageSource = readFileSync(join(import.meta.dir, "usage.ts"), "utf8");
    expect(runtimeImportDeclarations(cliSource)).toEqual([
      'import { wrenchUsage } from "./usage";',
    ]);
    expect(runtimeImportDeclarations(usageSource)).toEqual([]);

    const previousExitCode = process.exitCode;
    let loaderCalls = 0;
    let directOutput = "";
    try {
      await runWrenchCliProcess(
        ["--help"],
        { stdout: (value) => { directOutput += value; } },
        () => {
          loaderCalls += 1;
          return Promise.reject(
            new Error("static help must not load the command/provider graph"),
          );
        },
      );
    } finally {
      process.exitCode = previousExitCode;
    }
    expect(loaderCalls).toBe(0);
    expect(directOutput).toBe(wrenchUsage);

    const statePath = join(privateRoot("help"), "must-remain-absent");
    const environment = { ...process.env, WRENCH_STATE_HOME: statePath };
    const samples: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const measurement = await measureCli(["--help"], environment);
      expectSuccessfulCli(measurement);
      expect(measurement.stdout).toBe(wrenchUsage);
      samples.push(measurement.elapsedMilliseconds);
    }

    expect(existsSync(statePath)).toBeFalse();
    expect(reportMedian("static help", samples, 750)).toBeLessThan(750);
  });

  test("starts a warm capabilities catalog within the CI budget", async () => {
    const statePath = join(privateRoot("capabilities"), "state");
    const environment = { ...process.env, WRENCH_STATE_HOME: statePath };

    const warmup = await measureCli(["capabilities", "--json"], environment);
    expectSuccessfulCli(warmup);

    const samples: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const measurement = await measureCli(
        ["capabilities", "--json"],
        environment,
      );
      expectSuccessfulCli(measurement);
      const payload: unknown = JSON.parse(measurement.stdout);
      if (
        typeof payload !== "object"
        || payload === null
        || Array.isArray(payload)
      ) {
        throw new Error("capabilities output must be an object");
      }
      expect(payload).toMatchObject({ ok: true });
      expect("adapters" in payload && Array.isArray(payload.adapters)).toBeTrue();
      samples.push(measurement.elapsedMilliseconds);
    }

    expect(
      reportMedian(
        "warm capabilities catalog",
        samples,
        warmCapabilitiesLimitMilliseconds,
      ),
    ).toBeLessThan(warmCapabilitiesLimitMilliseconds);
  });

  test("lists 127 durable receipts within the CI budget", () => {
    const statePath = join(privateRoot("receipts"), "state");
    const environment = { ...process.env, WRENCH_STATE_HOME: statePath };
    const runsDirectory = join(wrenchStateHome(environment), "runs");
    ensurePrivateStateDirectory(runsDirectory, environment);
    for (let index = 0; index < 127; index += 1) {
      const value = receipt(index);
      const runId = value.runId;
      if (typeof runId !== "string") throw new Error("fixture run ID is absent");
      writeFileSync(
        join(runsDirectory, `${runId}.json`),
        `${JSON.stringify(value)}\n`,
        { mode: 0o600 },
      );
    }

    const samples: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const startedAt = performance.now();
      const listed = listRunReceipts(environment);
      samples.push(performance.now() - startedAt);
      expect(listed).toHaveLength(127);
      expect(listed.every((value) => "status" in value)).toBeTrue();
    }

    expect(
      reportMedian(
        "127 durable receipts",
        samples,
        durableReceiptsLimitMilliseconds,
      ),
    ).toBeLessThan(durableReceiptsLimitMilliseconds);
  });

  test("keeps a real warm installer no-op within its serial budget", async () => {
    // The aggregate functional suite can execute many subprocess-heavy files
    // concurrently. A strict wall-clock assertion there measures scheduler
    // contention rather than installer regression, so timing belongs only to
    // this dedicated serial performance lane.
    if (!strictPerformanceBudgets || !existsSync(localInstallerPath)) return;

    const root = privateRoot("installer");
    const binDirectory = join(root, "bin");
    const stateDirectory = join(root, "state");
    const cold = await measureInstaller(binDirectory, stateDirectory);
    expectSuccessfulCli(cold);
    expect(cold.stdout).toContain(`Installed wrench at ${join(binDirectory, "wrench")}`);

    const samples: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const warm = await measureInstaller(binDirectory, stateDirectory);
      expectSuccessfulCli(warm);
      expect(warm.stdout).toContain(
        `wrench is already installed at ${join(binDirectory, "wrench")}`,
      );
      samples.push(warm.elapsedMilliseconds);
    }
    expect(
      reportMedian(
        "warm real installer",
        samples,
        warmInstallerLimitMilliseconds,
      ),
    ).toBeLessThan(warmInstallerLimitMilliseconds);
  }, 180_000);
});
