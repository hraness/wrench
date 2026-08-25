import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { connect as connectLocal, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDerivationGuardExtension,
  DERIVATION_GUARD_PROXY_CONFIG,
  DERIVATION_GUARD_PROXY_READY,
  derivationGuardControlSocketPath,
  derivationProxyPolicySha256,
  parseProxyHelperConfig,
  parseProxyHelperReady,
  proxyHelperConfigContent,
  proxyHelperReadyContent,
  readGuardPrivateFile,
  verifyDerivationGuardExtension,
  verifyGuardPrivateFile,
  writeGuardPrivateFile,
  type DerivationNetworkGuard,
  type DerivationProxyHelperConfig,
  type GuardDirectoryIdentity,
} from "./derivation-network-guard";
import { sha256 } from "./canonical-json";
import {
  captureProcessOwnerIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
  type ProcessOwnerStatus,
} from "./process-identity";

const proxyHelperPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "derivation-network-proxy-helper.ts",
);
const trustedBunConfigPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "state-helper.bunfig.toml",
);
const PROXY_START_TIMEOUT_MS = 15_000;
const PROXY_CONTROL_TIMEOUT_MS = 5_000;
const PROXY_CONTROL_MAX_BYTES = 64 * 1024;
const helperFailureEnvironmentKey = "WRENCH_DERIVATION_PROXY_FAIL_FOR_TEST";

export type DerivationProxyHelperFailureForTest =
  | "after-proxy"
  | "after-control-listen"
  | "after-ready-write";

type ProxyControlResponse = {
  readonly schemaVersion: 1;
  readonly ok: true;
  readonly derivationId: string;
  readonly policySha256: string;
  readonly port: number;
  readonly owner: ProcessOwnerIdentity;
  readonly adopted: boolean;
};

type BoundaryDependencies = {
  readonly inspectOwner: (owner: ProcessOwnerIdentity) => ProcessOwnerStatus;
};

export class UnsafeDerivationNetworkBoundaryCleanupError extends Error {
  constructor(cause: unknown) {
    super(
      "derivation network helper could not be proved quiescent; private state was preserved",
      { cause },
    );
    this.name = "UnsafeDerivationNetworkBoundaryCleanupError";
  }
}

class DerivationProxyControlUnavailableError extends Error {
  readonly code: "ENOENT" | "ECONNREFUSED";

  constructor(code: "ENOENT" | "ECONNREFUSED", cause: unknown) {
    super("derivation proxy control is unavailable", { cause });
    this.name = "DerivationProxyControlUnavailableError";
    this.code = code;
  }
}

class DerivationProxyControlMissingError extends Error {
  constructor() {
    super("derivation proxy control is missing");
    this.name = "DerivationProxyControlMissingError";
  }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function parseOwner(value: unknown): ProcessOwnerIdentity {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, ["pid", "bootId", "processStartId"])
  ) throw new Error("derivation proxy control response is malformed");
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || typeof record.bootId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.bootId)
    || typeof record.processStartId !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.processStartId)
  ) throw new Error("derivation proxy control response is malformed");
  return {
    pid: record.pid as number,
    bootId: record.bootId,
    processStartId: record.processStartId,
  };
}

function parseControlResponse(value: unknown): ProxyControlResponse {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !exactKeys(value as Record<string, unknown>, [
      "schemaVersion", "ok", "derivationId", "policySha256", "port", "owner", "adopted",
    ])
  ) throw new Error("derivation proxy control response is malformed");
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || record.ok !== true
    || typeof record.derivationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.derivationId)
    || typeof record.policySha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.policySha256)
    || !Number.isSafeInteger(record.port)
    || (record.port as number) < 1
    || (record.port as number) > 65_535
    || typeof record.adopted !== "boolean"
  ) throw new Error("derivation proxy control response is malformed");
  return {
    schemaVersion: 1,
    ok: true,
    derivationId: record.derivationId,
    policySha256: record.policySha256,
    port: record.port as number,
    owner: parseOwner(record.owner),
    adopted: record.adopted,
  };
}

function sameOwner(left: ProcessOwnerIdentity, right: ProcessOwnerIdentity): boolean {
  return left.pid === right.pid
    && left.bootId === right.bootId
    && left.processStartId === right.processStartId;
}

