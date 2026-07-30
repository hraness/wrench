import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_PRIVATE_STATE_BATCH_FILE_BYTES,
  MAX_PRIVATE_STATE_BATCH_FILES,
  MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES,
  ensurePrivateStateDirectory,
  wrenchStateHome,
  readPrivateStateChildFilesBatch,
  readPrivateStateFilesBatch,
  type PrivateDirectoryIdentity,
} from "./storage";

type TestState = {
  readonly root: string;
  readonly directory: string;
  readonly identity: PrivateDirectoryIdentity;
  readonly environment: Readonly<Record<string, string | undefined>>;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function state(): TestState {
  const root = mkdtempSync(join(tmpdir(), "wrench-storage-batch-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const environment = { ...process.env, WRENCH_STATE_HOME: root };
  const canonicalRoot = wrenchStateHome(environment);
  const directory = join(canonicalRoot, "runs");
  const identity = ensurePrivateStateDirectory(directory, environment);
  return { root: canonicalRoot, directory, identity, environment };
}

function writePrivate(
  directory: string,
  name: string,
  content: string | Uint8Array,
): void {
  writeFileSync(join(directory, name), content, { mode: 0o600 });
}

function readBatch(
  testState: TestState,
  names: readonly string[],
  overrides: Partial<{
    readonly maximumBytesPerFile: number;
    readonly maximumTotalBytes: number;
    readonly expectedDirectoryIdentity: PrivateDirectoryIdentity;
    readonly faultForTest:
      | "malformed-response"
      | "remove-first-file-after-open"
      | "replace-first-file-after-open"
      | "replace-first-child-after-bind"
      | "replace-directory-after-bind";
  }> = {},
) {
  return readPrivateStateFilesBatch(testState.directory, names, {
    maximumBytesPerFile: overrides.maximumBytesPerFile ?? 4 * 1024,
    maximumTotalBytes: overrides.maximumTotalBytes ?? 512 * 1024,
    environment: testState.environment,
    expectedDirectoryIdentity:
      overrides.expectedDirectoryIdentity ?? testState.identity,
    ...(overrides.faultForTest === undefined
      ? {}
      : { faultForTest: overrides.faultForTest }),
  });
}

describe("bounded private state batch reads", () => {
  test("reads zero and one file through an exact identity-bound directory", () => {
    const testState = state();
    writePrivate(testState.directory, "one.json", '{"value":"雪"}\n');

    expect(readBatch(testState, [])).toEqual([]);
    expect(readBatch(testState, ["one.json"])).toEqual([{
      name: "one.json",
      status: "present",
      content: '{"value":"雪"}\n',
    }]);
  });

  test("returns 100 files in caller order from one helper response", () => {
    const testState = state();
    const names = Array.from(
      { length: 100 },
      (_unused, index) => `run-${String(index).padStart(3, "0")}.json`,
    );
    for (const name of names) writePrivate(testState.directory, name, `${name}\n`);
    const requested = [...names].reverse();

    const results = readBatch(testState, requested);
    expect(results).toHaveLength(100);
    expect(results.map(({ name }) => name)).toEqual(requested);
    expect(results.map((result) =>
      result.status === "present" ? result.content : null
    )).toEqual(requested.map((name) => `${name}\n`));
  });

  test("preserves mixed present, absent, invalid UTF-8, and aggregate-bound ordering", () => {
    const testState = state();
    writePrivate(testState.directory, "first", "1234");
    writePrivate(testState.directory, "second", "5678");
    writePrivate(testState.directory, "empty", "");
    writePrivate(testState.directory, "invalid-utf8", Uint8Array.of(0xff));

    expect(readBatch(
      testState,
      ["first", "missing", "second", "empty", "invalid-utf8"],
      { maximumTotalBytes: 5 },
    )).toEqual([
      { name: "first", status: "present", content: "1234" },
      { name: "missing", status: "absent" },
      {
        name: "second",
        status: "invalid",
        reason: "aggregate-byte-bound",
      },
      { name: "empty", status: "present", content: "" },
      { name: "invalid-utf8", status: "invalid", reason: "invalid-utf8" },
    ]);
  });

  test("enforces name, count, per-file, and aggregate request bounds", () => {
    const testState = state();
    writePrivate(testState.directory, "large", "12345");
    expect(readBatch(testState, ["large"], {
      maximumBytesPerFile: 4,
    })).toEqual([{
      name: "large",
      status: "invalid",
      reason: "file-byte-bound",
    }]);

    expect(() => readBatch(
      testState,
      Array.from(
        { length: MAX_PRIVATE_STATE_BATCH_FILES + 1 },
        (_unused, index) => `file-${index}`,
      ),
    )).toThrow("file count");
    expect(() => readBatch(testState, ["duplicate", "duplicate"]))
      .toThrow("must be unique");
    expect(() => readBatch(testState, ["../escape"]))
      .toThrow("invalid file name");
    expect(() => readBatch(testState, ["x".repeat(256)]))
      .toThrow("invalid file name");
    expect(() => readBatch(testState, [], {
      maximumBytesPerFile: MAX_PRIVATE_STATE_BATCH_FILE_BYTES + 1,
    })).toThrow("per-file byte bound");
    expect(() => readBatch(testState, [], {
      maximumTotalBytes: MAX_PRIVATE_STATE_BATCH_TOTAL_BYTES + 1,
    })).toThrow("aggregate byte bound");
  });

  test("returns symlinks, directories, permissive files, and FIFOs as inert invalid entries", () => {
    const testState = state();
    const outside = join(testState.root, "outside");
    writePrivate(testState.root, "outside", "outside secret\n");
    symlinkSync(outside, join(testState.directory, "link"));
    mkdirSync(join(testState.directory, "directory"), { mode: 0o700 });
    writePrivate(testState.directory, "permissive", "not private\n");
    chmodSync(join(testState.directory, "permissive"), 0o644);
    const fifo = join(testState.directory, "fifo");
    if (existsSync("/usr/bin/mkfifo")) {
      const created = spawnSync("/usr/bin/mkfifo", [fifo], {
        encoding: "utf8",
        shell: false,
      });
      expect(created.status).toBe(0);
    }

    const names = [
      "link",
      "directory",
      "permissive",
      ...(existsSync(fifo) ? ["fifo"] : []),
    ];
    const results = readBatch(testState, names);
    expect(results.map(({ name }) => name)).toEqual(names);
    expect(results.every((result) =>
      result.status === "invalid" && result.reason === "unsafe-file"
    )).toBeTrue();
    expect(readFileSync(outside, "utf8")).toBe("outside secret\n");
  });

  test("makes disappearance inert and applies a batch fault only once", () => {
    const testState = state();
    for (const name of ["first", "second", "third"]) {
      writePrivate(testState.directory, name, `${name}\n`);
    }
    expect(readBatch(testState, ["first", "second", "third"], {
      faultForTest: "remove-first-file-after-open",
    })).toEqual([
      { name: "first", status: "absent" },
      { name: "second", status: "present", content: "second\n" },
      { name: "third", status: "present", content: "third\n" },
    ]);
    expect(existsSync(join(testState.directory, "first"))).toBeFalse();
  });

  test("returns an inode swap as invalid without exposing replacement content", () => {
    const testState = state();
    writePrivate(testState.directory, "value", "original\n");

    expect(readBatch(testState, ["value"], {
      faultForTest: "replace-first-file-after-open",
    })).toEqual([{
      name: "value",
      status: "invalid",
      reason: "changed-during-read",
    }]);
    expect(readFileSync(join(testState.directory, "value"), "utf8"))
      .toBe("replacement must not be returned\n");
  });

  test("fails the whole operation when the bound directory is replaced", () => {
    const testState = state();
    writePrivate(testState.directory, "value", "original\n");

    expect(() => readBatch(testState, ["value"], {
      faultForTest: "replace-directory-after-bind",
    })).toThrow("directory changed identity");
  });

  test("rejects a caller-supplied stale directory identity", () => {
    const testState = state();
    expect(() => readBatch(testState, [], {
      expectedDirectoryIdentity: {
        ...testState.identity,
        inode: (BigInt(testState.identity.inode) + 1n).toString(),
      },
    })).toThrow("directory changed identity");
  });

  test("rejects a malformed helper response as a whole-operation failure", () => {
    const testState = state();
    expect(() => readBatch(testState, [], {
      faultForTest: "malformed-response",
    })).toThrow("malformed batch response");
  });

  test("batch-reads exact leaves from identity-bound immediate child directories", () => {
    const testState = state();
    const alpha = join(testState.directory, "alpha");
    const zulu = join(testState.directory, "zulu");
    const alphaIdentity = ensurePrivateStateDirectory(
      alpha,
      testState.environment,
    );
    const zuluIdentity = ensurePrivateStateDirectory(
      zulu,
      testState.environment,
    );
    writePrivate(alpha, "manifest.json", '{"id":"alpha"}\n');
    writePrivate(zulu, "manifest.json", '{"id":"zulu"}\n');

    expect(readPrivateStateChildFilesBatch(testState.directory, [
      {
        directoryName: "zulu",
        directoryIdentity: zuluIdentity,
        fileName: "manifest.json",
      },
      {
        directoryName: "alpha",
        directoryIdentity: alphaIdentity,
        fileName: "manifest.json",
      },
      {
        directoryName: "alpha",
        directoryIdentity: alphaIdentity,
        fileName: "missing.json",
      },
    ], {
      maximumBytesPerFile: 4 * 1024,
      maximumTotalBytes: 12 * 1024,
      environment: testState.environment,
      expectedDirectoryIdentity: testState.identity,
    })).toEqual([
      {
        directoryName: "zulu",
        fileName: "manifest.json",
        status: "present",
        content: '{"id":"zulu"}\n',
      },
      {
        directoryName: "alpha",
        fileName: "manifest.json",
        status: "present",
        content: '{"id":"alpha"}\n',
      },
      {
        directoryName: "alpha",
        fileName: "missing.json",
        status: "absent",
      },
    ]);

    expect(readPrivateStateChildFilesBatch(testState.directory, [{
      directoryName: "alpha",
      directoryIdentity: {
        ...alphaIdentity,
        inode: (BigInt(alphaIdentity.inode) + 1n).toString(),
      },
      fileName: "manifest.json",
    }], {
      maximumBytesPerFile: 4 * 1024,
      maximumTotalBytes: 4 * 1024,
      environment: testState.environment,
      expectedDirectoryIdentity: testState.identity,
    })).toEqual([{
      directoryName: "alpha",
      fileName: "manifest.json",
      status: "invalid",
      reason: "changed-during-read",
    }]);

    expect(readPrivateStateChildFilesBatch(testState.directory, [{
      directoryName: "alpha",
      directoryIdentity: alphaIdentity,
      fileName: "manifest.json",
    }], {
      maximumBytesPerFile: 4 * 1024,
      maximumTotalBytes: 4 * 1024,
      environment: testState.environment,
      expectedDirectoryIdentity: testState.identity,
      faultForTest: "replace-first-child-after-bind",
    })).toEqual([{
      directoryName: "alpha",
      fileName: "manifest.json",
      status: "invalid",
      reason: "changed-during-read",
    }]);

    expect(() => readPrivateStateChildFilesBatch(
      testState.directory,
      [],
      {
        maximumBytesPerFile: 4 * 1024,
        maximumTotalBytes: 12 * 1024,
        environment: testState.environment,
        expectedDirectoryIdentity: testState.identity,
        faultForTest: "malformed-response",
      },
    )).toThrow("malformed child batch response");
  });
});
