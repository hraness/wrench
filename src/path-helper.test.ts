import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { removePrivateDirectoryTree } from "./storage";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const helperPath = join(sourceDirectory, "path-helper.ts");
const helperConfigPath = join(sourceDirectory, "state-helper.bunfig.toml");

type Identity = {
  readonly device: string;
  readonly inode: string;
};

function identity(stats: BigIntStats): Identity {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  };
}

function fileExpectation(stats: BigIntStats) {
  return {
    identity: identity(stats),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

function runHelper(
  root: string,
  expected: Identity,
  operation: Readonly<Record<string, unknown>>,
  environment: Readonly<Record<string, string>> = {},
) {
  return spawnSync(process.execPath, [
    "--no-env-file",
    "--no-install",
    "--no-macros",
    "--no-addons",
    `--config=${helperConfigPath}`,
    helperPath,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { NODE_ENV: "test", ...environment },
    input: JSON.stringify({
      schemaVersion: 1,
      requestId: randomUUID(),
      expected,
      operation,
    }),
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
}

describe("bound path helper traversal", () => {
  test("recovers an identity-bound recursive-removal quarantine after SIGKILL", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-remove-recovery-"));
    try {
      const parent = join(root, "parent");
      const target = join(parent, "target");
      mkdirSync(parent, { mode: 0o755 });
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, "secret.txt"), "sensitive");
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const expectedParent = identity(lstatSync(parent, { bigint: true }));
      const expectedTarget = identity(lstatSync(target, { bigint: true }));
      const request = JSON.stringify({
        schemaVersion: 1,
        requestId: randomUUID(),
        expected: expectedRoot,
        operation: {
          kind: "remove-directory-tree",
          segments: ["parent", "target"],
          directoryExpectations: [expectedParent, expectedTarget],
        },
      });
      const child = Bun.spawn([
        process.execPath,
        "--no-env-file",
        "--no-install",
        "--no-macros",
        "--no-addons",
        `--config=${helperConfigPath}`,
        helperPath,
      ], {
        cwd: root,
        env: {
          NODE_ENV: "test",
          WRENCH_TEST_REMOVE_DIRECTORY_FAULT: "pause-after-quarantine-fsync",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await child.stdin.write(request);
      await child.stdin.end();
      let quarantineName: string | undefined;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        quarantineName = readdirSync(parent).find((name) =>
          name.startsWith(`.io-remove-${child.pid}-`));
        if (quarantineName !== undefined) break;
        await Bun.sleep(10);
      }
      expect(quarantineName).toBeDefined();
      expect(readdirSync(parent)).not.toContain("target");
      child.kill("SIGKILL");
      await child.exited;

      expect(removePrivateDirectoryTree(target, expectedTarget)).toBe(true);
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("refuses an exact recursive-removal quarantine owned by a live helper", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-remove-live-"));
    try {
      const parent = join(root, "parent");
      const target = join(parent, "target");
      mkdirSync(parent, { mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const expectedParent = identity(lstatSync(parent, { bigint: true }));
      const expectedTarget = identity(lstatSync(target, { bigint: true }));
      const quarantineName =
        `.io-remove-${process.pid}-11111111-1111-4111-8111-111111111111.quarantine`;
      renameSync(target, join(parent, quarantineName));

      const rejected = runHelper(root, expectedRoot, {
        kind: "remove-directory-tree",
        segments: ["parent", "target"],
        directoryExpectations: [expectedParent, expectedTarget],
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "recursive removal quarantine owner is live or cannot be proven dead",
      );
      expect(readdirSync(parent)).toContain(quarantineName);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not remove a wrong-identity recursive-removal quarantine", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-remove-wrong-"));
    try {
      const parent = join(root, "parent");
      const target = join(parent, "target");
      mkdirSync(parent, { mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const expectedParent = identity(lstatSync(parent, { bigint: true }));
      const expectedTarget = identity(lstatSync(target, { bigint: true }));
      const quarantineName =
        ".io-remove-2147483647-22222222-2222-4222-8222-222222222222.quarantine";
      const quarantine = join(parent, quarantineName);
      mkdirSync(quarantine, { mode: 0o700 });
      expect(identity(lstatSync(quarantine, { bigint: true }))).not.toEqual(
        expectedTarget,
      );
      rmSync(target, { recursive: true });

      const ignored = runHelper(root, expectedRoot, {
        kind: "remove-directory-tree",
        segments: ["parent", "target"],
        directoryExpectations: [expectedParent, expectedTarget],
      });
      expect(ignored.status).toBe(0);
      expect(JSON.parse(ignored.stdout)).toMatchObject({
        ok: true,
        removed: false,
      });
      expect(readdirSync(parent)).toContain(quarantineName);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when recursive-removal recovery exceeds its scan bound", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-remove-bound-"));
    try {
      const parent = join(root, "parent");
      const target = join(parent, "target");
      mkdirSync(parent, { mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const expectedParent = identity(lstatSync(parent, { bigint: true }));
      const expectedTarget = identity(lstatSync(target, { bigint: true }));
      rmSync(target, { recursive: true });
      writeFileSync(join(parent, "one"), "1");
      writeFileSync(join(parent, "two"), "2");

      const rejected = runHelper(
        root,
        expectedRoot,
        {
          kind: "remove-directory-tree",
          segments: ["parent", "target"],
          directoryExpectations: [expectedParent, expectedTarget],
        },
        { WRENCH_TEST_REMOVE_QUARANTINE_SCAN_MAXIMUM: "1" },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "recursive removal recovery exceeds its 1 entry bound",
      );
      expect(readdirSync(parent).sort()).toEqual(["one", "two"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recovers only definitely orphaned atomic-write temporaries after SIGKILL", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-temp-recovery-"));
    try {
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const request = JSON.stringify({
        schemaVersion: 1,
        requestId: randomUUID(),
        expected: expectedRoot,
        operation: {
          kind: "write-file",
          segments: ["target.txt"],
          directoryExpectations: [],
          content: "never published",
          createOnly: false,
        },
      });
      const child = Bun.spawn([
        process.execPath,
        "--no-env-file",
        "--no-install",
        "--no-macros",
        "--no-addons",
        `--config=${helperConfigPath}`,
        helperPath,
      ], {
        cwd: root,
        env: {
          NODE_ENV: "test",
          WRENCH_TEST_WRITE_TEMP_FAULT: "pause-after-temp-fsync",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await child.stdin.write(request);
      await child.stdin.end();
      let staleName: string | undefined;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        staleName = readdirSync(root).find((name) =>
          name.startsWith(`.io-write-${child.pid}-`));
        if (staleName !== undefined) break;
        await Bun.sleep(10);
      }
      expect(staleName).toBeDefined();
      child.kill("SIGKILL");
      await child.exited;

      const liveName =
        `.io-write-${process.pid}-11111111-1111-4111-8111-111111111111.tmp`;
      writeFileSync(join(root, liveName), "live owner", { mode: 0o600 });
      const listed = runHelper(root, expectedRoot, {
        kind: "list-directory",
        segments: [],
        directoryExpectations: [],
        maximumEntries: 8,
      });
      expect(listed.status).toBe(0);
      const names = readdirSync(root);
      expect(names).not.toContain(staleName as string);
      expect(names).toContain(liveName);
      expect(names).not.toContain("target.txt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("lists one inode-bound directory and rejects a replaced ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-list-"));
    try {
      const nested = join(root, "nested");
      mkdirSync(nested);
      writeFileSync(join(nested, "one.txt"), "one");
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const expectedNested = identity(lstatSync(nested, { bigint: true }));
      const operation = {
        kind: "list-directory",
        segments: ["nested"],
        directoryExpectations: [expectedNested],
        maximumEntries: 8,
      } as const;

      const listed = runHelper(root, expectedRoot, operation);
      expect(listed.status).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        ok: true,
        identity: expectedRoot,
        targetIdentity: expectedNested,
        entries: [{
          name: "one.txt",
          kind: "file",
        }],
      });

      renameSync(nested, join(root, "original"));
      mkdirSync(nested);
      writeFileSync(join(nested, "two.txt"), "two");
      const rejected = runHelper(root, expectedRoot, operation);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "directory path no longer matches its validated identity",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stops before returning more entries than requested", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-bound-"));
    try {
      writeFileSync(join(root, "one.txt"), "one");
      writeFileSync(join(root, "two.txt"), "two");
      const rejected = runHelper(
        root,
        identity(lstatSync(root, { bigint: true })),
        {
          kind: "list-directory",
          segments: [],
          directoryExpectations: [],
          maximumEntries: 1,
        },
      );
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("directory exceeds its 1 entry bound");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a regular leaf replaced after its identity was captured", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-leaf-"));
    try {
      const target = join(root, "target.txt");
      writeFileSync(target, "original");
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const expectedFile = fileExpectation(lstatSync(target, { bigint: true }));
      const operation = {
        kind: "read-file",
        segments: ["target.txt"],
        directoryExpectations: [],
        maximumBytes: 1024,
        fileExpectation: expectedFile,
      } as const;
      const read = runHelper(root, expectedRoot, operation);
      expect(read.status).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({
        ok: true,
        identity: expectedRoot,
        contentBase64: Buffer.from("original").toString("base64"),
      });

      renameSync(target, join(root, "original.txt"));
      writeFileSync(target, "replacement");
      const rejected = runHelper(root, expectedRoot, operation);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        "read target no longer matches its validated file identity",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshots prefix-colliding paths and batch-reads bound leaves", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-path-helper-tree-"));
    try {
      const nested = join(root, "a");
      const nestedFile = join(nested, "x.txt");
      const rootFile = join(root, "a.txt");
      mkdirSync(nested);
      writeFileSync(nestedFile, "nested");
      writeFileSync(rootFile, "root");
      const expectedRoot = identity(lstatSync(root, { bigint: true }));
      const expectedNested = identity(lstatSync(nested, { bigint: true }));

      const snapshotted = runHelper(root, expectedRoot, {
        kind: "snapshot-tree",
        maximumEntries: 8,
        maximumDirectories: 2,
        maximumDepth: 2,
        maximumPathBytes: 128,
      });
      expect(snapshotted.status).toBe(0);
      const snapshot = JSON.parse(snapshotted.stdout) as {
        readonly treeEntries: readonly { readonly path: string }[];
      };
      expect(snapshot.treeEntries.map((entry) => entry.path)).toEqual([
        "a",
        "a.txt",
        "a/x.txt",
      ]);

      const read = runHelper(root, expectedRoot, {
        kind: "batch-read-files",
        files: [
          {
            segments: ["a", "x.txt"],
            directoryExpectations: [expectedNested],
            maximumBytes: 16,
            fileExpectation: fileExpectation(
              lstatSync(nestedFile, { bigint: true }),
            ),
          },
          {
            segments: ["a.txt"],
            directoryExpectations: [],
            maximumBytes: 16,
            fileExpectation: fileExpectation(
              lstatSync(rootFile, { bigint: true }),
            ),
          },
        ],
        maximumTotalBytes: 16,
      });
      expect(read.status).toBe(0);
      expect(JSON.parse(read.stdout)).toMatchObject({
        ok: true,
        identity: expectedRoot,
        fileContentsBase64: [
          Buffer.from("nested").toString("base64"),
          Buffer.from("root").toString("base64"),
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
