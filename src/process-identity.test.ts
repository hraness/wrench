import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  accessSync,
  constants,
  readFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";

import {
  currentProcessStartIdentity,
  darwinBootIdForTest,
  inspectDarwinProcessIdentityForTest,
  inspectDarwinProcessInfoForTest,
  inspectDarwinProcessWithReaderForTest,
  inspectLinuxProcessRecordForTest,
  normalizeDarwinBootSessionUuidForTest,
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";

setDefaultTimeout(15_000);

const PYTHON_ZOMBIE_HOLDER = `
import subprocess
import sys
import time

child = subprocess.Popen(
    [sys.argv[1], "--eval", sys.argv[2]],
    stdout=sys.stdout,
    stderr=sys.stderr,
)
time.sleep(30)
`;

function linuxStat(state: string, startTicks = "424242"): string {
  const fieldsBeforeStart = Array.from(
    { length: 18 },
    (_, index) => String(index + 1),
  );
  return `42 (worker ) name) ${[
    state,
    ...fieldsBeforeStart,
    startTicks,
  ].join(" ")}`;
}

function darwinProcessInfo(
  pid: number,
  options: {
    readonly flags?: number;
    readonly status?: number;
    readonly startSeconds?: bigint;
    readonly startMicroseconds?: bigint;
  } = {},
): Buffer {
  const buffer = Buffer.alloc(136);
  buffer.writeUInt32LE(options.flags ?? 0, 0);
  buffer.writeUInt32LE(options.status ?? 2, 4);
  buffer.writeUInt32LE(pid, 12);
  buffer.writeBigUInt64LE(options.startSeconds ?? 1_722_000_000n, 120);
  buffer.writeBigUInt64LE(options.startMicroseconds ?? 123_456n, 128);
  return buffer;
}

function darwinUniqueProcessInfo(
  uniqueId: bigint,
  idVersion = 7,
): Buffer {
  const buffer = Buffer.alloc(56);
  buffer.writeBigUInt64LE(uniqueId, 16);
  buffer.writeUInt32LE(idVersion, 32);
  return buffer;
}

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the bounded PATH candidates.
    }
  }
  return undefined;
}

function firstLine(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffered = "";
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: string): void => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolve(buffered.slice(0, newline));
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error("zombie helper ended before reporting its child"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new Error("timed operation failed", { cause: error }),
        );
      },
    );
  });
}

function parseOwnerIdentity(line: string): ProcessOwnerIdentity {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("zombie helper returned a malformed process identity");
  }
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  const bootId = record.bootId;
  const processStartId = record.processStartId;
  if (
    !Number.isSafeInteger(pid)
    || typeof pid !== "number"
    || pid <= 0
    || typeof bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(bootId)
    || typeof processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(processStartId)
  ) {
    throw new Error("zombie helper returned a malformed process identity");
  }
  return { pid, bootId, processStartId };
}

function observedProcessState(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
      const close = stat.lastIndexOf(")");
      if (close < 1) return undefined;
      return stat.slice(close + 1).trim().split(/\s+/u)[0];
    }
    if (process.platform === "darwin") {
      return execFileSync(
        "/bin/ps",
        ["-o", "state=", "-p", String(pid)],
        {
          encoding: "utf8",
          env: { LANG: "C", LC_ALL: "C", NODE_ENV: "test" },
          timeout: 2_000,
        },
      ).trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function observeZombie(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastState: string | undefined;
  do {
    lastState = observedProcessState(pid);
    if (lastState?.startsWith("Z") === true) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  } while (Date.now() < deadline);
  throw new Error(
    `subprocess did not become an observable zombie (last state: ${
      lastState ?? "missing"
    })`,
  );
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function terminateHelper(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 1_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(child, 1_000))) {
    throw new Error("failed to terminate zombie helper");
  }
}

