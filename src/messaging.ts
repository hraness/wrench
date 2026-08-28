import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  parseMessagingContextRequestV1,
  parseMessagingContextV1,
  parseMessagingPreviewV1,
  parseMessagingPrivateOutputReceiptV1,
  parseMessagingRouteResolveRequestV2,
  parseMessagingRouteV2,
  parseMessagingRoutesRequestV1,
  parseMessagingRoutesV2,
  parseMessagingTurnV1,
  type MessagingClientOptions,
  type MessagingContextRequestV1,
  type MessagingContextV1,
  type MessagingPreviewV1,
  type MessagingRouteResolveRequestV2,
  type MessagingRouteV2,
  type MessagingRoutesRequestV1,
  type MessagingRoutesV2,
  type MessagingTurnV1,
} from "./messaging-types";

export * from "./messaging-types";

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_TERMINATION_GRACE_MS = 1_000;

function cliSourcePath(): string {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource)) return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource)) return packagedSource;
  throw new Error("the installed Wrench CLI source is unavailable");
}

function environmentSnapshot(
  overrides: MessagingClientOptions["environment"],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) result[key] = value;
  }
  if (overrides !== undefined) {
    if (
      typeof overrides !== "object"
      || overrides === null
      || Array.isArray(overrides)
      || Object.getPrototypeOf(overrides) !== Object.prototype
    ) throw new Error("Wrench messaging environment must be a plain object");
    for (const [key, value] of Object.entries(overrides)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error("Wrench messaging environment contains an invalid name");
      }
      if (value === undefined) delete result[key];
      else if (
        typeof value !== "string"
        || Buffer.byteLength(value, "utf8") > 128 * 1024
        || value.includes("\0")
      ) throw new Error("Wrench messaging environment contains an invalid value");
      else result[key] = value;
    }
  }
  return Object.freeze(result);
}

function options(
  value: MessagingClientOptions | undefined,
): Readonly<{
  environment: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}> {
  if (value === undefined) return Object.freeze({ environment: environmentSnapshot(undefined) });
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some((key) => key !== "environment" && key !== "signal")
  ) throw new Error("Wrench messaging options are malformed");
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    throw new Error("Wrench messaging signal is malformed");
  }
  return Object.freeze({
    environment: environmentSnapshot(value.environment),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  });
}

function boundedError(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_STDERR_BYTES).trim();
}