function currentUserOwns(uid: number | bigint): boolean {
  return typeof process.getuid !== "function" || BigInt(process.getuid()) === BigInt(uid);
}

function pathIsAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return true;
    throw error;
  }
}

function assertPrivateDirectoryIdentity(
  path: string,
  expected: GuardDirectoryIdentity,
): void {
  const stats = lstatSync(path, { bigint: true });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || !currentUserOwns(stats.uid)
    || (stats.mode & 0o777n) !== 0o700n
    || stats.dev.toString() !== expected.device
    || stats.ino.toString() !== expected.inode
  ) throw new Error("derivation proxy evidence directory changed identity");
}

/**
 * Return true only for an absent endpoint. An existing path must be the exact
 * private socket shape before Wrench will connect to it or consider fallback.
 */
function privateControlSocketIsAbsent(path: string): boolean {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (
      !stats.isSocket()
      || stats.isSymbolicLink()
      || !currentUserOwns(stats.uid)
      || (stats.mode & 0o777n) !== 0o600n
    ) throw new Error("derivation proxy control path is unsafe");
    return false;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return true;
    throw error;
  }
}

type ProxyControlBinding = {
  readonly controlNonce: string;
  readonly policySha256: string;
};

function proxyControl(
  socketPath: string,
  derivationId: string,
  command: "status" | "adopt" | "close",
  binding: ProxyControlBinding,
): Promise<ProxyControlResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connectLocal({ path: socketPath });
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let connected = false;
    const timer = setTimeout(() => fail(new Error("derivation proxy control timed out")), PROXY_CONTROL_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => {
      connected = true;
      socket.write(`${JSON.stringify({
        schemaVersion: 1,
        command,
        derivationId,
        nonce: binding.controlNonce,
        policySha256: binding.policySha256,
      })}\n`);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.byteLength;
      if (total > PROXY_CONTROL_MAX_BYTES) {
        fail(new Error("derivation proxy control response is too large"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, total),
        );
        resolve(parseControlResponse(JSON.parse(text) as unknown));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("derivation proxy control failed"));
      }
    };
    const onError = (error: Error): void => {
      const code = "code" in error ? error.code : undefined;
      if (!connected && (code === "ENOENT" || code === "ECONNREFUSED")) {
        fail(new DerivationProxyControlUnavailableError(code, error));
        return;
      }
      fail(new Error("derivation proxy control failed", { cause: error }));
    };
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

async function proxyControlAtBoundPath(input: {
  readonly derivationId: string;
  readonly command: "status" | "adopt" | "close";
  readonly binding: ProxyControlBinding;
}): Promise<ProxyControlResponse> {
  const path = derivationGuardControlSocketPath(input.derivationId);
  if (privateControlSocketIsAbsent(path)) throw new DerivationProxyControlMissingError();
  try {
    const response = await proxyControl(
      path,
      input.derivationId,
      input.command,
      input.binding,
    );
    if (response.derivationId !== input.derivationId) {
      throw new Error("derivation proxy control changed derivation identity");
    }
    return response;
  } catch (error) {
    // Only an absent/refused current endpoint permits the exact-owner cleanup
    // migration. Malformed, foreign, reset, and timed-out responses preserve.
    if (error instanceof DerivationProxyControlUnavailableError) {
      const absent = privateControlSocketIsAbsent(path);
      if (error.code === "ENOENT" && absent) {
        throw new DerivationProxyControlMissingError();
      }
      if (absent) throw new DerivationProxyControlMissingError();
    }
    throw error;
  }
}

async function waitForProxyOwnerQuiescence(
  owner: ProcessOwnerIdentity,
  inspectOwner: BoundaryDependencies["inspectOwner"],
): Promise<void> {
  const deadline = Date.now() + PROXY_CONTROL_TIMEOUT_MS;
  for (;;) {
    const status = inspectOwner(owner);
    if (status === "different-or-dead") return;
    if (status === "unknown") {
      throw new Error("derivation network proxy cleanup cannot prove process quiescence");
    }
    if (Date.now() >= deadline) {
      throw new Error("derivation network proxy cleanup did not settle");
    }
    await Bun.sleep(25);
  }
}

