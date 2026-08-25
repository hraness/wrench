#!/usr/bin/env bun
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

import {
  DERIVATION_GUARD_PROXY_CONFIG,
  DERIVATION_GUARD_PROXY_READY,
  derivationGuardControlSocketPath,
  parseProxyHelperConfig,
  proxyHelperReadyContent,
  verifyGuardPrivateFile,
  writeGuardPrivateFile,
  type GuardDirectoryIdentity,
} from "./derivation-network-guard";
import { startDerivationNetworkProxy } from "./derivation-network-proxy";
import { captureProcessOwnerIdentity, processOwnerStatus } from "./process-identity";

const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_CONTROL_BYTES = 8 * 1024;
const ADOPTION_TIMEOUT_MS = 30_000;
const helperFailureEnvironmentKey = "WRENCH_DERIVATION_PROXY_FAIL_FOR_TEST";

type HelperFailureStage = "after-proxy" | "after-control-listen" | "after-ready-write";

function injectFailureForTest(stage: HelperFailureStage): void {
  if (
    process.env.NODE_ENV === "test"
    && process.env[helperFailureEnvironmentKey] === stage
  ) throw new Error("injected derivation proxy helper failure");
}

function currentUserOwns(uid: number | bigint): boolean {
  const current = typeof process.getuid === "function" ? process.getuid() : undefined;
  return current === undefined || uid === (typeof uid === "bigint" ? BigInt(current) : current);
}

function sameIdentity(left: GuardDirectoryIdentity, right: GuardDirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function exactOwnerIsLive(owner: ReturnType<typeof captureProcessOwnerIdentity>): boolean {
  try {
    return processOwnerStatus(owner) === "exact-live-owner";
  } catch {
    return false;
  }
}

function removeAbandonedSocketDirectory(
  path: string,
  expected: GuardDirectoryIdentity,
): void {
  try {
    if (!sameIdentity(inspectPrivateDirectory(path), expected)) return;
    rmdirSync(path);
  } catch {
    // Unexpected or replaced contents preserve the private root for explicit
    // recovery instead of widening automatic cleanup.
  }
}

function removeProvisionalReadyFile(
  expectedContent: string,
  expected: ReturnType<typeof writeGuardPrivateFile>,
): boolean {
  try {
    verifyGuardPrivateFile(DERIVATION_GUARD_PROXY_READY, expected, expectedContent);
    unlinkSync(DERIVATION_GUARD_PROXY_READY);
    return true;
  } catch {
    return false;
  }
}

function provisionalReadyFileIsAbsent(): boolean {
  try {
    lstatSync(DERIVATION_GUARD_PROXY_READY);
    return false;
  } catch (error) {
    return typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT";
  }
}

function inspectPrivateDirectory(path: string): GuardDirectoryIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !currentUserOwns(stats.uid)
    || (stats.mode & 0o777n) !== 0o700n
  ) throw new Error("derivation proxy directory is unavailable or unsafe");
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function inspectPrivateControlSocket(path: string): GuardDirectoryIdentity {
  const stats = lstatSync(path, { bigint: true });
  if (
    !stats.isSocket()
    || stats.isSymbolicLink()
    || !currentUserOwns(stats.uid)
    || (stats.mode & 0o777n) !== 0o600n
  ) throw new Error("derivation proxy control socket is unavailable or unsafe");
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function unlinkExactControlSocket(
  path: string,
  expected: GuardDirectoryIdentity | null,
): void {
  if (expected === null) return;
  try {
    if (sameIdentity(inspectPrivateControlSocket(path), expected)) unlinkSync(path);
  } catch {
    // Invariant: teardown never calls the listener close API, because Bun may unlink
    // a rebound path. Only this exact identity check may remove the pathname;
    // process exit closes the already-unreferenced listener file descriptor.
  }
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => socket.destroy(), 5_000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("close", finish);
      resolve();
    };
    socket.once("close", finish);
  });
}

function readPrivateConfig(): unknown {
  const descriptor = openSync(
    DERIVATION_GUARD_PROXY_CONFIG,
    constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || !currentUserOwns(before.uid)
      || (before.mode & 0o777n) !== 0o600n
      || before.size < 1n
      || before.size > BigInt(MAX_CONFIG_BYTES)
    ) throw new Error("derivation proxy config is unavailable or unsafe");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) throw new Error("derivation proxy config changed size");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) throw new Error("derivation proxy config changed while reading");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function parseControlRequest(value: unknown): {
  readonly command: "status" | "adopt" | "close";
  readonly derivationId: string;
  readonly nonce: string;
  readonly policySha256: string;
} {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, [
      "schemaVersion", "command", "derivationId", "nonce", "policySha256",
    ])
  ) throw new Error("invalid control request");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || (record.command !== "status" && record.command !== "adopt" && record.command !== "close")
    || typeof record.derivationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.derivationId)
    || typeof record.nonce !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.nonce)
    || typeof record.policySha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.policySha256)
  ) throw new Error("invalid control request");
  return {
    command: record.command,
    derivationId: record.derivationId,
    nonce: record.nonce,
    policySha256: record.policySha256,
  };
}

