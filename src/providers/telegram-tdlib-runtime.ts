import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  type BigIntStats,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";

import { BoundedByteBuffer } from "@hraness/kb/clip/bounded-byte-buffer";

import type { WrenchAuth } from "../auth";
import { canonicalJson } from "../canonical-json";
import type { OperationInput, WebSessionRecipe } from "../model";
import type {
  ProviderPluginLinkedDeviceAttemptBoundaryV1,
  ProviderPluginLinkedDeviceRuntimeStatusV1,
} from "../provider-plugin";
import { wrenchStateHome } from "../storage";
import type {
  WebSessionExecution,
  WebSessionOperationDeadline,
} from "../web-session-execution";
import { projectContactDirectionStats } from "./contact-projection";
import {
  TELEGRAM_TDLIB_MAX_PROJECTION_BYTES,
  TELEGRAM_TDLIB_OPERATIONS,
  TELEGRAM_TDLIB_PIN,
  pageTelegramContacts,
  parseTelegramContactsListInput,
  parseTelegramTdlibCaptureEnvelope,
  parseTelegramTdlibHelperIdentity,
  parseTelegramTdlibProjection,
  telegramSubject,
  telegramTdlibRequest,
  type TelegramTdlibCaptureOperation,
  type TelegramTdlibProjection,
} from "./telegram-tdlib";

const TELEGRAM_ORIGIN = "https://telegram.org";
const INSTALL_MANIFEST_MAX_BYTES = 8 * 1024;
const HELPER_MAX_BYTES = 256 * 1024 * 1024;
const HELPER_MAX_STDERR_BYTES = 16 * 1024;
const HELPER_IDENTITY_MAX_STDOUT_BYTES = 2 * 1024;
const HELPER_FORCE_KILL_DELAY_MS = 7_000;
const PROJECTION_FILENAME = "contacts.v1.json";
const CLIENT_CONFIG_FILENAME = "client.conf";
const OPERATION_LABEL = "Telegram TDLib linked-device operation";

type TelegramAuth = Extract<
  WrenchAuth,
  { readonly kind: "linked-device-store" }
>;

type FileIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  uid: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}>;

type StoreBinding = Readonly<{
  path: string;
  identity: FileIdentity;
  configIdentity?: FileIdentity;
  tdlibDirectoryIdentity?: FileIdentity;
  tdlibFilesDirectoryIdentity?: FileIdentity;
}>;

type RuntimeManifest = Readonly<{
  schemaVersion: 1;
  implementation: typeof TELEGRAM_TDLIB_PIN.helperImplementation;
  tdlibVersion: typeof TELEGRAM_TDLIB_PIN.version;
  sourceCommit: typeof TELEGRAM_TDLIB_PIN.sourceCommit;
  protocolVersion: typeof TELEGRAM_TDLIB_PIN.helperProtocolVersion;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  binaryFile: "wrench-telegram-tdlib";
  binarySha256: string;
}>;

type RuntimeBinding = Readonly<{
  directory: string;
  binary: string;
  manifestPath: string;
  manifest: RuntimeManifest;
  directoryIdentity: FileIdentity;
  binaryIdentity: FileIdentity;
  manifestIdentity: FileIdentity;
}>;

export type TelegramTdlibInvocation = Readonly<{
  binary: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}>;

export type TelegramTdlibInvocationResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type TelegramTdlibRuntimeDependencies = Readonly<{
  /** Test-only process seam. Production always executes the verified helper. */
  run?: (
    invocation: TelegramTdlibInvocation,
  ) => Promise<TelegramTdlibInvocationResult>;
}>;

export class TelegramTdlibCleanupUnverifiedError extends Error {
  constructor() {
    super("Telegram TDLib helper cleanup could not be proven; retry is unsafe");
    this.name = "TelegramTdlibCleanupUnverifiedError";
  }
}

function currentUid(): bigint | null {
  return typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
}

function assertSupportedPlatform(): void {
  if (
    (process.platform !== "darwin" && process.platform !== "linux")
    || (process.arch !== "arm64" && process.arch !== "x64")
    || currentUid() === null
  ) throw new Error("Telegram TDLib runtime is unsupported on this platform");
}

function exactMode(stats: BigIntStats, expected: bigint): boolean {
  return (stats.mode & 0o7777n) === expected;
}

function identityOf(stats: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    uid: stats.uid,
    mode: stats.mode & 0o7777n,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs;
}

function sameRenamedFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.mode === right.mode
    && left.size === right.size
    && left.birthtimeNs === right.birthtimeNs;
}

