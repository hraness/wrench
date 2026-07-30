import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ensurePrivateStateDirectory,
  wrenchStateHome,
  readPrivateStateFileIfPresent,
  removePrivateStateFileIfUnchanged,
  writePrivateJson,
  writePrivateJsonIfUnchanged,
} from "./storage";

const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;
const roots: string[] = [];

type PipedChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

async function killAndReapChild(
  child: PipedChild,
  stdout: Promise<string>,
  stderr: Promise<string>,
): Promise<void> {
  try {
    child.kill("SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // The direct test child already exited.
    }
  }
  await Promise.allSettled([child.exited, stdout, stderr]);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function state(): {
  readonly root: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-storage-cas-"));
  chmodSync(root, 0o700);
  roots.push(root);
  const environment = { ...process.env, WRENCH_STATE_HOME: root };
  const canonicalRoot = wrenchStateHome(environment);
  ensurePrivateStateDirectory(join(canonicalRoot, "session-secrets"), environment);
  return { root: canonicalRoot, environment };
}

function contentHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out waiting for state CAS signal: ${path}`);
    }
    await Bun.sleep(10);
  }
}

describe("private state compare-and-swap writes", () => {
  test("accepts one exact snapshot and rejects a stale successor", () => {
    const { root } = state();
    const path = join(root, "session-secrets", "value.json");
    writePrivateJson(path, { version: 1 });
    const expected = contentHash(path);

    expect(writePrivateJsonIfUnchanged(path, { version: 2 }, {
      expectedCurrentContentSha256: expected,
    })).toBeTrue();
    expect(writePrivateJsonIfUnchanged(path, { version: 3 }, {
      expectedCurrentContentSha256: expected,
    })).toBeFalse();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2 });
  });

  test("treats disappearance as a conflict rather than recreating state", () => {
    const { root } = state();
    const path = join(root, "session-secrets", "missing.json");

    expect(writePrivateJsonIfUnchanged(path, { version: 1 }, {
      expectedCurrentContentSha256: "0".repeat(64),
    })).toBeFalse();
  });

  test("admits exactly one overlapping cross-process writer for an exact snapshot", async () => {
    const { root } = state();
    const directory = join(root, "session-secrets");
    const path = join(directory, "value.json");
    writePrivateJson(path, { version: 1 });
    const expected = contentHash(path);
    const readyPath = join(directory, ".wrench-test-cas-ready");
    const releasePath = join(directory, ".wrench-test-cas-release");
    const storageUrl = pathToFileURL(join(import.meta.dir, "storage.ts")).href;
    const childScript = `
      import { wrenchStateHome, writePrivateJsonIfUnchanged } from ${JSON.stringify(storageUrl)};
      const environment = { ...process.env, WRENCH_STATE_HOME: process.env.WRENCH_TEST_HOME };
      wrenchStateHome(environment);
      const written = writePrivateJsonIfUnchanged(
        process.env.WRENCH_TEST_PATH,
        { version: Number(process.env.WRENCH_TEST_VERSION) },
        {
          expectedCurrentContentSha256: process.env.WRENCH_TEST_EXPECTED,
          pauseAfterClaimForTest: process.env.WRENCH_TEST_PAUSE === "1",
        },
      );
      process.stdout.write(written ? "true" : "false");
    `;
    const first = Bun.spawn([process.execPath, "-e", childScript], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        WRENCH_TEST_HOME: root,
        WRENCH_TEST_PATH: path,
        WRENCH_TEST_EXPECTED: expected,
        WRENCH_TEST_VERSION: "2",
        WRENCH_TEST_PAUSE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const firstStdout = new Response(first.stdout).text();
    const firstStderr = new Response(first.stderr).text();
    let firstReaped = false;
    let releasePublished = false;
    let second: PipedChild | undefined;
    let secondStdoutPromise: Promise<string> | undefined;
    let secondStderrPromise: Promise<string> | undefined;
    let secondReaped = false;
    try {
      await waitForFile(readyPath);
      const spawnedSecond = Bun.spawn([process.execPath, "-e", childScript], {
        env: {
          ...process.env,
          NODE_ENV: "test",
          WRENCH_TEST_HOME: root,
          WRENCH_TEST_PATH: path,
          WRENCH_TEST_EXPECTED: expected,
          WRENCH_TEST_VERSION: "3",
          WRENCH_TEST_PAUSE: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      second = spawnedSecond;
      secondStdoutPromise = new Response(spawnedSecond.stdout).text();
      secondStderrPromise = new Response(spawnedSecond.stderr).text();
      const [secondStatus, secondOutput, secondErrors] = await Promise.all([
        second.exited,
        secondStdoutPromise,
        secondStderrPromise,
      ]);
      secondReaped = true;
      expect(secondStatus).toBe(0);
      expect(secondOutput).toBe("false");
      expect(secondErrors).toBe("");

      writeFileSync(releasePath, "release\n", { mode: 0o600 });
      releasePublished = true;
      const [firstStatus, firstOutput, firstErrors] = await Promise.all([
        first.exited,
        firstStdout,
        firstStderr,
      ]);
      firstReaped = true;
      expect(firstStatus).toBe(0);
      expect(firstOutput).toBe("true");
      expect(firstErrors).toBe("");
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2 });
      expect(
        readdirSync(directory).filter((name) =>
          name.startsWith(".io-mutation-")
        ),
      ).toEqual([]);
    } finally {
      try {
        if (!releasePublished) {
          writeFileSync(releasePath, "release\n", { mode: 0o600 });
        }
      } finally {
        try {
          if (
            !secondReaped
            && second !== undefined
            && secondStdoutPromise !== undefined
            && secondStderrPromise !== undefined
          ) {
            await killAndReapChild(
              second,
              secondStdoutPromise,
              secondStderrPromise,
            );
          }
        } finally {
          if (!firstReaped) {
            await killAndReapChild(first, firstStdout, firstStderr);
          }
        }
      }
    }
  });

  test("rejects malformed expected hashes before invoking the helper", () => {
    const { root } = state();
    const path = join(root, "session-secrets", "value.json");
    writePrivateJson(path, { version: 1 });

    expect(() => writePrivateJsonIfUnchanged(path, { version: 2 }, {
      expectedCurrentContentSha256: "not-a-digest",
    })).toThrow("expected private state content hash is invalid");
  });

  test("preserves a leading UTF-8 BOM in raw-byte snapshot identity", () => {
    const { root, environment } = state();
    const path = join(root, "session-secrets", "value.json");
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"version":1}\n', "utf8"),
    ]);
    writeFileSync(path, bytes, { mode: 0o600 });

    const text = readPrivateStateFileIfPresent(
      path,
      1024,
      "BOM identity fixture",
      environment,
    );
    expect(text).not.toBeNull();
    if (text === null) throw new Error("BOM identity fixture disappeared");
    expect(text.codePointAt(0)).toBe(0xfeff);
    expect(createHash("sha256").update(text, "utf8").digest("hex"))
      .toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(() => {
      JSON.parse(text);
    }).toThrow();
  });

  test("recovers a dead helper's unique mutation claim before CAS", () => {
    const { root } = state();
    const directory = join(root, "session-secrets");
    const path = join(directory, "value.json");
    writePrivateJson(path, { version: 1 });
    const expected = contentHash(path);
    const targetSha256 = createHash("sha256")
      .update("io-state-mutation", "utf8")
      .update("\0", "utf8")
      .update("value.json", "utf8")
      .digest("hex");
    const claimId = "11111111-1111-4111-8111-111111111111";
    const claimPath = join(
      directory,
      `.io-mutation-${targetSha256}-held-${claimId}.lock`,
    );
    writeFileSync(
      claimPath,
      `${JSON.stringify({
        kind: "io-state-mutation-claim",
        schemaVersion: 1,
        targetSha256,
        claimId,
        pid: 999_999_999,
        bootId: "0".repeat(64),
        processStartId: "0".repeat(64),
      })}\n`,
      { mode: 0o600 },
    );

    expect(writePrivateJsonIfUnchanged(path, { version: 2 }, {
      expectedCurrentContentSha256: expected,
    })).toBeTrue();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 2 });
    expect(existsSync(claimPath)).toBeFalse();
  });

  test("deletes only the exact inode-bound content snapshot", () => {
    const { root, environment } = state();
    const path = join(root, "session-secrets", "value.json");
    writePrivateJson(path, { version: 1 });
    const expected = contentHash(path);

    expect(removePrivateStateFileIfUnchanged(path, {
      expectedCurrentContentSha256: "f".repeat(64),
    }, environment)).toBeFalse();
    expect(existsSync(path)).toBeTrue();
    expect(removePrivateStateFileIfUnchanged(path, {
      expectedCurrentContentSha256: expected,
    }, environment)).toBeTrue();
    expect(existsSync(path)).toBeFalse();
    expect(removePrivateStateFileIfUnchanged(path, {
      expectedCurrentContentSha256: expected,
    }, environment)).toBeFalse();
  });

  test("never follows a symbolic link for conditional deletion", () => {
    const { root, environment } = state();
    const outside = join(root, "outside.json");
    const path = join(root, "session-secrets", "value.json");
    writeFileSync(outside, '{"private":"outside"}\n', { mode: 0o600 });
    symlinkSync(outside, path);

    expect(() => removePrivateStateFileIfUnchanged(path, {
      expectedCurrentContentSha256: contentHash(outside),
    }, environment)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe('{"private":"outside"}\n');
  });
});
