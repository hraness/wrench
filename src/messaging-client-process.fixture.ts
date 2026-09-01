import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalSpawn = childProcess.spawn;
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: () => void, delay?: number) =>
  nativeSetTimeout(callback, delay === 120_000 ? 500 : delay === 1_000 ? 25 : delay)) as typeof setTimeout;

await mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: ((
    _command: string,
    arguments_: readonly string[],
    options: childProcess.SpawnOptionsWithoutStdio,
  ) => {
    const outputIndex = arguments_.indexOf("--private-output");
    if (outputIndex < 0 || arguments_[outputIndex + 1] === undefined) {
      throw new Error("missing private output fixture path");
    }
    const environment = options.env ?? {};
    return originalSpawn(process.execPath, [
      join(import.meta.dir, "messaging-client-process-helper.fixture.ts"),
      String(environment.WRENCH_MESSAGING_LIFECYCLE_MODE),
      String(environment.WRENCH_MESSAGING_LIFECYCLE_STATUS),
      arguments_[outputIndex + 1]!,
    ], options);
  }) as typeof childProcess.spawn,
}));

const { discoverMessagingRoutes } = await import("./messaging");

const request = {
  schemaVersion: 1 as const,
  format: "wrench.messaging-routes-request" as const,
  source: {
    adapterId: "imessage-direct",
    authId: "device-default",
    listInput: { limit: 10 },
  },
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForStatus(path: string): Promise<{ parent: number; descendant: number; temp: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as {
          parent: number;
          descendant: number;
          temp: string;
        };
      } catch {
        // The helper may still be replacing the status file.
      }
    }
    await Bun.sleep(5);
  }
  throw new Error("lifecycle helper did not report its process tree");
}

for (const mode of ["abort", "timeout", "stdout-overflow", "stderr-overflow"] as const) {
  const statusRoot = mkdtempSync(join(tmpdir(), "wrench-messaging-lifecycle-status-"));
  const status = join(statusRoot, "status.json");
  const controller = new AbortController();
  const operationOutcome = discoverMessagingRoutes(request, {
    environment: {
      WRENCH_MESSAGING_LIFECYCLE_MODE: mode,
      WRENCH_MESSAGING_LIFECYCLE_STATUS: status,
    },
    signal: controller.signal,
  }).then(
    (value) => ({ fulfilled: true as const, value }),
    (error: unknown) => ({ fulfilled: false as const, error }),
  );
  const tree = await waitForStatus(status);
  if (mode === "abort") controller.abort(new Error("fixture abort"));
  const outcome = await operationOutcome;
  for (let attempt = 0; attempt < 200 && alive(tree.descendant); attempt += 1) {
    await Bun.sleep(5);
  }
  if (outcome.fulfilled) throw new Error(`${mode} unexpectedly succeeded`);
  const error = outcome.error instanceof Error
    ? outcome.error.message
    : String(outcome.error);
  if (error.length === 0) throw new Error(`${mode} rejected without an error message`);
  if (alive(tree.parent) || alive(tree.descendant)) {
    throw new Error(`${mode} left an owned process alive`);
  }
  if (existsSync(tree.temp)) throw new Error(`${mode} left a private artifact directory`);
  rmSync(statusRoot, { recursive: true, force: true });
}
