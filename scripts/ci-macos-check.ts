import { access } from "node:fs/promises";
import { join } from "node:path";

const BUN_TEST_TIMEOUT_MS = 180_000;
const DEFAULT_CONCURRENCY = 4;

export const MACOS_TEST_FILES = Object.freeze([
  "src/apple-photos-cli-recovery.test.ts",
  "src/apple-photos-cli.test.ts",
  "src/apple-photos-client.test.ts",
  "src/apple-photos-contact-evidence.test.ts",
  "src/apple-photos-local-source.test.ts",
  "src/auth-storage.test.ts",
  "src/imessage-direct-plugin.test.ts",
  "src/process-identity.test.ts",
  "src/provider-http.test.ts",
  "src/provider-plugin-host.test.ts",
]);

export const MACOS_PATTERNED_TESTS = Object.freeze([
  Object.freeze({
    file: "src/wrench.test.ts",
    testNamePattern:
      "keeps public iMessage installer filesystem failures prompt and path-free",
  }),
]);

function parseConcurrency(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("GOMAXPROCS must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 64) {
    throw new Error("GOMAXPROCS must be a positive integer at most 64");
  }
  return parsed;
}

export async function assertMacosCheckFilesExist(root: string): Promise<void> {
  const required = [
    ...MACOS_TEST_FILES,
    ...MACOS_PATTERNED_TESTS.map((entry) => entry.file),
  ];
  for (const relativePath of required) {
    await access(join(root, relativePath));
  }
}

export function macosCheckInvocations(
  concurrency: number,
): readonly (readonly string[])[] {
  return [
    [
      "test",
      "--no-orphans",
      "--timeout",
      String(BUN_TEST_TIMEOUT_MS),
      "--max-concurrency",
      String(concurrency),
      ...MACOS_TEST_FILES,
    ],
    ...MACOS_PATTERNED_TESTS.map((entry) => [
      "test",
      "--no-orphans",
      "--timeout",
      String(BUN_TEST_TIMEOUT_MS),
      "--max-concurrency",
      "1",
      "--test-name-pattern",
      entry.testNamePattern,
      entry.file,
    ]),
  ];
}

async function runMacosCheck(): Promise<void> {
  const root = process.cwd();
  await assertMacosCheckFilesExist(root);
  const concurrency = parseConcurrency(process.env.GOMAXPROCS);
  process.stderr.write(
    `wrench check:macos: ${String(MACOS_TEST_FILES.length)} files plus `
    + `${String(MACOS_PATTERNED_TESTS.length)} patterned canary\n`,
  );
  for (const arguments_ of macosCheckInvocations(concurrency)) {
    const child = Bun.spawn([process.execPath, ...arguments_], {
      cwd: root,
      stderr: "inherit",
      stdout: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) process.exit(exitCode);
  }
}

if (import.meta.main) {
  await runMacosCheck();
}