async function signalBoundOwnerAtAbsentControl(input: {
  readonly derivationId: string;
  readonly owner: ProcessOwnerIdentity;
  readonly dependencies?: Partial<BoundaryDependencies>;
}): Promise<void> {
  const controlPath = derivationGuardControlSocketPath(input.derivationId);
  if (!privateControlSocketIsAbsent(controlPath)) {
    throw new Error("derivation proxy control endpoint could not be authenticated for cleanup");
  }
  const inspectOwner = input.dependencies?.inspectOwner ?? processOwnerStatus;
  const initial = inspectOwner(input.owner);
  if (initial === "different-or-dead") return;
  if (initial !== "exact-live-owner") {
    throw new Error("derivation network proxy owner cannot be verified for cleanup");
  }
  const rebound = inspectOwner(input.owner);
  if (rebound === "different-or-dead") return;
  if (rebound !== "exact-live-owner") {
    throw new Error("derivation network proxy owner cannot be verified for cleanup");
  }
  if (!privateControlSocketIsAbsent(controlPath)) {
    throw new Error("derivation proxy control endpoint appeared before cleanup");
  }
  try {
    process.kill(input.owner.pid, "SIGTERM");
  } catch (signalError) {
    const afterSignal = inspectOwner(input.owner);
    if (afterSignal === "different-or-dead") return;
    throw new Error("derivation network proxy owner could not be terminated", {
      cause: signalError,
    });
  }
  await waitForProxyOwnerQuiescence(input.owner, inspectOwner);
  if (!privateControlSocketIsAbsent(controlPath)) {
    throw new Error("derivation proxy control endpoint appeared during cleanup");
  }
}

/**
 * Recover an interrupted initialization only from its exact private config and
 * readiness records. No caller-supplied PID is accepted by this boundary.
 */
export async function closeInterruptedDerivationNetworkBoundary(input: {
  readonly derivationId: string;
  readonly directory: string;
  readonly directoryIdentity: GuardDirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: GuardDirectoryIdentity;
  readonly dependencies?: Partial<BoundaryDependencies>;
}): Promise<ProcessOwnerIdentity | null> {
  const controlPath = derivationGuardControlSocketPath(input.derivationId);
  assertPrivateDirectoryIdentity(input.directory, input.directoryIdentity);
  const readyPath = join(input.directory, DERIVATION_GUARD_PROXY_READY);
  if (pathIsAbsent(readyPath)) {
    assertPrivateDirectoryIdentity(input.directory, input.directoryIdentity);
    if (!privateControlSocketIsAbsent(controlPath)) {
      throw new Error("interrupted derivation has an unbound network control endpoint");
    }
    return null;
  }

  const configPath = join(input.directory, DERIVATION_GUARD_PROXY_CONFIG);
  const configRead = readGuardPrivateFile(configPath, 128 * 1024);
  const readyRead = readGuardPrivateFile(readyPath, 64 * 1024);
  let configValue: unknown;
  let readyValue: unknown;
  try {
    configValue = JSON.parse(configRead.content) as unknown;
    readyValue = JSON.parse(readyRead.content) as unknown;
  } catch (error) {
    throw new Error("interrupted derivation network evidence is malformed", { cause: error });
  }
  const config = parseProxyHelperConfig(configValue);
  const ready = parseProxyHelperReady(readyValue);
  if (
    config.derivationId !== input.derivationId
    || ready.derivationId !== input.derivationId
    || config.directoryIdentity.device !== input.directoryIdentity.device
    || config.directoryIdentity.inode !== input.directoryIdentity.inode
    || config.socketDirectory !== input.socketDirectory
    || config.socketIdentity.device !== input.socketIdentity.device
    || config.socketIdentity.inode !== input.socketIdentity.inode
    || ready.policySha256 !== config.policySha256
  ) throw new Error("interrupted derivation network evidence changed identity");
  verifyGuardPrivateFile(
    configPath,
    configRead.evidence,
    proxyHelperConfigContent(config),
  );
  verifyGuardPrivateFile(
    readyPath,
    readyRead.evidence,
    proxyHelperReadyContent(ready),
  );
  assertPrivateDirectoryIdentity(input.directory, input.directoryIdentity);

  const inspectOwner = input.dependencies?.inspectOwner ?? processOwnerStatus;
  let statusResponse: ProxyControlResponse;
  try {
    statusResponse = await proxyControlAtBoundPath({
      derivationId: input.derivationId,
      command: "status",
      binding: config,
    });
  } catch (error) {
    if (!(error instanceof DerivationProxyControlMissingError)) throw error;
    await signalBoundOwnerAtAbsentControl({
      derivationId: input.derivationId,
      owner: ready.owner,
      dependencies: { inspectOwner },
    });
    return ready.owner;
  }
  if (
    statusResponse.policySha256 !== ready.policySha256
    || statusResponse.port !== ready.port
    || !sameOwner(statusResponse.owner, ready.owner)
  ) throw new Error("interrupted derivation network status changed identity");
  if (inspectOwner(ready.owner) !== "exact-live-owner") {
    throw new Error("interrupted derivation network owner cannot be verified");
  }

  let closeResponse: ProxyControlResponse;
  try {
    closeResponse = await proxyControlAtBoundPath({
      derivationId: input.derivationId,
      command: "close",
      binding: config,
    });
  } catch (error) {
    if (!(error instanceof DerivationProxyControlMissingError)) throw error;
    await signalBoundOwnerAtAbsentControl({
      derivationId: input.derivationId,
      owner: ready.owner,
      dependencies: { inspectOwner },
    });
    return ready.owner;
  }
  if (
    closeResponse.policySha256 !== ready.policySha256
    || closeResponse.port !== ready.port
    || !sameOwner(closeResponse.owner, ready.owner)
  ) throw new Error("interrupted derivation network control changed identity");
  await waitForProxyOwnerQuiescence(ready.owner, inspectOwner);
  if (!privateControlSocketIsAbsent(controlPath)) {
    throw new Error("interrupted derivation control endpoint remains after cleanup");
  }
  return ready.owner;
}