describe("process identity record parsing", () => {
  test("normalizes and validates the immutable macOS boot session UUID", () => {
    const uppercase = "00112233-4455-6677-8899-AABBCCDDEEFF";
    const lowercase = uppercase.toLowerCase();
    const different = "00112233-4455-6677-8899-aabbccddef00";

    expect(normalizeDarwinBootSessionUuidForTest(`  ${uppercase}\n`)).toBe(
      lowercase,
    );
    expect(darwinBootIdForTest(lowercase)).toBe(
      "fbb2c057897c5410fc49f4ecfba01406b116efa6a51254f43852ea89733a030a",
    );
    expect(darwinBootIdForTest(uppercase)).toBe(darwinBootIdForTest(lowercase));
    expect(darwinBootIdForTest(different)).not.toBe(
      darwinBootIdForTest(lowercase),
    );
    for (const malformed of [
      "",
      "00112233445566778899aabbccddeeff",
      "00112233-4455-6677-8899-aabbccddeefg",
      "{00112233-4455-6677-8899-aabbccddeeff}",
    ]) {
      expect(() => normalizeDarwinBootSessionUuidForTest(malformed)).toThrow(
        "system boot identity is malformed",
      );
    }
  });

  test("reads Linux start ticks only from a recognized live process state", () => {
    expect(inspectLinuxProcessRecordForTest(linuxStat("R"))).toEqual({
      status: "alive",
      rawStartId: "424242",
    });
    expect(inspectLinuxProcessRecordForTest(linuxStat("Z"))).toEqual({
      status: "dead",
    });
    expect(inspectLinuxProcessRecordForTest("42 (worker) Z")).toEqual({
      status: "dead",
    });
    expect(inspectLinuxProcessRecordForTest(linuxStat("Q"))).toEqual({
      status: "unknown",
    });
    expect(inspectLinuxProcessRecordForTest("42 (worker) R")).toEqual({
      status: "unknown",
    });
  });

  test("distinguishes macOS process starts within the same wall-clock second", () => {
    const pid = 42;
    const bsdInfo = darwinProcessInfo(pid, {
      startMicroseconds: 123_456n,
    });
    const first = Buffer.concat([
      bsdInfo,
      darwinUniqueProcessInfo(101n),
    ]);
    const second = Buffer.concat([
      bsdInfo,
      darwinUniqueProcessInfo(102n),
    ]);
    expect(
      inspectDarwinProcessIdentityForTest(
        first,
        pid,
      ),
    ).toEqual({
      status: "alive",
      rawStartId: "101:7:1722000000:123456",
    });
    expect(
      inspectDarwinProcessIdentityForTest(
        second,
        pid,
      ),
    ).toEqual({
      status: "alive",
      rawStartId: "102:7:1722000000:123456",
    });
  });

  test("rejects mismatched, exiting, zombie, and malformed macOS records", () => {
    const pid = 42;
    expect(
      inspectDarwinProcessInfoForTest(darwinProcessInfo(pid), pid + 1),
    ).toEqual({ status: "unknown" });
    expect(
      inspectDarwinProcessInfoForTest(
        darwinProcessInfo(pid, { flags: 0x4 }),
        pid,
      ),
    ).toEqual({ status: "dead" });
    expect(
      inspectDarwinProcessInfoForTest(
        darwinProcessInfo(pid, { status: 5 }),
        pid,
      ),
    ).toEqual({ status: "dead" });
    expect(
      inspectDarwinProcessInfoForTest(
        darwinProcessInfo(pid, { startMicroseconds: 1_000_000n }),
        pid,
      ),
    ).toEqual({ status: "unknown" });
    expect(
      inspectDarwinProcessIdentityForTest(
        Buffer.concat([
          darwinProcessInfo(pid),
          darwinUniqueProcessInfo(0n),
        ]),
        pid,
      ),
    ).toEqual({ status: "unknown" });
  });

  test("retries two short macOS identity reads before accepting a full record", () => {
    const pid = 42;
    const full = Buffer.concat([
      darwinProcessInfo(pid),
      darwinUniqueProcessInfo(101n),
    ]);
    const records = [Buffer.alloc(8), Buffer.alloc(191), full];
    let reads = 0;
    let deadChecks = 0;

    expect(inspectDarwinProcessWithReaderForTest(
      pid,
      () => records[reads++] ?? null,
      () => {
        deadChecks += 1;
        return false;
      },
    )).toEqual({
      status: "alive",
      rawStartId: "101:7:1722000000:123456",
    });
    expect(reads).toBe(3);
    expect(deadChecks).toBe(2);
  });

  test("keeps persistent short macOS identity reads unknown", () => {
    let reads = 0;
    expect(inspectDarwinProcessWithReaderForTest(
      42,
      () => {
        reads += 1;
        return Buffer.alloc(191);
      },
      () => false,
    )).toEqual({ status: "unknown" });
    expect(reads).toBe(3);
  });

  test("retries a temporarily unavailable macOS identity reader", () => {
    const full = Buffer.concat([
      darwinProcessInfo(42),
      darwinUniqueProcessInfo(101n),
    ]);
    const records = [null, null, full];
    let reads = 0;

    expect(inspectDarwinProcessWithReaderForTest(
      42,
      () => records[reads++] ?? null,
      () => false,
    )).toEqual({
      status: "alive",
      rawStartId: "101:7:1722000000:123456",
    });
    expect(reads).toBe(3);
  });

  test("retries an untrusted mismatched-PID macOS record", () => {
    const records = [
      Buffer.concat([
        darwinProcessInfo(43),
        darwinUniqueProcessInfo(101n),
      ]),
      Buffer.concat([
        darwinProcessInfo(42),
        darwinUniqueProcessInfo(102n),
      ]),
    ];
    let reads = 0;

    expect(inspectDarwinProcessWithReaderForTest(
      42,
      () => records[reads++] ?? null,
      () => false,
    )).toEqual({
      status: "alive",
      rawStartId: "102:7:1722000000:123456",
    });
    expect(reads).toBe(2);
  });

  test("keeps persistent mismatched-PID macOS records unknown", () => {
    let reads = 0;
    expect(inspectDarwinProcessWithReaderForTest(
      42,
      () => {
        reads += 1;
        return Buffer.concat([
          darwinProcessInfo(43),
          darwinUniqueProcessInfo(BigInt(reads)),
        ]);
      },
      () => false,
    )).toEqual({ status: "unknown" });
    expect(reads).toBe(3);
  });

  test("does not override a parsed dead macOS record with a later live record", () => {
    const records = [
      Buffer.concat([
        darwinProcessInfo(42, { status: 5 }),
        darwinUniqueProcessInfo(101n),
      ]),
      Buffer.concat([
        darwinProcessInfo(42),
        darwinUniqueProcessInfo(102n),
      ]),
    ];
    let reads = 0;

    expect(inspectDarwinProcessWithReaderForTest(
      42,
      () => records[reads++] ?? null,
      () => false,
    )).toEqual({ status: "dead" });
    expect(reads).toBe(1);
  });
});

