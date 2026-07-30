#!/usr/bin/env bun
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { isAbsolute } from "node:path";

import { agentBrowserCommand, isolatedEnvironment, runCommand } from "./browser";
import { derivationPolicyActions } from "./derive";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

type Identity = { readonly device: string; readonly inode: string };

type Request = {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly expectedDirectory: Identity;
  readonly socketDirectory: string;
  readonly expectedSocketDirectory: Identity;
  readonly allowRemoteActions: boolean;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly arguments: readonly string[];
  readonly browserStdin: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseIdentity(value: unknown): Identity {
  if (
    !isRecord(value)
    || !exactKeys(value, ["device", "inode"])
    || typeof value.device !== "string"
    || !/^\d{1,40}$/u.test(value.device)
    || typeof value.inode !== "string"
    || !/^\d{1,40}$/u.test(value.inode)
  ) throw new Error("expected derivation directory identity is invalid");
  return { device: value.device, inode: value.inode };
}

function parseRequest(value: unknown): Request {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "requestId",
      "expectedDirectory",
      "socketDirectory",
      "expectedSocketDirectory",
      "allowRemoteActions",
      "timeoutMs",
      "maxOutputBytes",
      "arguments",
      "browserStdin",
    ])
    || value.schemaVersion !== 1
    || typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.requestId)
    || typeof value.socketDirectory !== "string"
    || !isAbsolute(value.socketDirectory)
    || value.socketDirectory.length > 4_096
    || value.socketDirectory.includes("\u0000")
    || typeof value.allowRemoteActions !== "boolean"
    || typeof value.timeoutMs !== "number"
    || !Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < 1
    || value.timeoutMs > 120_000
    || typeof value.maxOutputBytes !== "number"
    || !Number.isSafeInteger(value.maxOutputBytes)
    || value.maxOutputBytes < 1
    || value.maxOutputBytes > 10 * 1024 * 1024
    || !Array.isArray(value.arguments)
    || value.arguments.length < 1
    || value.arguments.length > 200
    || value.arguments.some((argument) => (
      typeof argument !== "string"
      || argument.length > 64 * 1024
      || argument.includes("\u0000")
      || argument === "--config"
      || argument.startsWith("--config=")
      || argument === "--action-policy"
      || argument.startsWith("--action-policy=")
    ))
    || (value.browserStdin !== null && (typeof value.browserStdin !== "string" || Buffer.byteLength(value.browserStdin, "utf8") > 5 * 1024 * 1024))
  ) throw new Error("derivation command request is invalid");
  return {
    schemaVersion: 1,
    requestId: value.requestId,
    expectedDirectory: parseIdentity(value.expectedDirectory),
    socketDirectory: value.socketDirectory,
    expectedSocketDirectory: parseIdentity(value.expectedSocketDirectory),
    allowRemoteActions: value.allowRemoteActions,
    timeoutMs: value.timeoutMs,
    maxOutputBytes: value.maxOutputBytes,
    arguments: value.arguments.map((argument) => String(argument)),
    browserStdin: value.browserStdin,
  };
}

function readBoundedStdin(): string {
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  for (;;) {
    const count = readSync(0, buffer, 0, buffer.byteLength, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_REQUEST_BYTES) throw new Error("derivation command request exceeds its byte bound");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
}

function assertBoundDirectory(expected: Identity): void {
  const descriptor = openSync(
    ".",
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0),
  );
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stats.uid;
    if (
      !stats.isDirectory()
      || stats.uid !== currentUid
      || (stats.mode & 0o777n) !== 0o700n
      || stats.dev.toString() !== expected.device
      || stats.ino.toString() !== expected.inode
    ) throw new Error("bound derivation directory no longer matches its private identity");
  } finally {
    closeSync(descriptor);
  }
}

function assertPrivateDirectoryPath(path: string, expected: Identity): void {
  const stats = lstatSync(path, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stats.uid;
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== currentUid
    || (stats.mode & 0o777n) !== 0o700n
    || stats.dev.toString() !== expected.device
    || stats.ino.toString() !== expected.inode
  ) throw new Error("derivation socket directory no longer matches its private identity");
}

function assertPrivateFile(path: string, expected: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : stats.uid;
    const expectedBytes = Buffer.from(expected, "utf8");
    if (
      !stats.isFile()
      || stats.uid !== currentUid
      || (stats.mode & 0o777n) !== 0o600n
      || stats.size !== BigInt(expectedBytes.byteLength)
    ) throw new Error(`bound derivation ${path} is unavailable or unsafe`);
    const actual = Buffer.alloc(expectedBytes.byteLength);
    let offset = 0;
    while (offset < actual.byteLength) {
      const count = readSync(descriptor, actual, offset, actual.byteLength - offset, null);
      if (count === 0) throw new Error(`bound derivation ${path} changed while reading`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== stats.dev
      || after.ino !== stats.ino
      || after.size !== stats.size
      || after.mtimeNs !== stats.mtimeNs
      || after.ctimeNs !== stats.ctimeNs
      || !actual.equals(expectedBytes)
    ) throw new Error(`bound derivation ${path} changed or is invalid`);
  } finally {
    closeSync(descriptor);
  }
}

async function main(): Promise<void> {
  const request = parseRequest(JSON.parse(readBoundedStdin()) as unknown);
  process.umask(0o077);
  assertBoundDirectory(request.expectedDirectory);
  const config = "agent-browser.json";
  const policy = "action-policy.json";
  assertPrivateFile(config, "{}\n");
  assertPrivateFile(policy, `${JSON.stringify({
    allow: derivationPolicyActions(request.allowRemoteActions),
    default: "deny",
  })}\n`);
  assertBoundDirectory(request.expectedDirectory);
  assertPrivateDirectoryPath(request.socketDirectory, request.expectedSocketDirectory);
  const result = await runCommand(
    [...agentBrowserCommand(), "--config", config, "--action-policy", policy, ...request.arguments],
    {
      cwd: ".",
      environment: isolatedEnvironment(request.socketDirectory),
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      ...(request.browserStdin === null ? {} : { stdin: request.browserStdin }),
    },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`derivation command helper: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  });
}