function sameDirectoryIdentity(left: FileIdentity, right: FileIdentity): boolean {
  // APFS changes directory size and link count when TDLib creates children.
  // The directory object itself remains bound by device/inode/owner/mode.
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.birthtimeNs === right.birthtimeNs;
}

function assertDirectoryStats(
  stats: BigIntStats,
  label: string,
): FileIdentity {
  const uid = currentUid();
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || (uid !== null && stats.uid !== uid)
    || !exactMode(stats, 0o700n)
  ) throw new Error(`${label} must be one owned mode-0700 directory`);
  return identityOf(stats);
}

function assertFileStats(
  stats: BigIntStats,
  options: Readonly<{
    label: string;
    mode: bigint;
    minimum: bigint;
    maximum: bigint;
  }>,
): FileIdentity {
  const uid = currentUid();
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1n
    || (uid !== null && stats.uid !== uid)
    || !exactMode(stats, options.mode)
    || stats.size < options.minimum
    || stats.size > options.maximum
  ) {
    throw new Error(
      `${options.label} must be one owned regular mode-${options.mode.toString(8)} file with one link and bounded size`,
    );
  }
  return identityOf(stats);
}

async function canonicalDirectory(
  pathValue: string,
  label: string,
): Promise<Readonly<{ path: string; identity: FileIdentity }>> {
  const lexical = resolve(pathValue);
  if (!isAbsolute(pathValue) || lexical !== pathValue) {
    throw new Error(`${label} path must be absolute and lexical-canonical`);
  }
  const stats = await lstat(lexical, { bigint: true });
  const identity = assertDirectoryStats(stats, label);
  if (await realpath(lexical) !== lexical) {
    throw new Error(`${label} path must resolve to itself`);
  }
  return Object.freeze({ path: lexical, identity });
}

