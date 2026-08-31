import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensurePrivateStateDirectory } from "../storage";

const installer = join(import.meta.dir, "install-telegram-tdlib.sh");
const tdlibVersion = "1.8.67";
const sourceCommit = "d1085f9cebc5a62379991ae1652673954f229c1f";
const implementation = "wrench-telegram-tdlib";
const platform = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const expectedIdentity = JSON.stringify({
  schemaVersion: 1,
  operation: "identity",
  status: "ok",
  implementation,
  tdlibVersion,
  sourceCommit,
});
const roots: string[] = [];

type Fixture = {
  readonly root: string;
  readonly target: string;
  readonly binary: string;
  readonly manifest: string;
  readonly invocationLog: string;
  readonly toolLog: string;
  readonly environment: Record<string, string>;
};

function canonicalManifest(binarySha256: string): string {
  return `${JSON.stringify({
    arch,
    binaryFile: implementation,
    binarySha256,
    implementation,
    platform,
    protocolVersion: 1,
    schemaVersion: 1,
    sourceCommit,
    tdlibVersion,
  })}\n`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-telegram-installer-test-")));
  chmodSync(root, 0o700);
  roots.push(root);

  const stateHome = join(root, "wrench-state");
  const parent = join(stateHome, "tools", "telegram-tdlib", tdlibVersion, sourceCommit);
  ensurePrivateStateDirectory(parent, {
    ...process.env,
    WRENCH_STATE_HOME: stateHome,
    OH_STATE_HOME: "",
    IO_HOME: "",
  });

  const target = join(parent, `${platform}-${arch}`);
  mkdirSync(target, { mode: 0o700 });
  const binary = join(target, implementation);
  const manifest = join(target, "install-manifest.json");
  const invocationLog = join(root, "helper-invocations");
  const toolLog = join(root, "build-tool-invocations");
  const helper = `#!/bin/sh\nIFS= read -r request || exit 91\n[ "$request" = '${JSON.stringify({ schemaVersion: 1, operation: "identity" })}' ] || exit 92\nprintf '%s\\n' ${shellSingleQuote(expectedIdentity)}\nprintf '%s\\n' invoked >> ${shellSingleQuote(invocationLog)}\n`;
  writeFileSync(binary, helper, { mode: 0o500 });
  chmodSync(binary, 0o500);
  const digest = createHash("sha256").update(helper).digest("hex");
  writeFileSync(manifest, canonicalManifest(digest), { mode: 0o400 });
  chmodSync(manifest, 0o400);

  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { mode: 0o700 });
  for (const name of ["git", "cmake", "make", "c++", "gperf"]) {
    const command = join(fakeBin, name);
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s\\n' ${shellSingleQuote(name)} >> ${shellSingleQuote(toolLog)}\nexit 97\n`,
      { mode: 0o500 },
    );
    chmodSync(command, 0o500);
  }

  const unusableTemporaryParent = join(root, "tmp-is-a-file");
  writeFileSync(unusableTemporaryParent, "the existing-install path must not reach mktemp\n", {
    mode: 0o400,
  });
  chmodSync(unusableTemporaryParent, 0o400);

  return {
    root,
    target,
    binary,
    manifest,
    invocationLog,
    toolLog,
    environment: {
      ...process.env,
      WRENCH_STATE_HOME: stateHome,
      OH_STATE_HOME: "",
      IO_HOME: "",
      WRENCH_BUN: process.execPath,
      TMPDIR: unusableTemporaryParent,
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  };
}

function runInstaller(fixture: Fixture): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = Bun.spawnSync(["/bin/sh", installer], {
    cwd: import.meta.dir,
    env: fixture.environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

function expectNoBuild(fixture: Fixture): void {
  expect(existsSync(fixture.toolLog)).toBe(false);
  expect(readdirSync(fixture.target).sort()).toEqual([
    "install-manifest.json",
    implementation,
  ]);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Telegram TDLib installer existing-install fast path", () => {
  test("accepts the canonical manifest, binary digest, and embedded identity", () => {
    const fixture = makeFixture();

    const result = runInstaller(fixture);

    expect(result).toEqual({
      exitCode: 0,
      stdout: `Pinned Telegram TDLib helper is already installed at ${fixture.target}\n`,
      stderr: "",
    });
    expect(readFileSync(fixture.invocationLog, "utf8")).toBe("invoked\n");
    expectNoBuild(fixture);
  });

  test.each([
    ["noncanonical manifest", (fixture: Fixture) => {
      const value = JSON.parse(readFileSync(fixture.manifest, "utf8")) as unknown;
      chmodSync(fixture.manifest, 0o600);
      writeFileSync(fixture.manifest, `${JSON.stringify(value, null, 2)}\n`);
      chmodSync(fixture.manifest, 0o400);
    }],
    ["wrong binary mode", (fixture: Fixture) => chmodSync(fixture.binary, 0o700)],
    ["hard-linked binary", (fixture: Fixture) => linkSync(fixture.binary, join(fixture.root, "binary-link"))],
    ["symbolic-link binary", (fixture: Fixture) => {
      const referent = join(fixture.root, "binary-referent");
      writeFileSync(referent, readFileSync(fixture.binary), { mode: 0o500 });
      chmodSync(referent, 0o500);
      unlinkSync(fixture.binary);
      symlinkSync(referent, fixture.binary);
    }],
  ])("rejects %s before helper or build execution", (_label, mutate) => {
    const fixture = makeFixture();
    mutate(fixture);

    const result = runInstaller(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("existing Telegram helper did not pass strict runtime-equivalent validation");
    expect(result.stderr).not.toContain("temporary parent is unavailable");
    expect(existsSync(fixture.invocationLog)).toBe(false);
    expectNoBuild(fixture);
  });
});