describe("process owner status", () => {
  test("keeps exact start identity live and rejects a reused identity", () => {
    const identity = currentProcessStartIdentity();
    expect(processOwnerStatus({ pid: process.pid, ...identity })).toBe(
      "exact-live-owner",
    );
    expect(processOwnerStatus({
      pid: process.pid,
      ...identity,
      processStartId: identity.processStartId === "0".repeat(64)
        ? "1".repeat(64)
        : "0".repeat(64),
    })).toBe("different-or-dead");
  });

  const python = findExecutable("python3");
  const canObserveZombie = (
    process.platform === "darwin" || process.platform === "linux"
  ) && python !== undefined;

  test.skipIf(!canObserveZombie)(
    "never classifies an exited but unreaped subprocess as exact-live",
    async () => {
      if (python === undefined) {
        throw new Error("python3 is required by the zombie regression helper");
      }
      const moduleUrl = new URL("./process-identity.ts", import.meta.url).href;
      const childSource = [
        `import { currentProcessStartIdentity } from ${JSON.stringify(moduleUrl)};`,
        "const identity = currentProcessStartIdentity();",
        "process.stdout.write(JSON.stringify({ pid: process.pid, ...identity }) + \"\\n\");",
      ].join("\n");
      const helper = spawn(
        python,
        ["-c", PYTHON_ZOMBIE_HOLDER, process.execPath, childSource],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (helper.stdout === null || helper.stderr === null) {
        await terminateHelper(helper);
        throw new Error("zombie helper pipes are unavailable");
      }
      let stderr = "";
      helper.stderr.setEncoding("utf8");
      helper.stderr.on("data", (chunk: string) => {
        if (stderr.length < 8_192) stderr += chunk;
      });
      try {
        const line = await withTimeout(
          firstLine(helper.stdout),
          5_000,
          `zombie helper did not report its child: ${stderr}`,
        );
        const owner = parseOwnerIdentity(line);
        await observeZombie(owner.pid);
        expect(() => {
          process.kill(owner.pid, 0);
        }).not.toThrow();
        expect(processOwnerStatus(owner)).toBe("different-or-dead");
      } finally {
        await terminateHelper(helper);
      }
    },
  );
});
