import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  findExecutable,
  runProcess,
  type CommandArgv,
  type ExecutableDiscoveryOptions,
  type ProcessResult,
  type RunProcessOptions,
} from "./process";
import {
  attestRuntimeClosure,
  buildWhisperRuntimeEnvironment,
  parseRuntimeClosureRecord,
  sameRuntimeClosure,
  stripRuntimeClosureRecord,
  type RUNTIME_CLOSURE_PROFILE,
  type AttestRuntimeClosureOptions,
  type RuntimeClosureAttestation,
  type RuntimeClosureRecord,
} from "./runtime-closure";

export const WHISPER_CPP_PROFILE = "wrench-media-whisper-cpp-v1" as const;

const CONFIG_SCHEMA_VERSION = 1 as const;
const CONFIG_DIRECTORY_MODE = 0o700;
const CONFIG_FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_MODEL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PATH_CODE_UNITS = 4_096;
const FILE_READ_CHUNK_BYTES = 1024 * 1024;
const HELP_TIMEOUT_MS = 5_000;
const HELP_OUTPUT_LIMIT_BYTES = 256 * 1024;
const MAX_PUBLISH_ATTEMPTS = 8;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_HELP_FLAGS = [
  "--model",
  "--file",
  "--language",
  "--threads",
  "--processors",
  "--no-gpu",
  "--output-vtt",
  "--output-json-full",
  "--output-file",
  "--no-prints",
] as const;

export type WhisperCppTranscriberDescriptor = Readonly<{
  adapter: "whisper-cpp";
  profile: typeof WHISPER_CPP_PROFILE;
  executableSha256: string;
  modelSha256: string;
  modelBytes: number;
  runtimeProfile: typeof RUNTIME_CLOSURE_PROFILE;
  runtimeSha256: string;
  runtimeDependencyCount: number;
}>;

export type ReadyTranscriber = Readonly<{
  executablePath: string;
  modelPath: string;
  descriptor: WhisperCppTranscriberDescriptor;
  runtimeClosure: RuntimeClosureAttestation;
}>;

export type SetupWhisperCppTranscriberOptions = Readonly<{
  modelPath: string;
  executablePath?: string;
  replace?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  configPath?: string;
}>;

export type LoadConfiguredTranscriberOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  configPath?: string;
}>;

export type ConfiguredTranscriberInvalidReason =
  | "invalid-location"
  | "unsafe-config"
  | "config-too-large"
  | "config-permissions"
  | "unstable-config"
  | "malformed-config"
  | "missing-executable"
  | "invalid-executable"
  | "executable-too-large"
  | "executable-hash-mismatch"
  | "capability-mismatch"
  | "runtime-attestation-failed"
  | "runtime-closure-mismatch"
  | "missing-model"
  | "invalid-model"
  | "model-too-large"
  | "model-hash-mismatch"
  | "unstable-file";

export type LoadConfiguredTranscriberResult =
  | Readonly<{ kind: "not-configured" }>
  | Readonly<{ kind: "ready"; transcriber: ReadyTranscriber }>
  | Readonly<{
    kind: "invalid";
    reason: ConfiguredTranscriberInvalidReason;
    message: string;
  }>;

export type ReverifyReadyTranscriberResult = Exclude<
  LoadConfiguredTranscriberResult,
  Readonly<{ kind: "not-configured" }>
>;

export type WhisperCppTranscriberSetupErrorCode =
  | "INVALID_OPTIONS"
  | "EXECUTABLE_NOT_FOUND"
  | "INVALID_EXECUTABLE"
  | "INVALID_MODEL"
  | "FILE_TOO_LARGE"
  | "UNSTABLE_FILE"
  | "CAPABILITY_MISMATCH"
  | "RUNTIME_ATTESTATION_FAILED"
  | "RUNTIME_CLOSURE_MISMATCH"
  | "CONFIG_EXISTS"
  | "CONFIG_UNSAFE"
  | "CONFIG_WRITE_FAILED"
  | "CONFIG_RACE";

export class WhisperCppTranscriberSetupError extends Error {
  readonly code: WhisperCppTranscriberSetupErrorCode;

  constructor(code: WhisperCppTranscriberSetupErrorCode, message: string) {
    super(message);
    this.name = "WhisperCppTranscriberSetupError";
    this.code = code;
  }
}

export type WhisperCppTranscriberDependencies = Readonly<{
  findExecutable: (
    name: string,
    options: ExecutableDiscoveryOptions,
  ) => Promise<string | null>;
  runProcess: (argv: CommandArgv, options: RunProcessOptions) => Promise<ProcessResult>;
  attestRuntimeClosure: (
    options: AttestRuntimeClosureOptions,
  ) => Promise<RuntimeClosureAttestation>;
  randomToken: () => string;
}>;

