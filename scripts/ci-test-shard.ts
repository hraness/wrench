import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const UNIT_TEST_FILE_PATTERN = /[._](?:test|spec)\.(?:js|jsx|ts|tsx)$/u;
const OMNI_RUNTIME_TEST_FILE = "src/omni-runtime.test.ts";
const DEFAULT_CONCURRENCY = 4;
const MAX_SHARD_COUNT = 16;
const DEFAULT_FILE_WEIGHT = 2;

// Wall seconds observed for the heaviest `./src` files during Linux
// `bun run check` on GitHub-hosted ubuntu-latest (run 33969193934).
// Used only to pack shards; every listed file still runs exactly once.
const MEASURED_FILE_WEIGHTS = Object.freeze({
  "src/messaging-runtime-execution.test.ts": 410,
  "src/runtime.test.ts": 265,
  "src/wrench.test.ts": 208,
  "src/read-projections.test.ts": 159,
  "src/read-client.test.ts": 115,
  "src/provider-plugin-portable-runtime.test.ts": 95,
  "src/web-session-recovery.test.ts": 62,
  "src/derive.test.ts": 53,
  "src/auth-storage.test.ts": 46,
  "src/session-secrets.test.ts": 42,
  "src/read-projections-omni.test.ts": 36,
  "src/scripts/sync-bundled-adapters.test.ts": 34,
  "src/messaging-provider-identity-collision.test.ts": 29,
  "src/provider-plugin-store.test.ts": 28,
  "src/linked-device-lifecycle-runtime.test.ts": 26,
  "src/provider-plugin-host.test.ts": 20,
});

export const CI_UNIT_TEST_SHARD_COUNT = 4;
export const BUN_TEST_TIMEOUT_MS = 180_000;

export type ShardRequest = {
  readonly concurrency: number;
  readonly shard: number;
  readonly shardCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${label} must be an integer from 1 to ${String(maximum)}`);
    }
    return value;
  }
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${label} must be an integer from 1 to ${String(maximum)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${String(maximum)}`);
  }
  return parsed;
}

export function parseShardRequest(input: unknown): ShardRequest {
  if (!isRecord(input)) {
    throw new Error("shard request must be one object");
  }
  const allowed = new Set(["concurrency", "shard", "shardCount"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new Error(`shard request has unexpected field ${key}`);
    }
  }
  if (!Object.hasOwn(input, "shard") || !Object.hasOwn(input, "shardCount")) {
    throw new Error("shard request requires shard and shardCount");
  }
  const shard = parsePositiveInteger(input.shard, "shard", MAX_SHARD_COUNT);
  const shardCount = parsePositiveInteger(input.shardCount, "shardCount", MAX_SHARD_COUNT);
  if (shard > shardCount) {
    throw new Error(`shard ${String(shard)} is outside 1..${String(shardCount)}`);
  }
  const concurrency = input.concurrency === undefined
    ? DEFAULT_CONCURRENCY
    : parsePositiveInteger(input.concurrency, "concurrency", 64);
  return { concurrency, shard, shardCount };
}

export function posixRepoPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

export function isSrcUnitTestFile(relativePath: string): boolean {
  return relativePath.startsWith("src/")
    && UNIT_TEST_FILE_PATTERN.test(relativePath)
    && relativePath !== OMNI_RUNTIME_TEST_FILE;
}

async function collectFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path));
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function listSrcUnitTestFiles(root: string): Promise<readonly string[]> {
  const srcRoot = join(root, "src");
  const files = (await collectFiles(srcRoot))
    .map((path) => posixRepoPath(root, path))
    .filter((path) => isSrcUnitTestFile(path))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new Error("src unit-test inventory is empty");
  }
  return files;
}

export function fileWeight(relativePath: string): number {
  return MEASURED_FILE_WEIGHTS[relativePath as keyof typeof MEASURED_FILE_WEIGHTS]
    ?? DEFAULT_FILE_WEIGHT;
}

export function assignUnitTestShards(
  files: readonly string[],
  shardCount: number,
): readonly (readonly string[])[] {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > MAX_SHARD_COUNT) {
    throw new Error(`shardCount must be an integer from 1 to ${String(MAX_SHARD_COUNT)}`);
  }
  const unique = new Set(files);
  if (unique.size !== files.length) {
    throw new Error("unit-test inventory contains duplicate paths");
  }
  for (const file of files) {
    if (!isSrcUnitTestFile(file)) {
      throw new Error(`refusing to shard non-unit test file ${file}`);
    }
  }
  const shards: string[][] = Array.from({ length: shardCount }, () => []);
  const weights = Array.from({ length: shardCount }, () => 0);
  const ordered = [...files].sort((left, right) => {
    const weightDelta = fileWeight(right) - fileWeight(left);
    return weightDelta !== 0 ? weightDelta : left.localeCompare(right);
  });
  for (const file of ordered) {
    let index = 0;
    for (let candidate = 1; candidate < shardCount; candidate += 1) {
      const current = weights[index];
      const next = weights[candidate];
      if (current === undefined || next === undefined) {
        throw new Error("shard weight inventory drifted");
      }
      if (next < current || (next === current && candidate < index)) {
        index = candidate;
      }
    }
    const shard = shards[index];
    const currentWeight = weights[index];
    if (shard === undefined || currentWeight === undefined) {
      throw new Error("shard inventory drifted");
    }
    shard.push(file);
    weights[index] = currentWeight + fileWeight(file);
  }
  return shards.map((shard) => Object.freeze([...shard].sort((left, right) =>
    left.localeCompare(right)
  )));
}

export async function filesForShard(
  root: string,
  request: ShardRequest,
): Promise<readonly string[]> {
  const files = await listSrcUnitTestFiles(root);
  const shards = assignUnitTestShards(files, request.shardCount);
  const selected = shards[request.shard - 1];
  if (selected === undefined || selected.length === 0) {
    throw new Error(`shard ${String(request.shard)} has no test files`);
  }
  return selected;
}

export function bunUnitTestArguments(
  files: readonly string[],
  concurrency: number,
): readonly string[] {
  if (files.length === 0) {
    throw new Error("refusing to invoke bun test without files");
  }
  return [
    "test",
    "--no-orphans",
    "--timeout",
    String(BUN_TEST_TIMEOUT_MS),
    "--max-concurrency",
    String(concurrency),
    ...files,
  ];
}

async function runShardFromProcess(): Promise<void> {
  const request = parseShardRequest({
    concurrency: process.env.GOMAXPROCS,
    shard: process.argv[2],
    shardCount: process.argv[3],
  });
  const root = process.cwd();
  const files = await filesForShard(root, request);
  process.stderr.write(
    `wrench ci-test-shard ${String(request.shard)}/${String(request.shardCount)}: `
    + `${String(files.length)} files\n`,
  );
  const child = Bun.spawn([process.execPath, ...bunUnitTestArguments(files, request.concurrency)], {
    cwd: root,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

if (import.meta.main) {
  await runShardFromProcess();
}
