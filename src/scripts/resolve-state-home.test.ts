import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
const resolverPath = join(import.meta.dir, "resolve-state-home.ts");
const runtimeVersion = "0.15.0";

interface ResolverFixture {
  readonly dataRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly root: string;
}

interface ResolverResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): ResolverFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-state-resolver-test-")));
  temporaryDirectories.push(root);
  const dataRoot = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataRoot, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  return {
    dataRoot,
    environment: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      XDG_DATA_HOME: dataRoot,
    },
    root,
  };
}

async function runResolver(
  environment: Readonly<Record<string, string>>,
): Promise<ResolverResult> {
  const child = Bun.spawn(
    [process.execPath, "run", "--no-install", resolverPath, runtimeVersion],
    { env: environment, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("installer state-home resolver", () => {
  test("claims a fresh root, creates the private runtime path, and reopens it", async () => {
    const value = fixture();
    const stateRoot = join(value.dataRoot, "wrench");
    const runtimeRoot = join(stateRoot, "tools", "wacli", runtimeVersion);

    const first = await runResolver(value.environment);
    const second = await runResolver(value.environment);

    expect(first).toEqual({ exitCode: 0, stderr: "", stdout: `${stateRoot}\n` });
    expect(second).toEqual(first);
    expect(readFileSync(join(stateRoot, ".io-state.json"), "utf8"))
      .toBe('{"kind":"io-state","schemaVersion":1}\n');
    for (const directory of [stateRoot, join(stateRoot, "tools"), join(stateRoot, "tools", "wacli"), runtimeRoot]) {
      const metadata = lstatSync(directory);
      expect(metadata.isDirectory()).toBeTrue();
      expect(metadata.isSymbolicLink()).toBeFalse();
      expect(metadata.mode & 0o777).toBe(0o700);
    }
  });

  test("continues each lone populated predecessor root without rewriting its data", async () => {
    for (const name of ["oh", "io"] as const) {
      const value = fixture();
      const legacyRoot = join(value.dataRoot, name);
      const plans = join(legacyRoot, "plans");
      mkdirSync(plans, { recursive: true, mode: 0o700 });
      chmodSync(legacyRoot, 0o700);
      writeFileSync(join(plans, "legacy.json"), '{"legacy":true}\n', { mode: 0o600 });

      const result = await runResolver(value.environment);

      expect(result).toEqual({ exitCode: 0, stderr: "", stdout: `${legacyRoot}\n` });
      expect(readFileSync(join(plans, "legacy.json"), "utf8")).toBe('{"legacy":true}\n');
      expect(readFileSync(join(legacyRoot, ".io-state.json"), "utf8"))
        .toBe('{"kind":"io-state","schemaVersion":1}\n');
    }
  });

  test("recovers a private tools-only predecessor root and preserves its runtime", async () => {
    const value = fixture();
    const legacyRoot = join(value.dataRoot, "oh");
    const runtimeRoot = join(legacyRoot, "tools", "wacli", runtimeVersion);
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    for (const directory of [legacyRoot, join(legacyRoot, "tools"), join(legacyRoot, "tools", "wacli"), runtimeRoot]) {
      chmodSync(directory, 0o700);
    }
    const binary = join(runtimeRoot, "wacli");
    writeFileSync(binary, "preserved runtime\n", { mode: 0o700 });

    const first = await runResolver(value.environment);
    const second = await runResolver(value.environment);

    expect(first).toEqual({ exitCode: 0, stderr: "", stdout: `${legacyRoot}\n` });
    expect(second).toEqual(first);
    expect(readFileSync(binary, "utf8")).toBe("preserved runtime\n");
    expect(readFileSync(join(legacyRoot, ".io-state.json"), "utf8"))
      .toBe('{"kind":"io-state","schemaVersion":1}\n');
  });

  test("rejects unsafe tools-only predecessor roots before claiming them", async () => {
    const linked = fixture();
    const linkedRoot = join(linked.dataRoot, "oh");
    const referent = join(linked.root, "referent");
    mkdirSync(linkedRoot, { mode: 0o700 });
    mkdirSync(referent, { mode: 0o700 });
    symlinkSync(referent, join(linkedRoot, "tools"));

    const linkedResult = await runResolver(linked.environment);

    expect(linkedResult.exitCode).toBe(1);
    expect(linkedResult.stdout).toBe("");
    expect(linkedResult.stderr).toContain("symbolic link");
    expect(existsSync(join(linkedRoot, ".io-state.json"))).toBeFalse();
    expect(readdirSync(referent)).toEqual([]);

    const loose = fixture();
    const looseRoot = join(loose.dataRoot, "io");
    mkdirSync(join(looseRoot, "tools"), { recursive: true, mode: 0o755 });
    chmodSync(looseRoot, 0o700);
    chmodSync(join(looseRoot, "tools"), 0o755);

    const looseResult = await runResolver(loose.environment);

    expect(looseResult.exitCode).toBe(1);
    expect(looseResult.stdout).toBe("");
    expect(looseResult.stderr).toContain("not owned and private");
    expect(existsSync(join(looseRoot, ".io-state.json"))).toBeFalse();
    expect(lstatSync(join(looseRoot, "tools")).mode & 0o777).toBe(0o755);
  });

  test("fails closed without mutation when current and predecessor defaults coexist", async () => {
    const value = fixture();
    const currentRoot = join(value.dataRoot, "wrench");
    const legacyRoot = join(value.dataRoot, "oh");
    mkdirSync(currentRoot, { mode: 0o700 });
    mkdirSync(legacyRoot, { mode: 0o700 });
    const before = readdirSync(value.dataRoot).sort();

    const result = await runResolver(value.environment);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("multiple Wrench and legacy state roots exist");
    expect(readdirSync(value.dataRoot).sort()).toEqual(before);
    expect(readdirSync(currentRoot)).toEqual([]);
    expect(readdirSync(legacyRoot)).toEqual([]);
  });

  test("accepts matching predecessor overrides and rejects divergent overrides", async () => {
    const value = fixture();
    const selected = join(value.root, "selected-wrench-state");
    const other = join(value.root, "other-wrench-state");

    const divergent = await runResolver({
      ...value.environment,
      IO_HOME: other,
      OH_STATE_HOME: selected,
    });
    expect(divergent.exitCode).toBe(1);
    expect(divergent.stdout).toBe("");
    expect(divergent.stderr).toContain("OH_STATE_HOME, IO_HOME select different state roots");
    expect(existsSync(selected)).toBeFalse();
    expect(existsSync(other)).toBeFalse();

    const matching = await runResolver({
      ...value.environment,
      IO_HOME: selected,
      OH_STATE_HOME: selected,
      WRENCH_STATE_HOME: selected,
    });
    expect(matching).toEqual({ exitCode: 0, stderr: "", stdout: `${selected}\n` });
    expect(readFileSync(join(selected, ".io-state.json"), "utf8"))
      .toBe('{"kind":"io-state","schemaVersion":1}\n');
  });
});