export type ReverifyReadyTranscriberOptions = Readonly<{
  signal?: AbortSignal;
}>;

interface WhisperCppConfigDocument {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly adapter: "whisper-cpp";
  readonly profile: typeof WHISPER_CPP_PROFILE;
  readonly executablePath: string;
  readonly modelPath: string;
  readonly executableSha256: string;
  readonly modelSha256: string;
  readonly modelBytes: number;
  readonly runtimeClosure: RuntimeClosureRecord;
}

type VerifiedFileRole = "executable" | "model";
type VerifiedFileFailureReason = "missing" | "unsafe" | "too-large" | "unstable";

type VerifiedFileResult =
  | Readonly<{
    ok: true;
    physicalPath: string;
    sha256: string;
    bytes: number;
  }>
  | Readonly<{ ok: false; reason: VerifiedFileFailureReason }>;

type ConfigObservation =
  | Readonly<{ kind: "missing" }>
  | Readonly<{
    kind: "invalid";
    reason:
      | "unsafe-config"
      | "config-too-large"
      | "config-permissions"
      | "unstable-config"
      | "malformed-config";
  }>
  | Readonly<{ kind: "configured"; document: WhisperCppConfigDocument }>;

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

const defaultDependencies: WhisperCppTranscriberDependencies = {
  findExecutable: (name, options) => findExecutable(name, options),
  runProcess: (argv, options) => runProcess(argv, options),
  attestRuntimeClosure: (options) => attestRuntimeClosure(options),
  randomToken: () => randomUUID(),
};

const INVALID_MESSAGES = {
  "invalid-location": "The transcriber configuration location is invalid.",
  "unsafe-config": "The transcriber configuration is not a private regular file.",
  "config-too-large": "The transcriber configuration exceeds Wrench media's size limit.",
  "config-permissions": "The transcriber configuration must have mode 0600.",
  "unstable-config": "The transcriber configuration changed while it was being read.",
  "malformed-config": "The transcriber configuration does not match Wrench media's schema.",
  "missing-executable": "The configured transcriber executable is missing.",
  "invalid-executable": "The configured transcriber executable is not a physical executable file.",
  "executable-too-large": "The configured transcriber executable exceeds Wrench media's size limit.",
  "executable-hash-mismatch": "The configured transcriber executable no longer matches its recorded identity.",
  "capability-mismatch": "The configured executable does not provide Wrench media's required whisper.cpp capabilities.",
  "runtime-attestation-failed": "Wrench media could not attest the configured executable's native runtime closure.",
  "runtime-closure-mismatch": "The configured executable's native runtime closure no longer matches its recorded identity.",
  "missing-model": "The configured whisper.cpp model is missing.",
  "invalid-model": "The configured whisper.cpp model is not a physical regular file.",
  "model-too-large": "The configured whisper.cpp model exceeds Wrench media's size limit.",
  "model-hash-mismatch": "The configured whisper.cpp model no longer matches its recorded identity.",
  "unstable-file": "A configured transcriber file changed while it was being verified.",
} as const satisfies Readonly<Record<ConfiguredTranscriberInvalidReason, string>>;

function invalid(
  reason: ConfiguredTranscriberInvalidReason,
): Extract<LoadConfiguredTranscriberResult, { readonly kind: "invalid" }> {
  return { kind: "invalid", reason, message: INVALID_MESSAGES[reason] };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || (point >= 0x7f && point <= 0x9f))) {
      return true;
    }
  }
  return false;
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_PATH_CODE_UNITS
    && !hasControlCharacter(value)
    && isAbsolute(value)
    && resolve(value) === value;
}