async function openBoundFile(
  pathValue: string,
  options: Readonly<{
    label: string;
    mode: bigint;
    minimum: bigint;
    maximum: bigint;
  }>,
): Promise<Readonly<{
  handle: Awaited<ReturnType<typeof open>>;
  identity: FileIdentity;
}>> {
  const lexicalStats = await lstat(pathValue, { bigint: true });
  const lexicalIdentity = assertFileStats(lexicalStats, options);
  if (await realpath(pathValue) !== pathValue) {
    throw new Error(`${options.label} path must resolve to itself`);
  }
  const handle = await open(
    pathValue,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedStats = await handle.stat({ bigint: true });
    const openedIdentity = assertFileStats(openedStats, options);
    if (!sameIdentity(lexicalIdentity, openedIdentity)) {
      throw new Error(`${options.label} identity changed while opening`);
    }
    return Object.freeze({ handle, identity: openedIdentity });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readOpenedFile(
  handle: Awaited<ReturnType<typeof open>>,
  maximum: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let position = 0;
  for (;;) {
    const chunk = new Uint8Array(Math.min(64 * 1024, maximum + 1 - total));
    const result = await handle.read(chunk, 0, chunk.length, position);
    if (result.bytesRead === 0) break;
    const value = chunk.subarray(0, result.bytesRead);
    chunks.push(value);
    total += result.bytesRead;
    position += result.bytesRead;
    if (total > maximum) throw new Error("bounded private file exceeded its byte limit");
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readBoundTextFile(
  pathValue: string,
  options: Readonly<{
    label: string;
    mode: bigint;
    maximum: number;
  }>,
): Promise<Readonly<{ text: string; identity: FileIdentity }>> {
  const opened = await openBoundFile(pathValue, {
    label: options.label,
    mode: options.mode,
    minimum: 1n,
    maximum: BigInt(options.maximum),
  });
  try {
    const bytes = await readOpenedFile(opened.handle, options.maximum);
    const finalStats = await opened.handle.stat({ bigint: true });
    const finalIdentity = assertFileStats(finalStats, {
      label: options.label,
      mode: options.mode,
      minimum: 1n,
      maximum: BigInt(options.maximum),
    });
    if (!sameIdentity(opened.identity, finalIdentity)) {
      throw new Error(`${options.label} identity changed while reading`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${options.label} must contain valid UTF-8`);
    }
    return Object.freeze({ text, identity: opened.identity });
  } finally {
    await opened.handle.close();
  }
}

async function sha256BoundFile(
  pathValue: string,
  expectedIdentity: FileIdentity,
  options: Readonly<{
    label: string;
    mode: bigint;
    maximum: number;
  }>,
): Promise<string> {
  const opened = await openBoundFile(pathValue, {
    label: options.label,
    mode: options.mode,
    minimum: 1n,
    maximum: BigInt(options.maximum),
  });
  try {
    if (!sameIdentity(opened.identity, expectedIdentity)) {
      throw new Error(`${options.label} identity changed before hashing`);
    }
    const hash = createHash("sha256");
    let position = 0;
    for (;;) {
      const chunk = new Uint8Array(64 * 1024);
      const result = await opened.handle.read(chunk, 0, chunk.length, position);
      if (result.bytesRead === 0) break;
      hash.update(chunk.subarray(0, result.bytesRead));
      position += result.bytesRead;
      if (position > options.maximum) {
        throw new Error(`${options.label} exceeded its byte limit while hashing`);
      }
    }
    const finalIdentity = identityOf(await opened.handle.stat({ bigint: true }));
    if (!sameIdentity(opened.identity, finalIdentity)) {
      throw new Error(`${options.label} identity changed while hashing`);
    }
    return hash.digest("hex");
  } finally {
    await opened.handle.close();
  }
}

function plainRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    return typeof key !== "string"
      || descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable;
  })) throw new Error(`${label} must contain only enumerable data fields`);
  return value as Readonly<Record<string, unknown>>;
}

function parseRuntimeManifest(value: unknown): RuntimeManifest {
  const source = plainRecord(value, "Telegram TDLib install manifest");
  if (Object.keys(source).sort().join(",") !== [
    "arch",
    "binaryFile",
    "binarySha256",
    "implementation",
    "platform",
    "protocolVersion",
    "schemaVersion",
    "sourceCommit",
    "tdlibVersion",
  ].join(",")) throw new Error("Telegram TDLib install manifest fields are unsupported");
  if (
    source.schemaVersion !== 1
    || source.implementation !== TELEGRAM_TDLIB_PIN.helperImplementation
    || source.tdlibVersion !== TELEGRAM_TDLIB_PIN.version
    || source.sourceCommit !== TELEGRAM_TDLIB_PIN.sourceCommit
    || source.protocolVersion !== TELEGRAM_TDLIB_PIN.helperProtocolVersion
    || source.binaryFile !== "wrench-telegram-tdlib"
    || (source.platform !== "darwin" && source.platform !== "linux")
    || (source.arch !== "arm64" && source.arch !== "x64")
    || typeof source.binarySha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(source.binarySha256)
  ) throw new Error("Telegram TDLib install manifest does not match the reviewed runtime");
  if (source.platform !== process.platform || source.arch !== process.arch) {
    throw new Error("Telegram TDLib install manifest is for another runtime platform");
  }
  return Object.freeze({
    schemaVersion: 1,
    implementation: TELEGRAM_TDLIB_PIN.helperImplementation,
    tdlibVersion: TELEGRAM_TDLIB_PIN.version,
    sourceCommit: TELEGRAM_TDLIB_PIN.sourceCommit,
    protocolVersion: TELEGRAM_TDLIB_PIN.helperProtocolVersion,
    platform: source.platform,
    arch: source.arch,
    binaryFile: "wrench-telegram-tdlib",
    binarySha256: source.binarySha256,
  });
}

function runtimeDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(
    wrenchStateHome(environment),
    "tools",
    "telegram-tdlib",
    TELEGRAM_TDLIB_PIN.version,
    TELEGRAM_TDLIB_PIN.sourceCommit,
    `${process.platform}-${process.arch}`,
  );
}

async function resolveRuntimeBinding(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<RuntimeBinding> {
  assertSupportedPlatform();
  const directory = await canonicalDirectory(
    runtimeDirectory(environment),
    "Telegram TDLib installation directory",
  );
  const manifestPath = join(directory.path, "install-manifest.json");
  const manifestFile = await readBoundTextFile(manifestPath, {
    label: "Telegram TDLib install manifest",
    mode: 0o400n,
    maximum: INSTALL_MANIFEST_MAX_BYTES,
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestFile.text) as unknown;
  } catch {
    throw new Error("Telegram TDLib install manifest is malformed JSON");
  }
  const manifest = parseRuntimeManifest(decoded);
  if (manifestFile.text !== `${canonicalJson(manifest)}\n`) {
    throw new Error("Telegram TDLib install manifest is not canonical JSON");
  }
  const binary = join(directory.path, manifest.binaryFile);
  const binaryStats = await lstat(binary, { bigint: true });
  const binaryIdentity = assertFileStats(binaryStats, {
    label: "Telegram TDLib helper",
    mode: 0o500n,
    minimum: 1n,
    maximum: BigInt(HELPER_MAX_BYTES),
  });
  if (await realpath(binary) !== binary) {
    throw new Error("Telegram TDLib helper path must resolve to itself");
  }
  const digest = await sha256BoundFile(binary, binaryIdentity, {
    label: "Telegram TDLib helper",
    mode: 0o500n,
    maximum: HELPER_MAX_BYTES,
  });
  if (digest !== manifest.binarySha256) {
    throw new Error("Telegram TDLib helper SHA-256 did not match its install manifest");
  }
  return Object.freeze({
    directory: directory.path,
    binary,
    manifestPath,
    manifest,
    directoryIdentity: directory.identity,
    binaryIdentity,
    manifestIdentity: manifestFile.identity,
  });
}

async function revalidateRuntimeBinding(binding: RuntimeBinding): Promise<void> {
  const directory = await canonicalDirectory(
    binding.directory,
    "Telegram TDLib installation directory",
  );
  if (!sameDirectoryIdentity(directory.identity, binding.directoryIdentity)) {
    throw new Error("Telegram TDLib installation directory identity changed");
  }
  const manifest = await readBoundTextFile(binding.manifestPath, {
    label: "Telegram TDLib install manifest",
    mode: 0o400n,
    maximum: INSTALL_MANIFEST_MAX_BYTES,
  });
  if (!sameIdentity(manifest.identity, binding.manifestIdentity)) {
    throw new Error("Telegram TDLib install manifest identity changed");
  }
  const binaryStats = await lstat(binding.binary, { bigint: true });
  const binaryIdentity = assertFileStats(binaryStats, {
    label: "Telegram TDLib helper",
    mode: 0o500n,
    minimum: 1n,
    maximum: BigInt(HELPER_MAX_BYTES),
  });
  if (!sameIdentity(binaryIdentity, binding.binaryIdentity)) {
    throw new Error("Telegram TDLib helper identity changed");
  }
  const digest = await sha256BoundFile(binding.binary, binding.binaryIdentity, {
    label: "Telegram TDLib helper",
    mode: 0o500n,
    maximum: HELPER_MAX_BYTES,
  });
  if (digest !== binding.manifest.binarySha256) {
    throw new Error("Telegram TDLib helper contents changed");
  }
}

function requireTelegramAuth(auth: WrenchAuth): TelegramAuth {
  assertSupportedPlatform();
  if (
    auth.kind !== "linked-device-store"
    || (auth.provider as string) !== "telegram"
  ) throw new Error("Telegram operations require a Telegram linked-device-store auth realm");
  if (!isAbsolute(auth.path) || resolve(auth.path) !== auth.path) {
    throw new Error("Telegram linked-device store path must be absolute and lexical-canonical");
  }
  return auth;
}

async function ensurePrivateDirectory(pathValue: string, label: string): Promise<void> {
  try {
    await mkdir(pathValue, { mode: 0o700 });
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "EEXIST"
    ) throw error;
  }
  // Never repair an existing lexical entry. chmod follows symbolic links and
  // would also turn permission drift into silent acceptance. A newly created
  // directory already received its exact mode from mkdir under this process.
  await canonicalDirectory(pathValue, label);
}

function parseClientConfig(text: string): void {
  if (!/^api_id=[1-9][0-9]{0,9}\napi_hash=[a-f0-9]{32}\n$/u.test(text)) {
    throw new Error(
      "Telegram client.conf must contain exactly api_id=<positive int32> and api_hash=<32 lowercase hex>",
    );
  }
  const newline = text.indexOf("\n");
  const apiId = Number(text.slice("api_id=".length, newline));
  if (!Number.isInteger(apiId) || apiId < 1 || apiId > 2_147_483_647) {
    throw new Error("Telegram client.conf api_id must be a positive int32");
  }
}

async function validateStore(
  auth: TelegramAuth,
  purpose: "pair" | "sync" | "projection",
): Promise<StoreBinding> {
  if (purpose === "pair") {
    try {
      await ensurePrivateDirectory(auth.path, "Telegram linked-device store");
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT"
      ) {
        throw new Error("Telegram linked-device store parent does not exist");
      }
      throw error;
    }
  }
  const store = await canonicalDirectory(auth.path, "Telegram linked-device store");
  if (purpose === "projection") {
    return Object.freeze({ path: store.path, identity: store.identity });
  }
  const configPath = join(store.path, CLIENT_CONFIG_FILENAME);
  const config = await readBoundTextFile(configPath, {
    label: "Telegram client configuration",
    mode: 0o600n,
    maximum: 256,
  });
  parseClientConfig(config.text);
  const privateDirectories: FileIdentity[] = [];
  for (const directoryName of ["tdlib", "tdlib-files"] as const) {
    const pathValue = join(store.path, directoryName);
    if (purpose === "pair") {
      await ensurePrivateDirectory(pathValue, `Telegram ${directoryName} directory`);
    }
    const directory = await canonicalDirectory(
      pathValue,
      `Telegram ${directoryName} directory`,
    );
    privateDirectories.push(directory.identity);
  }
  const tdlibDirectoryIdentity = privateDirectories[0];
  const tdlibFilesDirectoryIdentity = privateDirectories[1];
  if (
    tdlibDirectoryIdentity === undefined
    || tdlibFilesDirectoryIdentity === undefined
  ) throw new Error("Telegram TDLib private-directory binding is unavailable");
  return Object.freeze({
    path: store.path,
    identity: store.identity,
    configIdentity: config.identity,
    tdlibDirectoryIdentity,
    tdlibFilesDirectoryIdentity,
  });
}

async function revalidateStore(
  binding: StoreBinding,
  requireConfig: boolean,
): Promise<void> {
  const store = await canonicalDirectory(binding.path, "Telegram linked-device store");
  if (!sameDirectoryIdentity(store.identity, binding.identity)) {
    throw new Error("Telegram linked-device store identity changed");
  }
  if (requireConfig) {
    if (binding.configIdentity === undefined) {
      throw new Error("Telegram client configuration binding is unavailable");
    }
    const config = await readBoundTextFile(join(binding.path, CLIENT_CONFIG_FILENAME), {
      label: "Telegram client configuration",
      mode: 0o600n,
      maximum: 256,
    });
    parseClientConfig(config.text);
    if (!sameIdentity(config.identity, binding.configIdentity)) {
      throw new Error("Telegram client configuration identity changed");
    }
    const privateDirectories = [
      ["tdlib", binding.tdlibDirectoryIdentity],
      ["tdlib-files", binding.tdlibFilesDirectoryIdentity],
    ] as const;
    for (const [directoryName, expectedIdentity] of privateDirectories) {
      if (expectedIdentity === undefined) {
        throw new Error("Telegram TDLib private-directory binding is unavailable");
      }
      const directory = await canonicalDirectory(
        join(binding.path, directoryName),
        `Telegram ${directoryName} directory`,
      );
      if (!sameDirectoryIdentity(directory.identity, expectedIdentity)) {
        throw new Error(`Telegram ${directoryName} directory identity changed`);
      }
    }
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<string> {
  const reader = stream.getReader();
  const output = new BoundedByteBuffer(maximum);
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      if (!output.append(item.value)) {
        throw new Error("Telegram TDLib helper output exceeded its bound");
      }
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(output.toUint8Array());
  } catch {
    throw new Error("Telegram TDLib helper output was not valid UTF-8");
  }
}

export async function runTelegramTdlibHelperChild(
  invocation: TelegramTdlibInvocation,
): Promise<TelegramTdlibInvocationResult> {
  const isAborted = (): boolean => invocation.signal?.aborted === true;
  if (isAborted()) {
    throw new Error("Telegram TDLib helper was cancelled");
  }
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([invocation.binary], {
      cwd: invocation.cwd,
      env: { ...invocation.environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: false,
    });
  } catch {
    throw new Error("Telegram TDLib helper could not start");
  }
  let timedOut = false;
  let cancelled = false;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  let terminationStarted = false;
  const signalChild = (signal: "SIGTERM" | "SIGKILL"): void => {
    try {
      child.kill(signal);
    } catch {
      // child.exited is the cleanup proof.
    }
  };
  const terminate = (): void => {
    if (!terminationStarted) {
      terminationStarted = true;
      signalChild("SIGTERM");
    }
    forceKill ??= setTimeout(
      () => signalChild("SIGKILL"),
      HELPER_FORCE_KILL_DELAY_MS,
    );
  };
  const onAbort = (): void => {
    cancelled = true;
    terminate();
  };
  invocation.signal?.addEventListener("abort", onAbort, { once: true });
  if (isAborted()) onAbort();
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, invocation.timeoutMs);
  const guarded = <T>(promise: Promise<T>): Promise<T> => promise.catch((error: unknown) => {
    terminate();
    throw error;
  });
  const writeInput = guarded((async () => {
    await child.stdin.write(invocation.stdin);
    await child.stdin.end();
  })());
  const stdout = guarded(readBoundedStream(child.stdout, invocation.maxOutputBytes));
  const stderr = guarded(readBoundedStream(child.stderr, invocation.maxStderrBytes));
  try {
    const settled = await Promise.allSettled([
      writeInput,
      stdout,
      stderr,
      child.exited,
    ] as const);
    const exit = settled[3];
    if (exit?.status !== "fulfilled") {
      throw new TelegramTdlibCleanupUnverifiedError();
    }
    if (
      settled[0]?.status !== "fulfilled"
      || settled[1]?.status !== "fulfilled"
      || settled[2]?.status !== "fulfilled"
    ) throw new Error("Telegram TDLib helper streams failed within their bounds");
    if (cancelled) throw new Error("Telegram TDLib helper was cancelled");
    if (timedOut) throw new Error("Telegram TDLib helper timed out");
    return Object.freeze({
      exitCode: exit.value,
      stdout: settled[1].value,
      stderr: settled[2].value,
    });
  } finally {
    clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
    invocation.signal?.removeEventListener("abort", onAbort);
  }
}

function helperEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze({
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
  });
}

async function invokeHelper(
  binding: RuntimeBinding,
  operation: "identity" | TelegramTdlibCaptureOperation,
  cwd: string,
  options: Readonly<{
    phone?: string;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    dependencies?: TelegramTdlibRuntimeDependencies;
  }>,
): Promise<unknown> {
  const run = options.dependencies?.run ?? runTelegramTdlibHelperChild;
  const result = await run(Object.freeze({
    binary: binding.binary,
    cwd,
    environment: helperEnvironment(),
    stdin: telegramTdlibRequest(
      operation,
      options.phone === undefined ? {} : { phone: options.phone },
    ),
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    maxStderrBytes: HELPER_MAX_STDERR_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }));
  if (result.exitCode !== 0 || result.stderr.length !== 0) {
    throw new Error("Telegram TDLib helper failed before producing reviewed output");
  }
  const output = result.stdout.trim();
  if (output.length === 0) throw new Error("Telegram TDLib helper omitted JSON output");
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error("Telegram TDLib helper returned malformed JSON");
  }
}

async function verifyEmbeddedIdentity(
  binding: RuntimeBinding,
  dependencies?: TelegramTdlibRuntimeDependencies,
): Promise<void> {
  const value = await invokeHelper(binding, "identity", binding.directory, {
    timeoutMs: 5_000,
    maxOutputBytes: HELPER_IDENTITY_MAX_STDOUT_BYTES,
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  parseTelegramTdlibHelperIdentity(value);
  await revalidateRuntimeBinding(binding);
}

function setupCommand(): string {
  const installer = fileURLToPath(
    new URL("../scripts/install-telegram-tdlib.sh", import.meta.url),
  );
  return `/bin/sh '${installer.replaceAll("'", "'\\''")}'`;
}

export async function inspectTelegramTdlibRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies?: TelegramTdlibRuntimeDependencies,
): Promise<ProviderPluginLinkedDeviceRuntimeStatusV1> {
  let ready = false;
  try {
    const binding = await resolveRuntimeBinding(environment);
    await verifyEmbeddedIdentity(binding, dependencies);
    ready = true;
  } catch {
    // Doctor returns categorical readiness and never local paths or digests.
  }
  return Object.freeze({
    ready,
    implementation: TELEGRAM_TDLIB_PIN.implementation,
    version: TELEGRAM_TDLIB_PIN.version,
    integrity: "source-commit+manifest-sha256+embedded-identity",
    setupCommand: setupCommand(),
  });
}

async function readProjection(
  auth: TelegramAuth,
): Promise<TelegramTdlibProjection> {
  const store = await validateStore(auth, "projection");
  const projectionFile = await readBoundTextFile(join(store.path, PROJECTION_FILENAME), {
    label: "Telegram contact projection",
    mode: 0o600n,
    maximum: TELEGRAM_TDLIB_MAX_PROJECTION_BYTES,
  });
  await revalidateStore(store, false);
  let value: unknown;
  try {
    value = JSON.parse(projectionFile.text) as unknown;
  } catch {
    throw new Error("Telegram contact projection is malformed JSON");
  }
  const projection = parseTelegramTdlibProjection(value);
  await revalidateStore(store, false);
  const finalFile = await lstat(join(store.path, PROJECTION_FILENAME), { bigint: true });
  const finalIdentity = assertFileStats(finalFile, {
    label: "Telegram contact projection",
    mode: 0o600n,
    minimum: 1n,
    maximum: BigInt(TELEGRAM_TDLIB_MAX_PROJECTION_BYTES),
  });
  if (!sameIdentity(finalIdentity, projectionFile.identity)) {
    throw new Error("Telegram contact projection identity changed while reading");
  }
  return projection;
}

async function fsyncDirectory(pathValue: string): Promise<void> {
  const handle = await open(pathValue, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function destinationAbsentOrSafe(pathValue: string): Promise<void> {
  try {
    const stats = await lstat(pathValue, { bigint: true });
    assertFileStats(stats, {
      label: "existing Telegram contact projection",
      mode: 0o600n,
      minimum: 1n,
      maximum: BigInt(TELEGRAM_TDLIB_MAX_PROJECTION_BYTES),
    });
    if (await realpath(pathValue) !== pathValue) {
      throw new Error("existing Telegram contact projection path is not canonical");
    }
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return;
    throw error;
  }
}

async function removeStagingIfStillOwned(
  pathValue: string,
  identity: FileIdentity,
): Promise<void> {
  try {
    const current = identityOf(await lstat(pathValue, { bigint: true }));
    if (!sameIdentity(current, identity)) {
      throw new Error("Telegram projection staging identity changed before cleanup");
    }
    await unlink(pathValue);
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return;
    throw error;
  }
}

async function persistProjection(
  store: StoreBinding,
  projection: TelegramTdlibProjection,
): Promise<void> {
  const bytes = new TextEncoder().encode(`${canonicalJson(projection)}\n`);
  if (bytes.byteLength > TELEGRAM_TDLIB_MAX_PROJECTION_BYTES) {
    throw new Error("Telegram contact projection exceeded its storage bound");
  }
  const stage = join(
    store.path,
    `.contacts.v1.${randomBytes(16).toString("hex")}.stage`,
  );
  const destination = join(store.path, PROJECTION_FILENAME);
  const handle = await open(
    stage,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | constants.O_NOFOLLOW,
    0o600,
  );
  let stageIdentity: FileIdentity | undefined;
  let installed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    stageIdentity = assertFileStats(stats, {
      label: "Telegram contact projection staging file",
      mode: 0o600n,
      minimum: 1n,
      maximum: BigInt(TELEGRAM_TDLIB_MAX_PROJECTION_BYTES),
    });
    await handle.close();
    await revalidateStore(store, true);
    await destinationAbsentOrSafe(destination);
    await fsyncDirectory(store.path);
    await revalidateStore(store, true);
    await rename(stage, destination);
    installed = true;
    const installedStats = await lstat(destination, { bigint: true });
    const installedIdentity = assertFileStats(installedStats, {
      label: "Telegram contact projection",
      mode: 0o600n,
      minimum: 1n,
      maximum: BigInt(TELEGRAM_TDLIB_MAX_PROJECTION_BYTES),
    });
    if (!sameRenamedFileIdentity(installedIdentity, stageIdentity)) {
      throw new Error("Telegram contact projection identity changed during publication");
    }
    await fsyncDirectory(store.path);
    await revalidateStore(store, true);
    const durableIdentity = assertFileStats(
      await lstat(destination, { bigint: true }),
      {
        label: "Telegram contact projection",
        mode: 0o600n,
        minimum: 1n,
        maximum: BigInt(TELEGRAM_TDLIB_MAX_PROJECTION_BYTES),
      },
    );
    if (!sameIdentity(durableIdentity, installedIdentity)) {
      throw new Error("Telegram contact projection identity changed after publication");
    }
  } finally {
    try {
      await handle.close();
    } catch {
      // The handle may already have closed after its durable fsync.
    }
    if (!installed && stageIdentity !== undefined) {
      await removeStagingIfStillOwned(stage, stageIdentity);
    }
  }
}

export async function probeTelegramSubject(
  auth: WrenchAuth,
): Promise<string> {
  const linked = requireTelegramAuth(auth);
  if (linked.subject === undefined) {
    throw new Error("Telegram linked-device auth must be account-bound before probing");
  }
  const expected = telegramSubject(linked.subject);
  const projection = await readProjection(linked);
  if (projection.accountSubject !== expected) {
    throw new Error("Telegram contact projection account did not match the bound auth realm");
  }
  return expected;
}

function unavailableDirectionStats() {
  return Object.freeze({
    count: null,
    complete: false,
    lowerBound: false,
    truncated: false,
    lastAt: null,
    lastAtComplete: false,
    lastAtBasis: "unavailable" as const,
    incompleteReasons: Object.freeze([
      "tdlib-contacts-do-not-include-message-history",
    ]),
  });
}

function boundedOutput(value: unknown, maximum: number): unknown {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    throw new Error("Telegram contact output exceeded its reviewed byte limit");
  }
  return value;
}

export async function executeTelegramTdlibOperation(
  recipe: WebSessionRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: Readonly<{
    operationDeadline?: WebSessionOperationDeadline;
  }> = {},
): Promise<WebSessionExecution> {
  if (
    (recipe.site as string) !== "telegram"
    || recipe.action !== "contacts.list"
    || recipe.contractVersion !== 1
    || TELEGRAM_TDLIB_OPERATIONS["contacts.list"].state !== "observed"
  ) throw new Error("Telegram TDLib recipe is not installed");
  options.operationDeadline?.throwIfUnavailable(OPERATION_LABEL);
  const linked = requireTelegramAuth(auth);
  if (linked.subject === undefined) {
    throw new Error("Telegram linked-device auth must be account-bound before contacts.list");
  }
  const expected = telegramSubject(linked.subject);
  const projection = await readProjection(linked);
  if (projection.accountSubject !== expected) {
    throw new Error("Telegram contact projection account did not match the bound auth realm");
  }
  const parsedInput = parseTelegramContactsListInput(input);
  const page = pageTelegramContacts(projection, parsedInput);
  const stats = projectContactDirectionStats(
    unavailableDirectionStats(),
    unavailableDirectionStats(),
  );
  const output = Object.freeze({
    provider: "telegram",
    operation: "contacts.list",
    accountSubject: expected,
    projection: "tdlib-get-contacts-snapshot",
    contacts: Object.freeze(page.contacts.map((contact) => Object.freeze({
      ...contact,
      alias: null,
      tags: Object.freeze([]),
      updatedAt: null,
      ...stats,
    }))),
    nextCursor: page.nextCursor,
    pageComplete: page.pageComplete,
    contactSetComplete: true,
    contactSetIncompleteReasons: Object.freeze([]),
    statsScope: "unavailable",
    statsCompleteness: "unavailable",
  });
  options.operationDeadline?.throwIfUnavailable(OPERATION_LABEL);
  return Object.freeze({
    status: "succeeded",
    output: boundedOutput(output, recipe.maxOutputBytes),
    finalUrl: TELEGRAM_ORIGIN,
    dispatchStarted: false,
    dispatch: Object.freeze({ planned: 0, started: 0, verified: 0 }),
  });
}

async function captureProjection(
  operation: TelegramTdlibCaptureOperation,
  auth: TelegramAuth,
  options: Readonly<{
    phone?: string;
    environment: Readonly<Record<string, string | undefined>>;
    attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    dependencies?: TelegramTdlibRuntimeDependencies;
  }>,
): Promise<TelegramTdlibProjection> {
  const store = await validateStore(auth, operation === "pair" ? "pair" : "sync");
  const runtime = await resolveRuntimeBinding(options.environment);
  await verifyEmbeddedIdentity(runtime, options.dependencies);
  await revalidateStore(store, true);
  await revalidateRuntimeBinding(runtime);
  await options.attempt.beforeExternalBegin();
  const response = await invokeHelper(runtime, operation, store.path, {
    ...(options.phone === undefined ? {} : { phone: options.phone }),
    timeoutMs: operation === "pair" ? 10 * 60_000 : 2 * 60_000,
    maxOutputBytes: TELEGRAM_TDLIB_MAX_PROJECTION_BYTES + 64 * 1024,
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
  });
  await revalidateRuntimeBinding(runtime);
  await revalidateStore(store, true);
  const projection = parseTelegramTdlibCaptureEnvelope(response, operation);
  if (
    auth.subject !== undefined
    && projection.accountSubject !== telegramSubject(auth.subject)
  ) throw new Error("Telegram captured account did not match the bound auth realm");
  await persistProjection(store, projection);
  return projection;
}

export async function pairTelegramAuth(
  auth: WrenchAuth,
  options: Readonly<{
    phone?: string;
    environment: Readonly<Record<string, string | undefined>>;
    attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    dependencies?: TelegramTdlibRuntimeDependencies;
  }>,
): Promise<string> {
  const linked = requireTelegramAuth(auth);
  const projection = await captureProjection("pair", linked, options);
  return projection.accountSubject;
}

export async function syncTelegramAuthOnce(
  auth: WrenchAuth,
  options: Readonly<{
    environment: Readonly<Record<string, string | undefined>>;
    attempt: ProviderPluginLinkedDeviceAttemptBoundaryV1;
    dependencies?: TelegramTdlibRuntimeDependencies;
  }>,
): Promise<Readonly<{ contactsStored: number }>> {
  const linked = requireTelegramAuth(auth);
  if (linked.subject === undefined) {
    throw new Error("Telegram linked-device auth must be account-bound before synchronization");
  }
  const projection = await captureProjection("sync", linked, options);
  return Object.freeze({ contactsStored: projection.contacts.length });
}