function expectedProxyConfig(input: {
  readonly derivationId: string;
  readonly directoryIdentity: GuardDirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: GuardDirectoryIdentity;
  readonly browserDomains: readonly string[];
  readonly parentOwner: ProcessOwnerIdentity;
  readonly controlNonce: string;
  readonly policySha256: string;
}): DerivationProxyHelperConfig {
  return Object.freeze({
    schemaVersion: 1,
    kind: "wrench-derivation-proxy-config",
    ...input,
  });
}

export async function createDerivationNetworkBoundary(input: {
  readonly derivationId: string;
  readonly directory: string;
  readonly directoryIdentity: GuardDirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: GuardDirectoryIdentity;
  readonly browserDomains: readonly string[];
  readonly failHelperAtForTest?: DerivationProxyHelperFailureForTest;
}): Promise<DerivationNetworkGuard> {
  derivationGuardControlSocketPath(input.derivationId);
  if (input.failHelperAtForTest !== undefined && process.env.NODE_ENV !== "test") {
    throw new Error("derivation proxy helper fault injection is available only in tests");
  }
  const extension = createDerivationGuardExtension(input.directory, input.browserDomains);
  const policySha256 = derivationProxyPolicySha256(input.browserDomains);
  const controlNonce = randomBytes(32).toString("hex");
  const parentOwner = captureProcessOwnerIdentity(process.pid);
  const config = expectedProxyConfig({
    derivationId: input.derivationId,
    directoryIdentity: input.directoryIdentity,
    socketDirectory: input.socketDirectory,
    socketIdentity: input.socketIdentity,
    browserDomains: input.browserDomains,
    parentOwner,
    controlNonce,
    policySha256,
  });
  const configFile = writeGuardPrivateFile(
    join(input.directory, DERIVATION_GUARD_PROXY_CONFIG),
    proxyHelperConfigContent(config),
  );
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    "--no-install",
    "--no-macros",
    "--no-addons",
    `--config=${trustedBunConfigPath}`,
    proxyHelperPath,
  ], {
    cwd: input.directory,
    env: input.failHelperAtForTest === undefined
      ? { NODE_ENV: "production" }
      : {
          NODE_ENV: "test",
          [helperFailureEnvironmentKey]: input.failHelperAtForTest,
        },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  const readyPath = join(input.directory, DERIVATION_GUARD_PROXY_READY);
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
  let readyRead: ReturnType<typeof readGuardPrivateFile> | null = null;
  try {
    for (;;) {
      if (existsSync(readyPath)) {
        try {
          readyRead = readGuardPrivateFile(readyPath, 64 * 1024);
          break;
        } catch {
          // The helper creates the ready path with O_EXCL before the write
          // finishes. Keep polling until the file is complete or the deadline.
        }
      }
      const exit = await Promise.race([
        child.exited.then((code) => ({ exited: true as const, code })),
        Bun.sleep(25).then(() => ({ exited: false as const, code: 0 })),
      ]);
      if (exit.exited) throw new Error("derivation proxy helper exited before readiness");
      if (Date.now() >= deadline) throw new Error("derivation proxy helper readiness timed out");
    }
    const ready = parseProxyHelperReady(JSON.parse(readyRead.content) as unknown);
    if (
      ready.derivationId !== input.derivationId
      || ready.policySha256 !== policySha256
      || ready.owner.pid !== child.pid
      || processOwnerStatus(ready.owner) !== "exact-live-owner"
    ) throw new Error("derivation proxy helper readiness did not match its launch");
    const guard: DerivationNetworkGuard = Object.freeze({
      schemaVersion: 1,
      kind: "contained-mv3-dnr-proxy",
      extension,
      proxy: Object.freeze({
        policySha256,
        controlNonce,
        port: ready.port,
        owner: ready.owner,
        parentOwner,
        configFile,
        readyFile: readyRead.evidence,
      }),
    });
    const response = await proxyControlAtBoundPath({
      derivationId: input.derivationId,
      command: "status",
      binding: guard.proxy,
    });
    if (
      response.policySha256 !== policySha256
      || response.port !== ready.port
      || !sameOwner(response.owner, ready.owner)
      || response.adopted
    ) throw new Error("derivation proxy helper control did not match readiness");
    child.unref();
    return guard;
  } catch (error) {
    const settlesWithin = async (milliseconds: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          child.exited.then(() => true as const, () => true as const),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), milliseconds);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // The helper may already have exited.
    }
    if (!await settlesWithin(2_000)) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // A concurrently exited helper is safe once child.exited settles.
      }
      if (!await settlesWithin(2_000)) {
        child.unref();
        throw new UnsafeDerivationNetworkBoundaryCleanupError(error);
      }
    }
    throw error;
  }
}