function configurationPath(options: LoadConfiguredTranscriberOptions): string | null {
  if (options.configPath !== undefined) {
    return isSafeAbsolutePath(options.configPath) ? options.configPath : null;
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  if (!isSafeAbsolutePath(homeDirectory)) return null;
  const env = options.env ?? process.env;
  const configuredRoot = env.XDG_CONFIG_HOME;
  if (configuredRoot !== undefined && configuredRoot.length > 0) {
    if (!isSafeAbsolutePath(configuredRoot)) return null;
    return join(configuredRoot, "wrench", "media", "transcriber.json");
  }
  return join(homeDirectory, ".config", "wrench", "media", "transcriber.json");
}

function fileIdentity(metadata: BigIntStats): FileIdentity {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function verifyPhysicalFile(
  requestedPath: string,
  role: VerifiedFileRole,
): Promise<VerifiedFileResult> {
  if (!isSafeAbsolutePath(requestedPath)) return { ok: false, reason: "unsafe" };

  let physicalPath: string;
  try {
    physicalPath = await realpath(requestedPath);
  } catch (error) {
    return { ok: false, reason: isErrno(error, "ENOENT") ? "missing" : "unsafe" };
  }
  if (!isSafeAbsolutePath(physicalPath)) return { ok: false, reason: "unsafe" };

  let observed: BigIntStats;
  try {
    observed = await lstat(physicalPath, { bigint: true });
  } catch (error) {
    return { ok: false, reason: isErrno(error, "ENOENT") ? "missing" : "unsafe" };
  }
  const maximumBytes = role === "executable" ? MAX_EXECUTABLE_BYTES : MAX_MODEL_BYTES;
  if (!observed.isFile() || observed.isSymbolicLink() || observed.size <= 0n) {
    return { ok: false, reason: "unsafe" };
  }
  if (observed.size > BigInt(maximumBytes)) return { ok: false, reason: "too-large" };

  let handle;
  try {
    handle = await open(
      physicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return { ok: false, reason: isErrno(error, "ENOENT") ? "missing" : "unsafe" };
  }

  try {
    const opened = await handle.stat({ bigint: true });
    const expected = fileIdentity(opened);
    if (!opened.isFile() || !sameFileIdentity(fileIdentity(observed), expected)) {
      return { ok: false, reason: "unstable" };
    }
    const bytes = Number(opened.size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, bytes));
    let offset = 0;
    while (offset < bytes) {
      const length = Math.min(buffer.byteLength, bytes - offset);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead === 0) return { ok: false, reason: "unstable" };
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, bytes)).bytesRead !== 0) {
      return { ok: false, reason: "unstable" };
    }
    const [finished, finalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(physicalPath, { bigint: true }),
    ]);
    if (
      !finished.isFile()
      || !finalPath.isFile()
      || finalPath.isSymbolicLink()
      || !sameFileIdentity(expected, fileIdentity(finished))
      || !sameFileIdentity(expected, fileIdentity(finalPath))
    ) {
      return { ok: false, reason: "unstable" };
    }
    if (role === "executable") {
      try {
        await access(physicalPath, constants.X_OK);
      } catch {
        return { ok: false, reason: "unsafe" };
      }
    }
    return { ok: true, physicalPath, sha256: hash.digest("hex"), bytes };
  } catch (error) {
    return { ok: false, reason: isErrno(error, "ENOENT") ? "missing" : "unstable" };
  } finally {
    try {
      await handle.close();
    } catch {
      // Verification already owns a stable result; never expose host diagnostics.
    }
  }
}

function helpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[\\s,])${escaped}(?=$|[\\s,=])`, "u").test(help);
}

async function verifiesWhisperCppCapabilities(
  executablePath: string,
  dependencies: WhisperCppTranscriberDependencies,
): Promise<boolean> {
  let result: ProcessResult;
  try {
    result = await dependencies.runProcess([executablePath, "--help"], {
      env: buildWhisperRuntimeEnvironment(),
      timeoutMs: HELP_TIMEOUT_MS,
      maxStdoutBytes: HELP_OUTPUT_LIMIT_BYTES,
      maxStderrBytes: HELP_OUTPUT_LIMIT_BYTES,
    });
  } catch {
    return false;
  }
  if (!result.ok || result.stdoutTruncated || result.stderrTruncated) return false;
  const help = `${result.stdout}\n${result.stderr}`;
  return REQUIRED_HELP_FLAGS.every((flag) => helpHasFlag(help, flag));
}

type ParseConfigResult =
  | Readonly<{ kind: "configured"; document: WhisperCppConfigDocument }>
  | Readonly<{ kind: "malformed" }>;

function parseConfig(value: unknown): ParseConfigResult {
  if (!isRecord(value)) return { kind: "malformed" };
  const expectedKeys = [
    "adapter",
    "executablePath",
    "executableSha256",
    "modelBytes",
    "modelPath",
    "modelSha256",
    "profile",
    "runtimeClosure",
    "schemaVersion",
  ];
  if (JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(expectedKeys)) {
    return { kind: "malformed" };
  }

  const schemaVersion = value["schemaVersion"];
  const adapter = value["adapter"];
  const profile = value["profile"];
  const executablePath = value["executablePath"];
  const modelPath = value["modelPath"];
  const executableSha256 = value["executableSha256"];
  const modelSha256 = value["modelSha256"];
  const modelBytes = value["modelBytes"];
  const runtimeClosure = parseRuntimeClosureRecord(value["runtimeClosure"]);
  if (
    schemaVersion !== CONFIG_SCHEMA_VERSION
    || adapter !== "whisper-cpp"
    || profile !== WHISPER_CPP_PROFILE
    || !isSafeAbsolutePath(executablePath)
    || !isSafeAbsolutePath(modelPath)
    || typeof executableSha256 !== "string"
    || !SHA256_PATTERN.test(executableSha256)
    || typeof modelSha256 !== "string"
    || !SHA256_PATTERN.test(modelSha256)
    || typeof modelBytes !== "number"
    || !Number.isSafeInteger(modelBytes)
    || modelBytes <= 0
    || modelBytes > MAX_MODEL_BYTES
    || !runtimeClosure.ok
    || runtimeClosure.record.executableSha256 !== executableSha256
  ) return { kind: "malformed" };

  return {
    kind: "configured",
    document: {
      schemaVersion,
      adapter,
      profile,
      executablePath,
      modelPath,
      executableSha256,
      modelSha256,
      modelBytes,
      runtimeClosure: runtimeClosure.record,
    },
  };
}

async function observeConfig(path: string): Promise<ConfigObservation> {
  let observed: BigIntStats;
  try {
    observed = await lstat(path, { bigint: true });
  } catch (error) {
    return isErrno(error, "ENOENT")
      ? { kind: "missing" }
      : { kind: "invalid", reason: "unsafe-config" };
  }
  if (!observed.isFile() || observed.isSymbolicLink()) {
    return { kind: "invalid", reason: "unsafe-config" };
  }
  if (observed.size > BigInt(MAX_CONFIG_BYTES)) {
    return { kind: "invalid", reason: "config-too-large" };
  }
  if (process.platform !== "win32" && Number(observed.mode & 0o777n) !== CONFIG_FILE_MODE) {
    return { kind: "invalid", reason: "config-permissions" };
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return isErrno(error, "ENOENT")
      ? { kind: "missing" }
      : { kind: "invalid", reason: "unsafe-config" };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const expected = fileIdentity(opened);
    if (!opened.isFile() || !sameFileIdentity(fileIdentity(observed), expected)) {
      return { kind: "invalid", reason: "unstable-config" };
    }
    if (opened.size > BigInt(MAX_CONFIG_BYTES)) {
      return { kind: "invalid", reason: "config-too-large" };
    }
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) return { kind: "invalid", reason: "unstable-config" };
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, bytes.byteLength)).bytesRead !== 0) {
      return { kind: "invalid", reason: "unstable-config" };
    }
    const [finished, finalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      !finished.isFile()
      || !finalPath.isFile()
      || finalPath.isSymbolicLink()
      || !sameFileIdentity(expected, fileIdentity(finished))
      || !sameFileIdentity(expected, fileIdentity(finalPath))
    ) {
      return { kind: "invalid", reason: "unstable-config" };
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { kind: "invalid", reason: "malformed-config" };
    }
    let value: unknown;
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(source) as unknown;
    } catch {
      return { kind: "invalid", reason: "malformed-config" };
    }
    const parsed = parseConfig(value);
    return parsed.kind === "malformed"
      ? { kind: "invalid", reason: "malformed-config" }
      : parsed;
  } catch (error) {
    return isErrno(error, "ENOENT")
      ? { kind: "missing" }
      : { kind: "invalid", reason: "unstable-config" };
  } finally {
    try {
      await handle.close();
    } catch {
      // The read result is already bounded and host diagnostics stay private.
    }
  }
}

function configSource(document: WhisperCppConfigDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function sameConfig(left: WhisperCppConfigDocument, right: WhisperCppConfigDocument): boolean {
  return configSource(left) === configSource(right);
}

async function prepareConfigDestination(requestedPath: string): Promise<string | null> {
  const requestedDirectory = dirname(requestedPath);
  try {
    await mkdir(requestedDirectory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
    const metadata = await lstat(requestedDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    await chmod(requestedDirectory, CONFIG_DIRECTORY_MODE);
    const physicalDirectory = await realpath(requestedDirectory);
    return join(physicalDirectory, basename(requestedPath));
  } catch {
    return null;
  }
}

async function createTemporaryConfig(
  destination: string,
  source: string,
  dependencies: WhisperCppTranscriberDependencies,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    let token: string;
    try {
      token = dependencies.randomToken().replace(/[^A-Za-z0-9-]/gu, "").slice(0, 64);
    } catch {
      throw new WhisperCppTranscriberSetupError(
        "CONFIG_WRITE_FAILED",
        "Wrench media could not allocate a private transcriber configuration file.",
      );
    }
    if (token.length === 0) continue;
    const temporary = join(dirname(destination), `.${basename(destination)}.${token}.${attempt}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        CONFIG_FILE_MODE,
      );
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      throw new WhisperCppTranscriberSetupError(
        "CONFIG_WRITE_FAILED",
        "Wrench media could not create the private transcriber configuration.",
      );
    }
    try {
      await handle.writeFile(source, { encoding: "utf8" });
      await handle.chmod(CONFIG_FILE_MODE);
      await handle.sync();
      return temporary;
    } catch {
      try {
        await unlink(temporary);
      } catch {
        // The private temporary is safe to leave when cleanup itself fails.
      }
      throw new WhisperCppTranscriberSetupError(
        "CONFIG_WRITE_FAILED",
        "Wrench media could not write the private transcriber configuration.",
      );
    } finally {
      try {
        await handle.close();
      } catch {
        // The file was fsynced before publication; never expose host diagnostics.
      }
    }
  }
  throw new WhisperCppTranscriberSetupError(
    "CONFIG_WRITE_FAILED",
    "Wrench media could not allocate a private transcriber configuration file.",
  );
}

