import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoots: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "..");
const trackedNewWorktree = join(
  repositoryRoot,
  "scripts",
  "local-dev",
  "new-worktree",
);
const trackedRunWrench = join(
  repositoryRoot,
  "scripts",
  "local-dev",
  "run-wrench",
);
const trackedLauncher = join(
  repositoryRoot,
  "scripts",
  "local-dev",
  "launch-wrench.ts",
);

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async root => {
    await rm(root, { force: true, recursive: true });
  }));
});

function output(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function git(cwd: string, argv: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...argv], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${argv.join(" ")} failed: ${output(result.stderr)}`);
  }
}

async function createFixtureControl(root: string): Promise<string> {
  const control = join(root, "control");
  await Promise.all([
    mkdir(join(control, "fixture-dependency"), { recursive: true }),
    mkdir(join(control, "scripts", "local-dev"), { recursive: true }),
    mkdir(join(control, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(control, ".gitignore"), "node_modules/\n"),
    writeFile(
      join(control, "package.json"),
      [
        "{",
        '  "name": "wrench-dev-fixture",',
        '  "private": true,',
        '  "dependencies": {',
        '    "fixture-dependency": "file:./fixture-dependency"',
        "  }",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(control, "fixture-dependency", "package.json"),
      '{"name":"fixture-dependency","version":"1.0.0"}\n',
    ),
    writeFile(join(control, "bunfig.toml"), "logLevel = \"error\"\n"),
    writeFile(
      join(control, "tsconfig.json"),
      '{"compilerOptions":{"module":"Preserve","moduleResolution":"Bundler","target":"ESNext"}}\n',
    ),
    writeFile(
      join(control, "src", "cli.ts"),
      [
        "export async function runWrenchCliProcess(argv: string[]): Promise<void> {",
        "  const target = argv[0];",
        '  if (target === undefined) throw new Error("missing output");',
        "  await Bun.write(target, JSON.stringify({",
        "    cwd: process.cwd(),",
        "    io: process.env.IO_HOME,",
        "    media: process.env.WRENCH_MEDIA_HOME,",
        "    oh: process.env.OH_STATE_HOME,",
        "    poison: process.env.WRENCH_CALLER_ENV_POISON,",
        "    runtimeOverrides: [",
        "      process.env.BUN_CONFIG_FILE,",
        "      process.env.BUN_OPTIONS,",
        "      process.env.NODE_OPTIONS,",
        "    ],",
        "    state: process.env.WRENCH_STATE_HOME,",
        "  }));",
        "}",
        "",
      ].join("\n"),
    ),
    writeFile(
      join(control, "scripts", "local-dev", "new-worktree"),
      await readFile(trackedNewWorktree),
      { mode: 0o755 },
    ),
    writeFile(
      join(control, "scripts", "local-dev", "run-wrench"),
      await readFile(trackedRunWrench),
      { mode: 0o755 },
    ),
    writeFile(
      join(control, "scripts", "local-dev", "launch-wrench.ts"),
      await readFile(trackedLauncher),
    ),
  ]);
  git(root, ["init", "-b", "main", control]);
  const install = Bun.spawnSync(["bun", "install", "--ignore-scripts"], {
    cwd: control,
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
      TMPDIR: root,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(`fixture install failed: ${output(install.stderr)}`);
  }
  git(control, ["add", "."]);
  git(control, [
    "-c", "user.name=Wrench Test",
    "-c", "user.email=wrench-test@example.invalid",
    "commit", "-m", "fixture",
  ]);
  return control;
}

test("local-development helpers reject unsafe task names", () => {
  const create = Bun.spawnSync(["sh", trackedNewWorktree, "Bad_Name"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const run = Bun.spawnSync(["sh", trackedRunWrench, "Bad_Name", "doctor"], {
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(create.exitCode).toBe(64);
  expect(run.exitCode).toBe(64);
  expect(output(create.stderr)).toContain("task name must use lowercase letters");
  expect(output(run.stderr)).toContain("task name must use lowercase letters");
});

test("local-development helpers reject relative override roots", () => {
  const create = Bun.spawnSync(["sh", trackedNewWorktree, "devtask"], {
    env: { ...process.env, WRENCH_WORKTREE_ROOT: "relative/worktrees" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const run = Bun.spawnSync(["sh", trackedRunWrench, "devtask", "doctor"], {
    env: { ...process.env, WRENCH_DEV_HOME: "relative/state" },
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(create.exitCode).toBe(64);
  expect(run.exitCode).toBe(64);
  expect(output(create.stderr)).toContain("WRENCH_WORKTREE_ROOT must be an absolute path");
  expect(output(run.stderr)).toContain("WRENCH_DEV_HOME must be an absolute path");
});

test("the worktree runner preserves caller paths and isolates runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrench-local-dev-"));
  temporaryRoots.push(root);
  const control = await createFixtureControl(root);
  const worktreeRoot = join(root, "worktrees");
  const consumer = join(root, "consumer");
  await Promise.all([
    mkdir(worktreeRoot, { recursive: true }),
    mkdir(consumer, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(consumer, "bunfig.toml"), 'preload = ["./untrusted-preload.ts"]\n'),
    writeFile(join(consumer, "untrusted-preload.ts"), 'await Bun.write("preload-ran", "unexpected");\n'),
    writeFile(join(consumer, ".env"), "WRENCH_CALLER_ENV_POISON=loaded\n"),
  ]);
  git(control, [
    "worktree", "add", "-b", "codex/devtask",
    join(worktreeRoot, "devtask"), "HEAD",
  ]);
  const runner = join(control, "scripts", "local-dev", "run-wrench");

  const prohibitedDevHome = `/wrench-local-dev-home-${process.pid}`;
  const directRoot = Bun.spawnSync(["sh", runner, "devtask", "ignored.json"], {
    cwd: consumer,
    env: {
      ...process.env,
      WRENCH_DEV_HOME: prohibitedDevHome,
      WRENCH_WORKTREE_ROOT: worktreeRoot,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(directRoot.exitCode).toBe(64);
  expect(output(directRoot.stderr)).toContain("must be a dedicated directory below the filesystem root");
  expect(await Bun.file(prohibitedDevHome).exists()).toBeFalse();

  const run = Bun.spawnSync(["sh", runner, "devtask", "result.json"], {
    cwd: consumer,
    env: {
      ...process.env,
      BUN_CONFIG_FILE: "/caller/bunfig.toml",
      BUN_OPTIONS: "--caller-option",
      NODE_OPTIONS: "--caller-node-option",
      WRENCH_DEV_HOME: `${join(root, "outer")}/../state/`,
      WRENCH_WORKTREE_ROOT: worktreeRoot,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(run.exitCode).toBe(0);
  expect(output(run.stderr)).toBe("");
  const consumerPhysical = await realpath(consumer);
  const devHomePhysical = await realpath(join(root, "state"));
  expect(JSON.parse(await readFile(join(consumer, "result.json"), "utf8"))).toEqual({
    cwd: consumerPhysical,
    io: join(devHomePhysical, "devtask", "state"),
    media: join(devHomePhysical, "devtask", "media"),
    oh: join(devHomePhysical, "devtask", "state"),
    runtimeOverrides: [null, null, null],
    state: join(devHomePhysical, "devtask", "state"),
  });
  expect(await Bun.file(join(consumer, "preload-ran")).exists()).toBeFalse();
});

test("the worktree creator uses HEAD and rejects root-level targets without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrench-local-dev-create-"));
  temporaryRoots.push(root);
  const control = await createFixtureControl(root);
  const creator = join(control, "scripts", "local-dev", "new-worktree");
  const prohibitedRoot = `/wrench-worktree-root-${process.pid}`;

  const directRoot = Bun.spawnSync(["sh", creator, "unsafe-root"], {
    env: { ...process.env, WRENCH_WORKTREE_ROOT: prohibitedRoot },
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(directRoot.exitCode).toBe(64);
  expect(output(directRoot.stderr)).toContain("must be a dedicated directory below the filesystem root");
  expect(await Bun.file(prohibitedRoot).exists()).toBeFalse();

  const worktreeRoot = join(root, "worktrees");
  const create = Bun.spawnSync(["sh", creator, "devtask"], {
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
      WRENCH_WORKTREE_ROOT: worktreeRoot,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(create.exitCode).toBe(0);
  expect(output(create.stdout)).toContain("branch: codex/devtask");
  const head = Bun.spawnSync(
    ["git", "-C", control, "rev-parse", "HEAD"],
    { stdout: "pipe" },
  );
  expect(head.exitCode).toBe(0);
  expect(output(create.stdout)).toContain(`base: ${output(head.stdout).trim()}`);
  expect(
    await Bun.file(join(worktreeRoot, "devtask", "src", "cli.ts")).exists(),
  ).toBeTrue();
});