/** Bind the helper to durable session metadata before the creating CLI exits. */
export async function adoptDerivationNetworkBoundary(input: {
  readonly derivationId: string;
  readonly guard: DerivationNetworkGuard;
}): Promise<void> {
  derivationGuardControlSocketPath(input.derivationId);
  assertGuardDerivationIdentity(input.guard, input.derivationId);
  if (processOwnerStatus(input.guard.proxy.owner) !== "exact-live-owner") {
    throw new Error("derivation network proxy helper is unavailable before adoption");
  }
  if (processOwnerStatus(input.guard.proxy.parentOwner) !== "exact-live-owner") {
    throw new Error("derivation network proxy parent changed before adoption");
  }
  const response = await proxyControlAtBoundPath({
    derivationId: input.derivationId,
    command: "adopt",
    binding: input.guard.proxy,
  });
  if (
    response.policySha256 !== input.guard.proxy.policySha256
    || response.port !== input.guard.proxy.port
    || !sameOwner(response.owner, input.guard.proxy.owner)
    || !response.adopted
  ) throw new Error("derivation network proxy adoption changed identity");
}

function expectedReady(guard: DerivationNetworkGuard, derivationId: string) {
  return {
    schemaVersion: 1 as const,
    kind: "wrench-derivation-proxy-ready" as const,
    derivationId,
    policySha256: guard.proxy.policySha256,
    port: guard.proxy.port,
    owner: guard.proxy.owner,
  };
}

function assertGuardDerivationIdentity(
  guard: DerivationNetworkGuard,
  derivationId: string,
): void {
  const content = proxyHelperReadyContent(expectedReady(guard, derivationId));
  if (
    Buffer.byteLength(content, "utf8") !== guard.proxy.readyFile.byteLength
    || sha256(content) !== guard.proxy.readyFile.sha256
  ) throw new Error("derivation network guard does not match its derivation ID");
}