async function verifyPublishedConfig(
  destination: string,
  expected: WhisperCppConfigDocument,
): Promise<void> {
  const published = await observeConfig(destination);
  if (published.kind !== "configured" || !sameConfig(published.document, expected)) {
    throw new WhisperCppTranscriberSetupError(
      "CONFIG_RACE",
      "The transcriber configuration changed during setup.",
    );
  }
}

async function publishConfig(
  requestedDestination: string,
  document: WhisperCppConfigDocument,
  replace: boolean,
  dependencies: WhisperCppTranscriberDependencies,
): Promise<void> {
  const destination = await prepareConfigDestination(requestedDestination);
  if (destination === null) {
    throw new WhisperCppTranscriberSetupError(
      "CONFIG_UNSAFE",
      "Wrench media could not prepare a private transcriber configuration directory.",
    );
  }
  const source = configSource(document);

  for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
    const observed = await observeConfig(destination);
    if (observed.kind === "configured" && sameConfig(observed.document, document)) return;
    if (observed.kind !== "missing" && !replace) {
      throw new WhisperCppTranscriberSetupError(
        "CONFIG_EXISTS",
        "A different transcriber configuration already exists; pass replace to change it.",
      );
    }

    const temporary = await createTemporaryConfig(destination, source, dependencies);
    let published = false;
    try {
      if (observed.kind === "missing") {
        try {
          await link(temporary, destination);
          published = true;
        } catch (error) {
          if (isErrno(error, "EEXIST")) continue;
          throw new WhisperCppTranscriberSetupError(
            "CONFIG_WRITE_FAILED",
            "Wrench media could not publish the private transcriber configuration.",
          );
        }
      } else {
        try {
          await rename(temporary, destination);
          published = true;
        } catch {
          throw new WhisperCppTranscriberSetupError(
            "CONFIG_WRITE_FAILED",
            "Wrench media could not replace the private transcriber configuration.",
          );
        }
      }
      await verifyPublishedConfig(destination, document);
      return;
    } finally {
      if (!published || observed.kind === "missing") {
        try {
          await unlink(temporary);
        } catch (error) {
          if (!isErrno(error, "ENOENT")) {
            // The published destination, if any, remains complete and private.
          }
        }
      }
    }
  }
  throw new WhisperCppTranscriberSetupError(
    "CONFIG_RACE",
    "The transcriber configuration was repeatedly changed during setup.",
  );
}

function setupFileError(role: VerifiedFileRole, reason: VerifiedFileFailureReason): never {
  if (reason === "too-large") {
    throw new WhisperCppTranscriberSetupError(
      "FILE_TOO_LARGE",
      `The whisper.cpp ${role} exceeds Wrench media's size limit.`,
    );
  }
  if (reason === "unstable") {
    throw new WhisperCppTranscriberSetupError(
      "UNSTABLE_FILE",
      `The whisper.cpp ${role} changed while Wrench media verified it.`,
    );
  }
  throw new WhisperCppTranscriberSetupError(
    role === "executable" ? "INVALID_EXECUTABLE" : "INVALID_MODEL",
    `The whisper.cpp ${role} must resolve to a physical regular${role === "executable" ? " executable" : ""} file.`,
  );
}

type VerifiedFile = Extract<VerifiedFileResult, { readonly ok: true }>;

function sameVerifiedFile(left: VerifiedFile, right: VerifiedFile): boolean {
  return left.physicalPath === right.physicalPath
    && left.sha256 === right.sha256
    && left.bytes === right.bytes;
}

