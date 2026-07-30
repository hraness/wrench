import {
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isImmediateWrenchHelpRequest,
  isPublicWrenchCommand,
  routedWrenchCatalogCommand,
  runWrenchCliProcess,
} from "./cli";
import { wrenchUsage } from "./usage";

const repositoryRoot = process.cwd();
const sourcePackageRoot = join(import.meta.dir, "..");
const cliPath = join(import.meta.dir, "cli.ts");
const wrenchPath = join(import.meta.dir, "wrench.ts");

function exactPathPattern(path: string): string {
  return `^${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
}

setDefaultTimeout(60_000);

type ProcessResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

async function runProcess(
  entrypoint: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ProcessResult> {
  const child = Bun.spawn([
    process.execPath,
    entrypoint,
    ...arguments_,
  ], {
    cwd: repositoryRoot,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("lazy wrench CLI entrypoint", () => {
  test("renders every valid top-level help spelling without loading wrench.ts", async () => {
    const previousExitCode = process.exitCode;
    try {
      for (const rawArguments of [[], ["help"], ["--help"], ["-h"]]) {
        let loaded = 0;
        let stdout = "";
        await runWrenchCliProcess(
          rawArguments,
          { stdout: (value) => { stdout += value; } },
          () => {
            loaded += 1;
            throw new Error("the full CLI graph must stay lazy for help");
          },
        );
        expect(stdout).toBe(wrenchUsage);
        expect(loaded).toBe(0);
      }
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("routes top-level and compatibility doctor commands to the combined process boundary", async () => {
    const previousExitCode = process.exitCode;
    try {
      let runs = 0;
      const received: string[][] = [];
      for (const rawArguments of [
        ["doctor", "--json"],
        ["operator", "doctor", "--json"],
      ]) {
        await runWrenchCliProcess(
          rawArguments,
          { stdout: () => undefined },
          () => Promise.resolve({
            runWrenchProcess: (overrides) => {
              runs += 1;
              received.push([...(overrides?.rawArguments ?? [])]);
              return Promise.resolve();
            },
          }),
          () => {
            throw new Error("doctor must not load the catalog-only graph");
          },
          () => {
            throw new Error("doctor must not route to the KB-only diagnostics");
          },
        );
      }
      expect(runs).toBe(2);
      expect(received).toEqual([
        ["doctor", "--json"],
        ["doctor", "--json"],
      ]);
      expect(isImmediateWrenchHelpRequest(["help", "extra"])).toBeFalse();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("routes public knowledge commands without loading private provider graphs", async () => {
    const previousExitCode = process.exitCode;
    try {
      let publicLoads = 0;
      let received: readonly string[] = [];
      await runWrenchCliProcess(
        ["adapters", "--json"],
        { stdout: () => undefined, stderr: () => undefined },
        () => {
          throw new Error("public commands must not load the provider runtime");
        },
        () => {
          throw new Error("public commands must not load the provider catalog");
        },
        () => {
          publicLoads += 1;
          return Promise.resolve({
            main: (raw) => {
              received = raw ?? [];
              return Promise.resolve(6);
            },
          });
        },
      );
      expect(publicLoads).toBe(1);
      expect(received).toEqual(["adapters", "--json"]);
      expect(process.exitCode).toBe(6);
      expect(isPublicWrenchCommand(["doctor"])).toBeFalse();
      expect(isPublicWrenchCommand(["inspect"])).toBeFalse();
      expect(isPublicWrenchCommand(["operator", "doctor"])).toBeFalse();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("routes only complete capabilities and plugin inspection shapes", async () => {
    expect(routedWrenchCatalogCommand(["capabilities", "--json"])).toEqual({
      command: "capabilities",
      json: true,
    });
    expect(routedWrenchCatalogCommand(["adapters", "example", "--json"])).toBeNull();
    expect(routedWrenchCatalogCommand(["plugins", "list"])).toEqual({
      command: "plugin-list",
      json: false,
    });
    expect(routedWrenchCatalogCommand([
      "plugin",
      "show",
      "x-official",
      "--json",
    ])).toEqual({
      command: "plugin-show",
      id: "x-official",
      json: true,
    });
    for (const arguments_ of [
      ["capabilities", "--unknown"],
      ["capabilities", "--json", "--json"],
      ["plugin", "show", "Not-Kebab"],
      ["plugin", "list", "extra"],
      ["plugin", "doctor", "--json"],
    ]) {
      expect(routedWrenchCatalogCommand(arguments_)).toBeNull();
    }

    const previousExitCode = process.exitCode;
    try {
      let processLoads = 0;
      let catalogLoads = 0;
      let routedCommand: unknown;
      await runWrenchCliProcess(
        ["plugin", "list", "--json"],
        { stdout: () => undefined },
        () => {
          processLoads += 1;
          throw new Error("catalog inspection must not load wrench.ts");
        },
        () => {
          catalogLoads += 1;
          return Promise.resolve({
            runWrenchCatalogCommand: (command) => {
              routedCommand = command;
              return Promise.resolve(7);
            },
          });
        },
      );
      expect(processLoads).toBe(0);
      expect(catalogLoads).toBe(1);
      expect(routedCommand).toEqual({
        command: "plugin-list",
        json: true,
      });
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  test("preserves exact canonical output and exit codes for routed commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-catalog-parity-"));
    chmodSync(root, 0o700);
    try {
      const commands = [
        ["capabilities", "--json"],
        ["plugin", "list", "--json"],
        ["plugin", "show", "x-official", "--json"],
        ["plugin", "show", "missing-plugin", "--json"],
      ] as const;
      const parityEntrypoint = join(root, "catalog-parity.ts");
      writeFileSync(
        parityEntrypoint,
        `import { join } from "node:path";

const commands = ${JSON.stringify(commands)};
const stateRoot = ${JSON.stringify(root)};
const { runWrenchCliProcess } = await import(${JSON.stringify(cliPath)});
const { runWrenchProcess } = await import(${JSON.stringify(wrenchPath)});
const previousExitCode = process.exitCode;
const previousStateHome = process.env.WRENCH_STATE_HOME;
const results = [];
try {
  for (const [index, arguments_] of commands.entries()) {
    let stdout = "";
    let stderr = "";
    process.env.WRENCH_STATE_HOME = join(stateRoot, "routed-state-" + index);
    process.exitCode = 0;
    await runWrenchCliProcess(arguments_, {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    const routed = {
      exitCode: process.exitCode ?? 0,
      stderr,
      stdout,
    };

    stdout = "";
    stderr = "";
    let canonicalExitCode;
    process.env.WRENCH_STATE_HOME = join(stateRoot, "canonical-state-" + index);
    process.exitCode = 0;
    await runWrenchProcess({
      rawArguments: arguments_,
      environment: process.env,
      output: {
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      },
      setExitCode: (value) => { canonicalExitCode = value; },
    });
    if (canonicalExitCode === undefined) {
      throw new Error("canonical Wrench process did not publish an exit code");
    }
    results.push({
      arguments: arguments_,
      canonical: { exitCode: canonicalExitCode, stderr, stdout },
      routed,
    });
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  process.exitCode = previousExitCode ?? 0;
  if (previousStateHome === undefined) delete process.env.WRENCH_STATE_HOME;
  else process.env.WRENCH_STATE_HOME = previousStateHome;
}
`,
        { mode: 0o600 },
      );

      // Load both implementations once, then run every case serially with
      // independent state roots. The routing and loader tests around this one
      // prove the entrypoint boundary; this process proves exact canonical
      // output and exit parity without eight competing cold Bun loaders.
      const child = await runProcess(
        parityEntrypoint,
        [],
        process.env,
      );
      expect(child.exitCode).toBe(0);
      expect(child.stderr).toBe("");
      const results: unknown = JSON.parse(child.stdout);
      if (!Array.isArray(results)) {
        throw new Error("catalog parity child returned a non-array result");
      }
      const parityResults: readonly unknown[] = results;
      expect(parityResults).toHaveLength(commands.length);
      for (const [index, result] of parityResults.entries()) {
        if (
          typeof result !== "object"
          || result === null
          || !("arguments" in result)
          || !("canonical" in result)
          || !("routed" in result)
        ) {
          throw new Error("catalog parity child returned a malformed result");
        }
        const arguments_ = commands[index]!;
        expect(result.arguments, arguments_.join(" ")).toEqual(arguments_);
        expect(result.routed, arguments_.join(" ")).toEqual(result.canonical);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routed commands never load Mine, capture, browser, or derive graphs", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-loader-sentinel-"));
    chmodSync(root, 0o700);
    try {
      const forbiddenGraphs = [
        {
          id: "mine",
          path: realpathSync(fileURLToPath(import.meta.resolve("@hraness/mine"))),
        },
        {
          id: "kb-capture",
          path: realpathSync(
            fileURLToPath(import.meta.resolve("@hraness/kb/capture")),
          ),
        },
        {
          id: "browser",
          path: realpathSync(
            fileURLToPath(import.meta.resolve("./browser.ts")),
          ),
        },
        {
          id: "derive",
          path: realpathSync(
            fileURLToPath(import.meta.resolve("./derive.ts")),
          ),
        },
      ].map((entry) => ({
        ...entry,
        source: exactPathPattern(entry.path),
      }));
      const forbiddenSource = forbiddenGraphs
        .map(({ source }) => `(?:${source})`)
        .join("|");
      const forbidden = new RegExp(forbiddenSource, "u");
      for (const forbiddenGraph of forbiddenGraphs) {
        expect(forbidden.test(forbiddenGraph.path), forbiddenGraph.id).toBeTrue();
      }

      const sentinelEntrypoint = join(root, "module-sentinel.ts");
      writeFileSync(
        sentinelEntrypoint,
        `const forbidden = new RegExp(${JSON.stringify(forbiddenSource)}, "u");
Bun.plugin({
  name: "wrench-private-module-sentinel",
  setup(build) {
    build.onLoad({ filter: forbidden }, ({ path }) => {
      throw new Error(\`forbidden eager Wrench module loaded: \${path}\`);
    });
  },
});
const { runWrenchCliProcess } = await import(${JSON.stringify(cliPath)});
const output = { stdout: () => undefined, stderr: () => undefined };
await runWrenchCliProcess(["plugin", "show", "x-official", "--json"], output);
if (process.exitCode !== 0) {
  throw new Error("routed catalog command failed before the loader sentinel completed");
}
console.error("routed catalog graph stayed isolated");
await runWrenchCliProcess(["operator", "doctor", "--json"], output);
throw new Error("private fallback did not load a forbidden module");
`,
        { mode: 0o600 },
      );
      // Every routed shape shares the eager catalog graph; plugin show also
      // loads the portable lifecycle graph used by plugin list, while an empty
      // capabilities state takes a subset. One process therefore proves the
      // boundary, then exercises the private route as a negative control,
      // without multiplying cold Bun loaders in CI.
      const result = await runProcess(
        sentinelEntrypoint,
        [],
        {
          ...process.env,
          WRENCH_STATE_HOME: join(root, "sentinel-state"),
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("routed catalog graph stayed isolated");
      expect(result.stderr)
        .toContain("forbidden eager Wrench module loaded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("has only static help as an eager dependency and starts help quickly", async () => {
    const source = readFileSync(cliPath, "utf8");
    expect(source).toContain('import { wrenchUsage } from "./usage"');
    expect(source).toContain('import("./wrench")');
    expect(source).toContain('import("./catalog-cli")');
    expect(source).not.toContain('from "./wrench"');
    const packageJson = JSON.parse(
      readFileSync(join(sourcePackageRoot, "package.json"), "utf8"),
    ) as { readonly bin?: Readonly<Record<string, string>> };
    expect(packageJson.bin?.wrench).toMatch(/^\.?\/src\/cli\.ts$/u);

    const started = performance.now();
    const child = Bun.spawn([process.execPath, cliPath, "--help"], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const elapsedMilliseconds = performance.now() - started;
    expect(exitCode).toBe(0);
    expect(stdout).toBe(wrenchUsage);
    expect(stderr).toBe("");
    expect(elapsedMilliseconds).toBeLessThan(500);
  });
});