export async function verifyDerivationNetworkBoundary(input: {
  readonly derivationId: string;
  readonly directory: string;
  readonly directoryIdentity: GuardDirectoryIdentity;
  readonly socketDirectory: string;
  readonly socketIdentity: GuardDirectoryIdentity;
  readonly browserDomains: readonly string[];
  readonly guard: DerivationNetworkGuard;
  readonly dependencies?: Partial<BoundaryDependencies>;
}): Promise<void> {
  derivationGuardControlSocketPath(input.derivationId);
  const inspectOwner = input.dependencies?.inspectOwner ?? processOwnerStatus;
  assertGuardDerivationIdentity(input.guard, input.derivationId);
  if (input.guard.proxy.policySha256 !== derivationProxyPolicySha256(input.browserDomains)) {
    throw new Error("derivation network proxy policy changed");
  }
  verifyDerivationGuardExtension(input.directory, input.browserDomains, input.guard.extension);
  const config = expectedProxyConfig({
    derivationId: input.derivationId,
    directoryIdentity: input.directoryIdentity,
    socketDirectory: input.socketDirectory,
    socketIdentity: input.socketIdentity,
    browserDomains: input.browserDomains,
    parentOwner: input.guard.proxy.parentOwner,
    controlNonce: input.guard.proxy.controlNonce,
    policySha256: input.guard.proxy.policySha256,
  });
  verifyGuardPrivateFile(
    join(input.directory, DERIVATION_GUARD_PROXY_CONFIG),
    input.guard.proxy.configFile,
    proxyHelperConfigContent(config),
  );
  verifyGuardPrivateFile(
    join(input.directory, DERIVATION_GUARD_PROXY_READY),
    input.guard.proxy.readyFile,
    proxyHelperReadyContent(expectedReady(input.guard, input.derivationId)),
  );
  if (inspectOwner(input.guard.proxy.owner) !== "exact-live-owner") {
    throw new Error("derivation network proxy helper is not the exact live owner");
  }
  const response = await proxyControlAtBoundPath({
    derivationId: input.derivationId,
    command: "status",
    binding: input.guard.proxy,
  });
  if (
    response.policySha256 !== input.guard.proxy.policySha256
    || response.port !== input.guard.proxy.port
    || !sameOwner(response.owner, input.guard.proxy.owner)
    || !response.adopted
  ) throw new Error("derivation network proxy helper changed identity");
}

export async function closeDerivationNetworkBoundary(input: {
  readonly derivationId: string;
  readonly guard: DerivationNetworkGuard;
  readonly dependencies?: Partial<BoundaryDependencies>;
}): Promise<void> {
  const controlPath = derivationGuardControlSocketPath(input.derivationId);
  const inspectOwner = input.dependencies?.inspectOwner ?? processOwnerStatus;
  assertGuardDerivationIdentity(input.guard, input.derivationId);
  const initial = inspectOwner(input.guard.proxy.owner);
  if (initial === "different-or-dead") {
    if (!privateControlSocketIsAbsent(controlPath)) {
      throw new Error("derivation proxy control endpoint remains after its owner changed");
    }
    return;
  }
  if (initial !== "exact-live-owner") {
    throw new Error("derivation network proxy owner cannot be verified for cleanup");
  }
  let response: ProxyControlResponse;
  try {
    response = await proxyControlAtBoundPath({
      derivationId: input.derivationId,
      command: "close",
      binding: input.guard.proxy,
    });
  } catch (error) {
    if (!(error instanceof DerivationProxyControlMissingError)) throw error;
    // Legacy schema-v1 sessions may retain an exact-live owner after their old
    // agent-browser-owned control socket vanished. Never launch or speak the
    // new protocol on that old path; terminate only the revalidated owner.
    await signalBoundOwnerAtAbsentControl({
      derivationId: input.derivationId,
      owner: input.guard.proxy.owner,
      dependencies: { inspectOwner },
    });
    return;
  }
  if (
    response.policySha256 !== input.guard.proxy.policySha256
    || response.port !== input.guard.proxy.port
    || !sameOwner(response.owner, input.guard.proxy.owner)
  ) throw new Error("derivation network proxy close acknowledgement changed identity");
  await waitForProxyOwnerQuiescence(input.guard.proxy.owner, inspectOwner);
  if (!privateControlSocketIsAbsent(controlPath)) {
    throw new Error("derivation proxy control endpoint remains after authenticated cleanup");
  }
}