async function tryAttestRuntimeClosure(
  executable: VerifiedFile,
  dependencies: WhisperCppTranscriberDependencies,
  options: ReverifyReadyTranscriberOptions = {},
): Promise<RuntimeClosureAttestation | null> {
  try {
    const attestation = await dependencies.attestRuntimeClosure({
      executablePath: executable.physicalPath,
      executableSha256: executable.sha256,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      probeArguments: ["--help"],
    });
    const record = stripRuntimeClosureRecord(attestation);
    return record.executableSha256 === executable.sha256 ? record : null;
  } catch {
    return null;
  }
}

function readyTranscriber(
  executable: VerifiedFile,
  model: VerifiedFile,
  runtimeClosure: RuntimeClosureAttestation,
): ReadyTranscriber {
  return {
    executablePath: executable.physicalPath,
    modelPath: model.physicalPath,
    runtimeClosure,
    descriptor: {
      adapter: "whisper-cpp",
      profile: WHISPER_CPP_PROFILE,
      executableSha256: executable.sha256,
      modelSha256: model.sha256,
      modelBytes: model.bytes,
      runtimeProfile: runtimeClosure.profile,
      runtimeSha256: runtimeClosure.closureSha256,
      runtimeDependencyCount: runtimeClosure.dependencyCount,
    },
  };
}

function configDocument(transcriber: ReadyTranscriber): WhisperCppConfigDocument {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    adapter: transcriber.descriptor.adapter,
    profile: transcriber.descriptor.profile,
    executablePath: transcriber.executablePath,
    modelPath: transcriber.modelPath,
    executableSha256: transcriber.descriptor.executableSha256,
    modelSha256: transcriber.descriptor.modelSha256,
    modelBytes: transcriber.descriptor.modelBytes,
    runtimeClosure: stripRuntimeClosureRecord(transcriber.runtimeClosure),
  };
}

/**
 * Verifies a local whisper.cpp installation and atomically records it without
 * downloading an executable or model.
 */
export async function setupWhisperCppTranscriber(
  options: SetupWhisperCppTranscriberOptions,
  dependencies: WhisperCppTranscriberDependencies = defaultDependencies,
): Promise<ReadyTranscriber> {
  if (
    !isSafeAbsolutePath(options.modelPath)
    || (options.replace !== undefined && typeof options.replace !== "boolean")
  ) {
    throw new WhisperCppTranscriberSetupError(
      "INVALID_OPTIONS",
      "A physical absolute model path and a boolean replace option are required.",
    );
  }
  if (options.executablePath !== undefined && !isSafeAbsolutePath(options.executablePath)) {
    throw new WhisperCppTranscriberSetupError(
      "INVALID_OPTIONS",
      "The whisper.cpp executable path must be absolute when provided.",
    );
  }
  const requestedConfigPath = configurationPath(options);
  if (requestedConfigPath === null) {
    throw new WhisperCppTranscriberSetupError(
      "INVALID_OPTIONS",
      "The transcriber configuration path must be absolute and bounded.",
    );
  }

  let executablePath: string | null | undefined = options.executablePath;
  if (executablePath === undefined) {
    try {
      executablePath = await dependencies.findExecutable("whisper-cli", {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      });
    } catch {
      executablePath = null;
    }
    if (executablePath === null) {
      throw new WhisperCppTranscriberSetupError(
        "EXECUTABLE_NOT_FOUND",
        "Wrench media could not find a local whisper-cli executable.",
      );
    }
  }

  const [executable, model] = await Promise.all([
    verifyPhysicalFile(executablePath, "executable"),
    verifyPhysicalFile(options.modelPath, "model"),
  ]);
  if (!executable.ok) setupFileError("executable", executable.reason);
  if (!model.ok) setupFileError("model", model.reason);

  const runtimeBeforeProbe = await tryAttestRuntimeClosure(executable, dependencies);
  if (runtimeBeforeProbe === null) {
    throw new WhisperCppTranscriberSetupError(
      "RUNTIME_ATTESTATION_FAILED",
      "Wrench media could not attest the executable's native runtime closure.",
    );
  }
  if (!await verifiesWhisperCppCapabilities(executable.physicalPath, dependencies)) {
    throw new WhisperCppTranscriberSetupError(
      "CAPABILITY_MISMATCH",
      "The executable does not provide Wrench media's required whisper.cpp CLI capabilities.",
    );
  }
  const runtimeAfterProbe = await tryAttestRuntimeClosure(executable, dependencies);
  if (runtimeAfterProbe === null) {
    throw new WhisperCppTranscriberSetupError(
      "RUNTIME_ATTESTATION_FAILED",
      "Wrench media could not attest the executable's native runtime closure.",
    );
  }
  const [executableAfterProbe, modelAfterProbe] = await Promise.all([
    verifyPhysicalFile(executable.physicalPath, "executable"),
    verifyPhysicalFile(model.physicalPath, "model"),
  ]);
  if (
    !executableAfterProbe.ok
    || !sameVerifiedFile(executableAfterProbe, executable)
  ) {
    throw new WhisperCppTranscriberSetupError(
      "UNSTABLE_FILE",
      "The whisper.cpp executable changed while Wrench media verified its capabilities.",
    );
  }
  if (
    !modelAfterProbe.ok
    || !sameVerifiedFile(modelAfterProbe, model)
  ) {
    throw new WhisperCppTranscriberSetupError(
      "UNSTABLE_FILE",
      "The whisper.cpp model changed while Wrench media verified the executable's capabilities.",
    );
  }
  if (!sameRuntimeClosure(runtimeBeforeProbe, runtimeAfterProbe)) {
    throw new WhisperCppTranscriberSetupError(
      "RUNTIME_CLOSURE_MISMATCH",
      "The executable's native runtime closure changed during setup.",
    );
  }

  const transcriber = readyTranscriber(
    executableAfterProbe,
    modelAfterProbe,
    runtimeAfterProbe,
  );
  await publishConfig(
    requestedConfigPath,
    configDocument(transcriber),
    options.replace ?? false,
    dependencies,
  );
  return transcriber;
}

