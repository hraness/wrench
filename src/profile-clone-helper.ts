#!/usr/bin/env bun
import { closeSync, constants, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { isAbsolute } from "node:path";

import { cloneBrowserProfile } from "./browser";

const MAX_REQUEST_BYTES = 16 * 1024;

type Identity = { readonly device: string; readonly inode: string };

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
  ) throw new Error("expected profile destination identity is invalid");
  return { device: value.device, inode: value.inode };
}

function readBoundedStdin(): string {
  const buffer = Buffer.allocUnsafe(MAX_REQUEST_BYTES + 1);
  let total = 0;
  for (;;) {
    const count = readSync(0, buffer, total, buffer.byteLength - total, null);
    if (count === 0) break;
    total += count;
    if (total > MAX_REQUEST_BYTES) throw new Error("profile clone request exceeds its byte bound");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
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
    ) throw new Error("bound profile destination no longer matches its private identity");
  } finally {
    closeSync(descriptor);
  }
}

function main(): void {
  const value = JSON.parse(readBoundedStdin()) as unknown;
  if (
    !isRecord(value)
    || !exactKeys(value, ["schemaVersion", "requestId", "expectedDirectory", "source"])
    || value.schemaVersion !== 1
    || typeof value.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.requestId)
    || typeof value.source !== "string"
    || !isAbsolute(value.source)
    || value.source.length > 4_096
    || value.source.includes("\u0000")
  ) throw new Error("profile clone request is invalid");
  const expected = parseIdentity(value.expectedDirectory);
  assertBoundDirectory(expected);
  try {
    const cloned = cloneBrowserProfile(value.source, ".");
    assertBoundDirectory(expected);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      profile: cloned.profileDirectory === "Default" ? "profile-user-data" : "profile",
      profileDirectory: cloned.profileDirectory ?? null,
    })}\n`);
  } catch (error) {
    rmSync("profile", { recursive: true, force: true });
    rmSync("profile-user-data", { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`profile clone helper: ${error instanceof Error ? error.message : "unknown failure"}\n`);
    process.exitCode = 1;
  }
}