async function runCli(
  operation: "routes" | "resolve" | "context" | "preview",
  request: unknown,
  clientOptions: MessagingClientOptions | undefined,
): Promise<unknown> {
  if (typeof process.versions.bun !== "string") {
    throw new Error("@hraness/wrench/messaging requires Bun to run the installed Wrench CLI");
  }
  const prepared = options(clientOptions);
  if (prepared.signal?.aborted === true) {
    throw prepared.signal.reason instanceof Error
      ? prepared.signal.reason
      : new DOMException("Wrench messaging operation was aborted", "AbortError");
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "wrench-messaging-"));
  const privateOutput = join(temporaryDirectory, "artifact.json");
  try {
    const result = await new Promise<Readonly<{
      code: number;
      stdout: Buffer;
      stderr: readonly Buffer[];
    }>>((resolve, reject) => {
      const child = spawn(process.execPath, [
        cliSourcePath(),
        "messaging",
        operation,
        "--input",
        "-",
        "--private-output",
        privateOutput,
        "--json",
      ], {
        env: prepared.environment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let pendingError: Error | null = null;
      let terminationTimer: ReturnType<typeof setTimeout> | null = null;
      const settleFailure = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (terminationTimer !== null) clearTimeout(terminationTimer);
        prepared.signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const signalOwnedTree = (signal: "SIGTERM" | "SIGKILL"): void => {
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // The close event remains the authoritative reaping proof.
        }
      };
      const ownedTreeIsAlive = (): boolean => {
        if (process.platform === "win32" || child.pid === undefined) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const rejectAfterOwnedTreeExit = (): void => {
        signalOwnedTree("SIGKILL");
        if (!ownedTreeIsAlive()) {
          settleFailure(pendingError ?? new Error("Wrench messaging operation failed"));
          return;
        }
        setTimeout(rejectAfterOwnedTreeExit, 10);
      };
      const requestTermination = (error: Error): void => {
        pendingError ??= error;
        if (child.pid === undefined) {
          settleFailure(pendingError);
          return;
        }
        if (terminationTimer !== null) return;
        signalOwnedTree("SIGTERM");
        terminationTimer = setTimeout(() => signalOwnedTree("SIGKILL"), COMMAND_TERMINATION_GRACE_MS);
        terminationTimer.unref?.();
      };
      const abort = (): void => {
        requestTermination(
          prepared.signal?.reason instanceof Error
            ? prepared.signal.reason
            : new DOMException("Wrench messaging operation was aborted", "AbortError"),
        );
      };
      const timer = setTimeout(() => {
        requestTermination(new Error("Wrench messaging operation timed out"));
      }, COMMAND_TIMEOUT_MS);
      timer.unref?.();
      prepared.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", (error) => requestTermination(error));
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          requestTermination(new Error("Wrench messaging receipt exceeded its byte bound"));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_STDERR_BYTES) {
          requestTermination(new Error("Wrench messaging diagnostic exceeded its byte bound"));
          return;
        }
        stderr.push(Buffer.from(chunk));
      });
      child.on("close", (code) => {
        if (settled) return;
        clearTimeout(timer);
        if (terminationTimer !== null) clearTimeout(terminationTimer);
        prepared.signal?.removeEventListener("abort", abort);
        if (pendingError !== null) {
          rejectAfterOwnedTreeExit();
          return;
        }
        settled = true;
        resolve(Object.freeze({
          code: code ?? 3,
          stdout: Buffer.concat(stdout),
          stderr: Object.freeze(stderr),
        }));
      });
      child.stdin.on("error", (error) => requestTermination(error));
      child.stdin.end(`${canonicalJson(request)}\n`, "utf8");
    });
    if (result.code !== 0) {
      throw new Error(boundedError(result.stderr) || `Wrench messaging exited ${result.code}`);
    }
    let receiptValue: unknown;
    try {
      receiptValue = JSON.parse(result.stdout.toString("utf8")) as unknown;
    } catch {
      throw new Error("Wrench messaging returned a malformed receipt");
    }
    const receipt = parseMessagingPrivateOutputReceiptV1(receiptValue);
    const expectedFormat = operation === "routes"
      ? "wrench.messaging-routes"
      : operation === "resolve"
        ? "wrench.messaging-route"
        : operation === "context"
          ? "wrench.messaging-context"
          : "wrench.messaging-preview";
    if (receipt.artifactFormat !== expectedFormat) {
      throw new Error("Wrench messaging returned another private artifact contract");
    }
    const stats = lstatSync(privateOutput);
    const currentUid = process.getuid?.();
    if (
      !stats.isFile()
      || currentUid === undefined
      || stats.uid !== currentUid
      || (stats.mode & 0o777) !== 0o600
      || stats.size > MAX_ARTIFACT_BYTES
    ) throw new Error("Wrench messaging private artifact is not an owned mode-0600 file");
    const artifactText = readFileSync(privateOutput, "utf8");
    let artifact: unknown;
    try {
      artifact = JSON.parse(artifactText) as unknown;
    } catch {
      throw new Error("Wrench messaging private artifact is malformed JSON");
    }
    if (sha256(canonicalJson(artifact)) !== receipt.artifactSha256) {
      throw new Error("Wrench messaging private artifact does not match its receipt");
    }
    return artifact;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function discoverMessagingRoutes(
  request: MessagingRoutesRequestV1,
  clientOptions?: MessagingClientOptions,
): Promise<MessagingRoutesV2> {
  const value = parseMessagingRoutesV2(await runCli(
    "routes",
    parseMessagingRoutesRequestV1(request),
    clientOptions,
  ));
  return value;
}

export async function resolveMessagingRoute(
  request: MessagingRouteResolveRequestV2,
  clientOptions?: MessagingClientOptions,
): Promise<MessagingRouteV2> {
  return parseMessagingRouteV2(await runCli(
    "resolve",
    parseMessagingRouteResolveRequestV2(request),
    clientOptions,
  ));
}

export async function readMessagingContext(
  request: MessagingContextRequestV1,
  clientOptions?: MessagingClientOptions,
): Promise<MessagingContextV1> {
  return parseMessagingContextV1(await runCli(
    "context",
    parseMessagingContextRequestV1(request),
    clientOptions,
  ));
}

export async function previewMessagingTurn(
  request: MessagingTurnV1,
  clientOptions?: MessagingClientOptions,
): Promise<MessagingPreviewV1> {
  return parseMessagingPreviewV1(await runCli(
    "preview",
    parseMessagingTurnV1(request),
    clientOptions,
  ));
}