function fileInvalidReason(
  role: VerifiedFileRole,
  reason: VerifiedFileFailureReason,
): ConfiguredTranscriberInvalidReason {
  if (reason === "unstable") return "unstable-file";
  if (role === "executable") {
    if (reason === "missing") return "missing-executable";
    if (reason === "too-large") return "executable-too-large";
    return "invalid-executable";
  }
  if (reason === "missing") return "missing-model";
  if (reason === "too-large") return "model-too-large";
  return "invalid-model";
}

function readyRuntimeIsConsistent(transcriber: ReadyTranscriber): boolean {
  return transcriber.descriptor.runtimeProfile === transcriber.runtimeClosure.profile
    && transcriber.descriptor.runtimeSha256 === transcriber.runtimeClosure.closureSha256
    && transcriber.descriptor.runtimeDependencyCount === transcriber.runtimeClosure.dependencyCount
    && transcriber.descriptor.executableSha256 === transcriber.runtimeClosure.executableSha256;
}

/**
 * Accepts the attestation produced by the native inference process itself,
 * exact-compares it, and rehashes executable and model without another child
 * process. Call this before publishing any transcript output.
 */
export async function reverifyReadyTranscriberAfterRun(
  expected: ReadyTranscriber,
  observedRuntimeClosure: RuntimeClosureAttestation,
): Promise<ReverifyReadyTranscriberResult> {
  if (!readyRuntimeIsConsistent(expected)) return invalid("runtime-closure-mismatch");
  let observedRecord: RuntimeClosureRecord;
  try {
    observedRecord = stripRuntimeClosureRecord(observedRuntimeClosure);
  } catch {
    return invalid("runtime-attestation-failed");
  }
  if (!sameRuntimeClosure(observedRecord, expected.runtimeClosure)) {
    return invalid("runtime-closure-mismatch");
  }

  const [executable, model] = await Promise.all([
    verifyPhysicalFile(expected.executablePath, "executable"),
    verifyPhysicalFile(expected.modelPath, "model"),
  ]);
  if (!executable.ok) return invalid(fileInvalidReason("executable", executable.reason));
  if (!model.ok) return invalid(fileInvalidReason("model", model.reason));
  if (executable.physicalPath !== expected.executablePath) return invalid("invalid-executable");
  if (model.physicalPath !== expected.modelPath) return invalid("invalid-model");
  if (executable.sha256 !== expected.descriptor.executableSha256) {
    return invalid("executable-hash-mismatch");
  }
  if (
    model.sha256 !== expected.descriptor.modelSha256
    || model.bytes !== expected.descriptor.modelBytes
  ) return invalid("model-hash-mismatch");
  return {
    kind: "ready",
    transcriber: readyTranscriber(executable, model, observedRecord),
  };
}

/**
 * Re-verifies a ready transcriber after any long-running preparation step and
 * returns a fresh attestation without trusting its earlier file observations.
 */