function readControlRequest(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => fail(new Error("control request timed out")), 5_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.byteLength;
      if (total > MAX_CONTROL_BYTES) {
        fail(new Error("control request is too large"));
        return;
      }
      chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks, total);
      const newline = bytes.indexOf(0x0a);
      if (newline === -1) return;
      if (newline !== bytes.byteLength - 1) {
        fail(new Error("control request has invalid framing"));
        return;
      }
      settled = true;
      cleanup();
      try {
        resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, newline),
        )) as unknown);
      } catch (error) {
        reject(error);
      }
    };
    const onEnd = (): void => {
      fail(new Error("control request ended before its delimiter"));
    };
    const onError = (error: Error): void => fail(error);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

async function main(): Promise<void> {
  process.umask(0o077);
  const config = parseProxyHelperConfig(readPrivateConfig());
  if (!sameIdentity(inspectPrivateDirectory("."), config.directoryIdentity)) {
    throw new Error("derivation proxy working directory changed identity");
  }
  if (!sameIdentity(inspectPrivateDirectory(config.socketDirectory), config.socketIdentity)) {
    throw new Error("derivation proxy socket directory changed identity");
  }
  const controlPath = derivationGuardControlSocketPath(config.derivationId);
  try {
    lstatSync(controlPath);
    throw new Error("derivation proxy control socket already exists");
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }

  const proxy = await startDerivationNetworkProxy({
    browserDomains: config.browserDomains,
    timeoutMs: 60_000,
    maxTransferredBytes: 2 * 1024 * 1024 * 1024,
  });
  let control: Server | null = null;
  let controlIdentity: GuardDirectoryIdentity | null = null;
  let controlListen: Promise<void> | null = null;
  const controlSockets = new Set<Socket>();
  let readyContent: string | null = null;
  let readyFile: ReturnType<typeof writeGuardPrivateFile> | null = null;
  let stopping: Promise<void> | null = null;
  let adopted = false;
  const adoptionDeadline = Date.now() + ADOPTION_TIMEOUT_MS;
  const stop = (abandon = false, acknowledgement: Socket | null = null): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      if (controlListen !== null) await controlListen.catch(() => undefined);
      try {
        control?.unref();
      } catch {
        // A listener that never reached readiness has no referenced endpoint.
      }
      for (const socket of controlSockets) {
        if (socket !== acknowledgement) socket.destroy();
      }
      unlinkExactControlSocket(controlPath, controlIdentity);
      await proxy.close().catch(() => undefined);
      if (acknowledgement !== null) await waitForSocketClose(acknowledgement);
      if (abandon) {
        const readyRemoved = readyContent !== null && readyFile !== null
          ? removeProvisionalReadyFile(readyContent, readyFile)
          : provisionalReadyFileIsAbsent();
        if (readyRemoved) {
          removeAbandonedSocketDirectory(config.socketDirectory, config.socketIdentity);
        }
      }
    })();
    return stopping;
  };
  const onTermination = (): void => { void stop(!adopted); };
  process.once("SIGTERM", onTermination);
  process.once("SIGINT", onTermination);
  const parentWatch = setInterval(() => {
    if (
      !adopted
      && (
        Date.now() >= adoptionDeadline
        || !exactOwnerIsLive(config.parentOwner)
      )
    ) void stop(true);
  }, 10);

  try {
    injectFailureForTest("after-proxy");
    const owner = captureProcessOwnerIdentity(process.pid);
    control = createServer({ allowHalfOpen: true }, (socket) => {
      controlSockets.add(socket);
      socket.once("close", () => controlSockets.delete(socket));
      if (stopping !== null) {
        socket.destroy();
        return;
      }
      void (async () => {
        try {
          const request = parseControlRequest(await readControlRequest(socket));
          if (stopping !== null) throw new Error("derivation proxy helper is stopping");
          if (
            request.derivationId !== config.derivationId
            || request.nonce !== config.controlNonce
            || request.policySha256 !== config.policySha256
          ) throw new Error("control binding mismatch");
          if (request.command === "adopt") {
            if (!exactOwnerIsLive(config.parentOwner)) {
              throw new Error("derivation proxy parent changed before adoption");
            }
            adopted = true;
          }
          socket.end(`${JSON.stringify({
            schemaVersion: 1,
            ok: true,
            derivationId: config.derivationId,
            policySha256: config.policySha256,
            port: proxy.port,
            owner,
            adopted,
          })}\n`);
          if (request.command === "close") await stop(!adopted, socket);
        } catch {
          socket.destroy();
        }
      })();
    });
    control.maxConnections = 16;
    controlListen = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      control?.once("error", onError);
      control?.listen(controlPath, () => {
        control?.off("error", onError);
        try {
          chmodSync(controlPath, 0o600);
          controlIdentity = inspectPrivateControlSocket(controlPath);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await controlListen;
    if (stopping !== null) throw new Error("derivation proxy helper stopped during initialization");
    injectFailureForTest("after-control-listen");
    readyContent = proxyHelperReadyContent({
      schemaVersion: 1,
      kind: "wrench-derivation-proxy-ready",
      derivationId: config.derivationId,
      policySha256: config.policySha256,
      port: proxy.port,
      owner,
    });
    readyFile = writeGuardPrivateFile(DERIVATION_GUARD_PROXY_READY, readyContent);
    injectFailureForTest("after-ready-write");
    for (;;) {
      if (stopping !== null) {
        await stopping;
        return;
      }
      await Bun.sleep(10);
    }
  } catch {
    await stop(!adopted);
    throw new Error("derivation proxy helper initialization failed");
  } finally {
    clearInterval(parentWatch);
    process.off("SIGTERM", onTermination);
    process.off("SIGINT", onTermination);
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