export async function reverifyReadyTranscriber(
  expected: ReadyTranscriber,
  dependencies: WhisperCppTranscriberDependencies = defaultDependencies,
  options: ReverifyReadyTranscriberOptions = {},
): Promise<ReverifyReadyTranscriberResult> {
  if (!readyRuntimeIsConsistent(expected)) return invalid("runtime-closure-mismatch");

  const [executable, model] = await Promise.all([
    verifyPhysicalFile(expected.executablePath, "executable"),
    verifyPhysicalFile(expected.modelPath, "model"),
  ]);
  if (!executable.ok) return invalid(fileInvalidReason("executable", executable.reason));
  if (!model.ok) return invalid(fileInvalidReason("model", model.reason));
  if (executable.physicalPath !== expected.executablePath) return invalid("invalid-executable");
  if (model.physicalPath !== expected.modelPath) return invalid("invalid-model");
  if (executable.sha256 !== expected.descriptor.executableSha256) {
    return invalid("executable-hash-mismatch");
  }
  if (
    model.sha256 !== expected.descriptor.modelSha256
    || model.bytes !== expected.descriptor.modelBytes
  ) return invalid("model-hash-mismatch");

  const runtimeClosure = await tryAttestRuntimeClosure(executable, dependencies, options);
  if (runtimeClosure === null) return invalid("runtime-attestation-failed");
  if (!sameRuntimeClosure(runtimeClosure, expected.runtimeClosure)) {
    return invalid("runtime-closure-mismatch");
  }

  const [executableAfterAttestation, modelAfterAttestation] = await Promise.all([
    verifyPhysicalFile(executable.physicalPath, "executable"),
    verifyPhysicalFile(model.physicalPath, "model"),
  ]);
  if (!executableAfterAttestation.ok || !sameVerifiedFile(executableAfterAttestation, executable)) {
    return invalid("unstable-file");
  }
  if (!modelAfterAttestation.ok || !sameVerifiedFile(modelAfterAttestation, model)) {
    return invalid("unstable-file");
  }
  return {
    kind: "ready",
    transcriber: readyTranscriber(
      executableAfterAttestation,
      modelAfterAttestation,
      runtimeClosure,
    ),
  };
}

/** Loads a configured local transcriber and re-verifies every persisted claim. */
export async function loadConfiguredTranscriber(
  options: LoadConfiguredTranscriberOptions = {},
  dependencies: WhisperCppTranscriberDependencies = defaultDependencies,
): Promise<LoadConfiguredTranscriberResult> {
  const path = configurationPath(options);
  if (path === null) return invalid("invalid-location");
  const observed = await observeConfig(path);
  if (observed.kind === "missing") return { kind: "not-configured" };
  if (observed.kind === "invalid") return invalid(observed.reason);
  const document = observed.document;

  const [executable, model] = await Promise.all([
    verifyPhysicalFile(document.executablePath, "executable"),
    verifyPhysicalFile(document.modelPath, "model"),
  ]);
  if (!executable.ok) return invalid(fileInvalidReason("executable", executable.reason));
  if (!model.ok) return invalid(fileInvalidReason("model", model.reason));
  if (executable.physicalPath !== document.executablePath) return invalid("invalid-executable");
  if (model.physicalPath !== document.modelPath) return invalid("invalid-model");
  if (executable.sha256 !== document.executableSha256) return invalid("executable-hash-mismatch");
  if (model.sha256 !== document.modelSha256 || model.bytes !== document.modelBytes) {
    return invalid("model-hash-mismatch");
  }
  const runtimeBeforeProbe = await tryAttestRuntimeClosure(executable, dependencies);
  if (runtimeBeforeProbe === null) return invalid("runtime-attestation-failed");
  if (!sameRuntimeClosure(runtimeBeforeProbe, document.runtimeClosure)) {
    return invalid("runtime-closure-mismatch");
  }
  if (!await verifiesWhisperCppCapabilities(executable.physicalPath, dependencies)) {
    return invalid("capability-mismatch");
  }
  const runtimeAfterProbe = await tryAttestRuntimeClosure(executable, dependencies);
  if (runtimeAfterProbe === null) return invalid("runtime-attestation-failed");
  const [executableAfterProbe, modelAfterProbe] = await Promise.all([
    verifyPhysicalFile(executable.physicalPath, "executable"),
    verifyPhysicalFile(model.physicalPath, "model"),
  ]);
  if (!executableAfterProbe.ok) {
    return invalid(fileInvalidReason("executable", executableAfterProbe.reason));
  }
  if (
    !sameVerifiedFile(executableAfterProbe, executable)
  ) return invalid("unstable-file");
  if (
    !modelAfterProbe.ok
    || !sameVerifiedFile(modelAfterProbe, model)
  ) return invalid("unstable-file");
  if (
    !sameRuntimeClosure(runtimeBeforeProbe, runtimeAfterProbe)
    || !sameRuntimeClosure(runtimeAfterProbe, document.runtimeClosure)
  ) return invalid("runtime-closure-mismatch");

  return {
    kind: "ready",
    transcriber: readyTranscriber(executableAfterProbe, modelAfterProbe, runtimeAfterProbe),
  };
}
