import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";

import {
  runProcess,
  type CommandArgv,
  type ProcessResult,
  type ProcessSuccess,
  type RunProcessOptions,
} from "./process";
import { compareUtf8 } from "./utf8-order";

export const RUNTIME_CLOSURE_PROFILE = "wrench-media-native-runtime-closure-v1" as const;
export const RUNTIME_TRACE_TIMEOUT_MS = 10_000;
export const MAX_RUNTIME_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
export const MAX_RUNTIME_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_RUNTIME_TRACE_BYTES = 2 * 1024 * 1024;
export const MAX_RUNTIME_DEPENDENCIES = 256;
export const MAX_RUNTIME_DEPENDENCY_BYTES = 1024 * 1024 * 1024;
export const MAX_RUNTIME_CLOSURE_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_RUNTIME_EXECUTABLE_BYTES = 512 * 1024 * 1024;

const FILE_READ_CHUNK_BYTES = 1024 * 1024;
const MAX_PATH_CODE_UNITS = 4_096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DARWIN_IMAGE_PATTERN = /^dyld\[\d+\]: <[0-9A-Fa-f-]{36}> (\/.*)$/u;
const DARWIN_LOADED_IMAGE_PATTERN = /^dyld(?:\[\d+\])?: loaded: (\/.*)$/u;
const DARWIN_PREFIX_PATTERN = /^dyld(?:\[\d+\])?: /u;
const DARWIN_DELAYED_PATTERN = /^dyld\[\d+\]: move loaded to delayed: [^\r\n]*$/u;
const GLIBC_PREFIX_PATTERN = /^\s*\d+:\s?(.*)$/u;
const GLIBC_FILE_PATTERN = /^file=(.+?)\s+\[\d+\];(?:\s+(?:needed by|dynamically loaded by)\s+(.+?)\s+\[\d+\])?.*$/u;
const GLIBC_OPEN_CLOSE_PATTERN = /^(?:opening|closing) file=(.+?)\s+\[\d+\].*$/u;
const GLIBC_PHASE_PATH_PATTERN = /^(?:calling init|calling fini|initialize program|transferring control):\s*(.*?)\s*$/u;
const GLIBC_IGNORABLE_PATTERN = /^(?:dynamic:|entry:|phdr:|activating NODELETE|destroying link map|scope \d+:|object=|runtime linker statistics:)/u;
const GLIBC_FIND_PATTERN = /^find library=([^\s]+)\s+\[\d+\];\s*searching\s*$/u;
const GLIBC_SEARCH_PATTERN = /^(?:search path=|search cache=)/u;
const GLIBC_TRY_PATTERN = /^trying file=(\/.*)$/u;
const GLIBC_SYNTHETIC_NAMES = new Set(["linux-gate.so.1", "linux-vdso.so.1"]);
const MINIMAL_RUNTIME_ENVIRONMENT = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
});

const LINUX_PLATFORM_RUNTIME_PATTERNS = [
  /^ld-(?:linux|musl)[^/]*\.so(?:\..*)?$/u,
  /^ld64\.so(?:\..*)?$/u,
  /^libc\.so(?:\..*)?$/u,
  /^libm\.so(?:\..*)?$/u,
  /^libpthread\.so(?:\..*)?$/u,
  /^libdl\.so(?:\..*)?$/u,
  /^librt\.so(?:\..*)?$/u,
  /^libutil\.so(?:\..*)?$/u,
  /^libresolv\.so(?:\..*)?$/u,
  /^libstdc\+\+\.so(?:\..*)?$/u,
  /^libgcc_s\.so(?:\..*)?$/u,
  /^libc\+\+\.so(?:\..*)?$/u,
  /^libc\+\+abi\.so(?:\..*)?$/u,
  /^libunwind\.so(?:\..*)?$/u,
] as const;

export type RuntimeClosurePlatform = "darwin" | "linux";

export type RuntimeClosureErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_EXECUTABLE"
  | "INVALID_EXECUTABLE_HASH"
  | "EXECUTABLE_HASH_MISMATCH"
  | "EXECUTABLE_UNSTABLE"
  | "INVALID_PROCESS_LIMIT"
  | "TRACE_PROCESS_FAILED"
  | "TRACE_TOO_LARGE"
  | "TRACE_MISSING"
  | "TRACE_MALFORMED"
  | "TRACE_UNRESOLVED"
  | "DEPENDENCY_LIMIT"
  | "DEPENDENCY_INVALID"
  | "DEPENDENCY_MISSING"
  | "DEPENDENCY_TOO_LARGE"
  | "DEPENDENCY_UNSTABLE"
  | "DEPENDENCY_AMBIGUOUS";

export class RuntimeClosureError extends Error {
  readonly code: RuntimeClosureErrorCode;

  constructor(code: RuntimeClosureErrorCode, message: string) {
    super(message);
    this.name = "RuntimeClosureError";
    this.code = code;
  }
}

export type RuntimeTraceEvidence = "dynamic-loader";

export type RuntimeTraceParseResult =
  | Readonly<{
    ok: true;
    evidence: RuntimeTraceEvidence;
    loadedPaths: readonly string[];
  }>
  | Readonly<{
    ok: false;
    code:
      | "TRACE_MISSING"
      | "TRACE_MALFORMED"
      | "TRACE_UNRESOLVED";
    message: string;
  }>;

export type RuntimeClosureDependency = Readonly<{
  physicalPath: string;
  logicalName: string;
  sha256: string;
  bytes: number;
}>;

export type RuntimeClosureDigestDependency = Readonly<
  Pick<RuntimeClosureDependency, "logicalName" | "sha256" | "bytes">
>;

export type RuntimeClosureRecord = Readonly<{
  profile: typeof RUNTIME_CLOSURE_PROFILE;
  platform: RuntimeClosurePlatform;
  evidence: RuntimeTraceEvidence;
  executableSha256: string;
  closureSha256: string;
  dependencyCount: number;
  dependencyBytes: number;
  dependencies: readonly RuntimeClosureDependency[];
}>;

export type RuntimeClosureAttestation = RuntimeClosureRecord;

export type ParseRuntimeClosureRecordResult =
  | Readonly<{ ok: true; record: RuntimeClosureRecord }>
  | Readonly<{ ok: false; message: string }>;

export type AttestRuntimeClosureOptions = Readonly<{
  executablePath: string;
  executableSha256: string;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  probeArguments?: readonly string[];
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}>;

export type AttestedRuntimeProcessResult = Readonly<{
  process: ProcessSuccess;
  attestation: RuntimeClosureAttestation;
}>;

export type RuntimeClosureDependencies = Readonly<{
  runProcess: (argv: CommandArgv, options: RunProcessOptions) => Promise<ProcessResult>;
}>;

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

type VerifiedDependency = Readonly<{
  requestedPath: string;
  physicalPath: string;
  logicalName: string;
  sha256: string;
  bytes: number;
  dev: bigint;
  ino: bigint;
}>;

type VerifiedExecutable = Readonly<{
  physicalPath: string;
  sha256: string;
  identity: FileIdentity;
}>;

const defaultDependencies: RuntimeClosureDependencies = {
  runProcess: (argv, options) => runProcess(argv, options),
};

function hasUnsafeControlCharacter(value: string, allowTraceWhitespace = false): boolean {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined) continue;
    if (allowTraceWhitespace && (point === 0x09 || point === 0x0a || point === 0x0d)) {
      continue;
    }
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) return true;
  }
  return false;
}

function isSafeAbsolutePath(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_PATH_CODE_UNITS
    && !hasUnsafeControlCharacter(value)
    && isAbsolute(value)
    && resolve(value) === value;
}

/**
 * Builds the complete environment used by capability probing and inference.
 * No inherited value can affect backend selection, numerics, loading, or output.
 */
export function buildWhisperRuntimeEnvironment(
): Readonly<Record<string, string>> {
  return MINIMAL_RUNTIME_ENVIRONMENT;
}

export function buildRuntimeTraceEnvironment(
  platform: RuntimeClosurePlatform,
): Readonly<Record<string, string>> {
  const traceEnvironment: Record<string, string> = {
    ...buildWhisperRuntimeEnvironment(),
  };
  if (platform === "darwin") {
    traceEnvironment.DYLD_PRINT_LIBRARIES = "1";
  } else {
    traceEnvironment.LD_DEBUG = "files";
  }
  return Object.freeze(traceEnvironment);
}

function parseDarwinTrace(
  trace: string,
  executablePath: string,
): RuntimeTraceParseResult {
  const loadedPaths = new Set<string>();
  let sawTraceLine = false;
  let sawExecutable = false;

  for (const rawLine of trace.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const currentImage = DARWIN_IMAGE_PATTERN.exec(line) ?? DARWIN_LOADED_IMAGE_PATTERN.exec(line);
    if (currentImage !== null) {
      sawTraceLine = true;
      const path = currentImage[1];
      if (path === undefined || !isSafeAbsolutePath(path)) {
        return traceFailure("TRACE_MALFORMED", "The Darwin loader trace contains an unsafe image path.");
      }
      loadedPaths.add(path);
      if (path === executablePath) sawExecutable = true;
      continue;
    }
    if (DARWIN_DELAYED_PATTERN.test(line)) {
      sawTraceLine = true;
      continue;
    }
    if (DARWIN_PREFIX_PATTERN.test(line)) {
      return traceFailure("TRACE_MALFORMED", "The Darwin loader trace contains an unknown record.");
    }
  }

  if (!sawTraceLine) {
    return traceFailure("TRACE_MISSING", "The Darwin loader did not produce trace evidence.");
  }
  if (!sawExecutable) {
    return traceFailure("TRACE_MALFORMED", "The Darwin loader trace does not identify the executable.");
  }
  return {
    ok: true,
    evidence: "dynamic-loader",
    loadedPaths: [...loadedPaths].sort(),
  };
}

function parseGlibcTrace(
  trace: string,
  executablePath: string,
): RuntimeTraceParseResult {
  const loadedPaths = new Set<string>();
  const unresolvedLogicalNames = new Set<string>();
  let sawTraceLine = false;
  let sawExecutable = false;
  let searchedLogicalName: string | null = null;
  let lastSearchCandidate: string | null = null;

  for (const rawLine of trace.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const prefixed = GLIBC_PREFIX_PATTERN.exec(line);
    if (prefixed === null) continue;
    sawTraceLine = true;
    const body = (prefixed[1] ?? "").trimStart();
    if (body.length === 0) continue;
    if (/not found|cannot open shared object file|error while loading shared libraries/iu.test(body)) {
      return traceFailure("TRACE_UNRESOLVED", "The glibc loader reported an unresolved image.");
    }

    const findRecord = GLIBC_FIND_PATTERN.exec(body);
    if (findRecord !== null) {
      const logicalName = findRecord[1];
      if (logicalName === undefined
        || logicalName.includes("/")
        || hasUnsafeControlCharacter(logicalName)) {
        return traceFailure("TRACE_MALFORMED", "The glibc loader trace contains an unsafe search record.");
      }
      searchedLogicalName = logicalName;
      lastSearchCandidate = null;
      continue;
    }
    if (GLIBC_SEARCH_PATTERN.test(body)) continue;
    const tryRecord = GLIBC_TRY_PATTERN.exec(body);
    if (tryRecord !== null) {
      const candidate = tryRecord[1];
      if (candidate === undefined || !isSafeAbsolutePath(candidate)) {
        return traceFailure("TRACE_MALFORMED", "The glibc loader trace contains an unsafe search candidate.");
      }
      if (searchedLogicalName !== null && basename(candidate) === searchedLogicalName) {
        lastSearchCandidate = candidate;
      }
      continue;
    }

    const fileRecord = GLIBC_FILE_PATTERN.exec(body);
    if (fileRecord !== null) {
      const file = fileRecord[1];
      const owner = fileRecord[2];
      if (file === undefined || !recordGlibcFile(file, loadedPaths, unresolvedLogicalNames)) {
        return traceFailure("TRACE_MALFORMED", "The glibc loader trace contains an unsafe file record.");
      }
      const logicalFile = stripGlibcIndex(file);
      if (!isAbsolute(logicalFile)
        && searchedLogicalName === logicalFile
        && lastSearchCandidate !== null) {
        loadedPaths.add(lastSearchCandidate);
        searchedLogicalName = null;
        lastSearchCandidate = null;
      }
      if (owner !== undefined) {
        const ownerResult = recordGlibcOwner(owner, executablePath, loadedPaths);
        if (ownerResult === "invalid") {
          return traceFailure("TRACE_MALFORMED", "The glibc loader trace contains an unsafe owner record.");
        }
        if (ownerResult === "executable") sawExecutable = true;
      }
      continue;
    }

    const openCloseRecord = GLIBC_OPEN_CLOSE_PATTERN.exec(body);
    if (openCloseRecord !== null) {
      const path = openCloseRecord[1];
      if (path === undefined || !recordGlibcFile(path, loadedPaths, unresolvedLogicalNames)) {
        return traceFailure("TRACE_MALFORMED", "The glibc loader trace contains an unsafe open record.");
      }
      continue;
    }

    const phaseRecord = GLIBC_PHASE_PATH_PATTERN.exec(body);
    if (phaseRecord !== null) {
      const phasePath = stripGlibcIndex(phaseRecord[1] ?? "");
      if (phasePath.length === 0) continue;
      if (!isSafeAbsolutePath(phasePath)) {
        return traceFailure("TRACE_MALFORMED", "The glibc loader trace contains an unsafe phase path.");
      }
      loadedPaths.add(phasePath);
      if (phasePath === executablePath) sawExecutable = true;
      continue;
    }

    if (GLIBC_IGNORABLE_PATTERN.test(body)) continue;
    if (body.includes("file=") || /(?:^|\s)\//u.test(body)) {
      return traceFailure("TRACE_MALFORMED", "The glibc loader trace contains an unknown path record.");
    }
  }

  if (!sawTraceLine) {
    return traceFailure("TRACE_MISSING", "The glibc loader did not produce trace evidence.");
  }
  if (!sawExecutable) {
    return traceFailure("TRACE_MALFORMED", "The glibc loader trace does not identify the executable.");
  }

  const resolvedNames = new Set([...loadedPaths].map((path) => basename(path)));
  for (const logicalName of unresolvedLogicalNames) {
    if (!resolvedNames.has(logicalName)) {
      return traceFailure("TRACE_UNRESOLVED", "The glibc loader trace leaves an image unresolved.");
    }
  }

  return {
    ok: true,
    evidence: "dynamic-loader",
    loadedPaths: [...loadedPaths].sort(),
  };
}

function recordGlibcFile(
  value: string,
  loadedPaths: Set<string>,
  unresolvedLogicalNames: Set<string>,
): boolean {
  const path = stripGlibcIndex(value);
  if (path.length === 0 || hasUnsafeControlCharacter(path)) return false;
  if (isAbsolute(path)) {
    if (!isSafeAbsolutePath(path)) return false;
    loadedPaths.add(path);
    return true;
  }
  if (path.includes("/") || path === "." || path === "..") return false;
  if (!GLIBC_SYNTHETIC_NAMES.has(path)) unresolvedLogicalNames.add(path);
  return true;
}

function recordGlibcOwner(
  value: string,
  executablePath: string,
  loadedPaths: Set<string>,
): "dependency" | "executable" | "invalid" {
  const path = stripGlibcIndex(value);
  if (!isSafeAbsolutePath(path)) return "invalid";
  loadedPaths.add(path);
  return path === executablePath ? "executable" : "dependency";
}

function stripGlibcIndex(value: string): string {
  return value.replace(/\s+\[\d+\]$/u, "");
}

function traceFailure(
  code: Extract<RuntimeClosureErrorCode,
  "TRACE_MISSING" | "TRACE_MALFORMED" | "TRACE_UNRESOLVED">,
  message: string,
): RuntimeTraceParseResult {
  return { ok: false, code, message };
}

export function parseRuntimeLoaderTrace(
  trace: string,
  options: Readonly<{
    platform: RuntimeClosurePlatform;
    executablePath: string;
  }>,
): RuntimeTraceParseResult {
  if (Buffer.byteLength(trace, "utf8") > MAX_RUNTIME_TRACE_BYTES) {
    return traceFailure("TRACE_MALFORMED", "The loader trace exceeds Wrench media's parse limit.");
  }
  if (hasUnsafeControlCharacter(trace, true) || !isSafeAbsolutePath(options.executablePath)) {
    return traceFailure("TRACE_MALFORMED", "The loader trace contains unsafe input.");
  }
  return options.platform === "darwin"
    ? parseDarwinTrace(trace, options.executablePath)
    : parseGlibcTrace(trace, options.executablePath);
}

export function isPlatformOwnedRuntimePath(
  path: string,
  platform: RuntimeClosurePlatform,
): boolean {
  if (!isSafeAbsolutePath(path)) return false;
  if (platform === "darwin") {
    return path.startsWith("/usr/lib/")
      || path.startsWith("/System/Library/")
      || path.startsWith("/System/iOSSupport/usr/lib/")
      || path.startsWith("/System/iOSSupport/System/Library/")
      || path.startsWith("/Library/Apple/System/Library/");
  }

  const inPlatformDirectory = path.startsWith("/lib/")
    || path.startsWith("/lib64/")
    || path.startsWith("/usr/lib/")
    || path.startsWith("/usr/lib64/");
  if (!inPlatformDirectory) return false;
  const name = basename(path);
  return LINUX_PLATFORM_RUNTIME_PATTERNS.some((pattern) => pattern.test(name));
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

async function hashFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: number,
  unstableCode: "DEPENDENCY_UNSTABLE" | "EXECUTABLE_UNSTABLE",
): Promise<string> {
  const digest = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, Math.max(1, bytes)));
  let offset = 0;
  while (offset < bytes) {
    const length = Math.min(chunk.byteLength, bytes - offset);
    const read = await handle.read(chunk, 0, length, offset);
    if (read.bytesRead !== length) {
      throw new RuntimeClosureError(
        unstableCode,
        "A runtime file changed while it was being hashed.",
      );
    }
    digest.update(chunk.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  return digest.digest("hex");
}

async function verifyExecutableSnapshot(requestedPath: string): Promise<VerifiedExecutable> {
  if (!isSafeAbsolutePath(requestedPath)) {
    throw new RuntimeClosureError("INVALID_EXECUTABLE", "The executable path is invalid.");
  }
  let physicalPath: string;
  try {
    physicalPath = await realpath(requestedPath);
  } catch {
    throw new RuntimeClosureError("INVALID_EXECUTABLE", "The executable is missing.");
  }
  if (!isSafeAbsolutePath(physicalPath)) {
    throw new RuntimeClosureError("INVALID_EXECUTABLE", "The executable target is invalid.");
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const pathMetadata = await lstat(physicalPath, { bigint: true });
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new RuntimeClosureError("INVALID_EXECUTABLE", "The executable is not a physical file.");
    }
    handle = await open(
      physicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const beforeMetadata = await handle.stat({ bigint: true });
    if (!beforeMetadata.isFile()
      || !sameFileIdentity(fileIdentity(pathMetadata), fileIdentity(beforeMetadata))) {
      throw new RuntimeClosureError(
        "EXECUTABLE_UNSTABLE",
        "The executable changed before it could be opened.",
      );
    }
    if (beforeMetadata.size < 0n
      || beforeMetadata.size > BigInt(MAX_RUNTIME_EXECUTABLE_BYTES)) {
      throw new RuntimeClosureError(
        "INVALID_EXECUTABLE",
        "The executable exceeds Wrench media's runtime attestation limit.",
      );
    }
    const bytes = Number(beforeMetadata.size);
    const sha256 = await hashFileHandle(handle, bytes, "EXECUTABLE_UNSTABLE");
    const afterMetadata = await handle.stat({ bigint: true });
    const afterPathMetadata = await lstat(physicalPath, { bigint: true });
    const repeatedPhysicalPath = await realpath(requestedPath);
    const identity = fileIdentity(beforeMetadata);
    if (!sameFileIdentity(identity, fileIdentity(afterMetadata))
      || !sameFileIdentity(identity, fileIdentity(afterPathMetadata))
      || repeatedPhysicalPath !== physicalPath) {
      throw new RuntimeClosureError(
        "EXECUTABLE_UNSTABLE",
        "The executable changed while it was being verified.",
      );
    }
    return { physicalPath, sha256, identity };
  } catch (error) {
    if (error instanceof RuntimeClosureError) throw error;
    throw new RuntimeClosureError("INVALID_EXECUTABLE", "The executable could not be verified.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyDependency(requestedPath: string): Promise<VerifiedDependency> {
  if (!isSafeAbsolutePath(requestedPath)) {
    throw new RuntimeClosureError("DEPENDENCY_INVALID", "A runtime dependency path is unsafe.");
  }

  let physicalPath: string;
  try {
    physicalPath = await realpath(requestedPath);
  } catch {
    throw new RuntimeClosureError("DEPENDENCY_MISSING", "A runtime dependency is missing.");
  }
  if (!isSafeAbsolutePath(physicalPath)) {
    throw new RuntimeClosureError("DEPENDENCY_INVALID", "A runtime dependency target is unsafe.");
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const pathMetadata = await lstat(physicalPath, { bigint: true });
    if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
      throw new RuntimeClosureError(
        "DEPENDENCY_INVALID",
        "A runtime dependency is not a physical regular file.",
      );
    }
    handle = await open(
      physicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const beforeMetadata = await handle.stat({ bigint: true });
    if (!beforeMetadata.isFile()
      || !sameFileIdentity(fileIdentity(pathMetadata), fileIdentity(beforeMetadata))) {
      throw new RuntimeClosureError(
        "DEPENDENCY_UNSTABLE",
        "A runtime dependency changed before it could be opened.",
      );
    }
    if (beforeMetadata.size < 0n
      || beforeMetadata.size > BigInt(MAX_RUNTIME_DEPENDENCY_BYTES)) {
      throw new RuntimeClosureError(
        "DEPENDENCY_TOO_LARGE",
        "A runtime dependency exceeds Wrench media's per-file limit.",
      );
    }

    const bytes = Number(beforeMetadata.size);
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, Math.max(1, bytes)));
    let offset = 0;
    while (offset < bytes) {
      const length = Math.min(chunk.byteLength, bytes - offset);
      const read = await handle.read(chunk, 0, length, offset);
      if (read.bytesRead !== length) {
        throw new RuntimeClosureError(
          "DEPENDENCY_UNSTABLE",
          "A runtime dependency changed while it was being hashed.",
        );
      }
      digest.update(chunk.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }

    const afterMetadata = await handle.stat({ bigint: true });
    const afterPathMetadata = await lstat(physicalPath, { bigint: true });
    const repeatedPhysicalPath = await realpath(requestedPath);
    if (!sameFileIdentity(fileIdentity(beforeMetadata), fileIdentity(afterMetadata))
      || !sameFileIdentity(fileIdentity(beforeMetadata), fileIdentity(afterPathMetadata))
      || repeatedPhysicalPath !== physicalPath) {
      throw new RuntimeClosureError(
        "DEPENDENCY_UNSTABLE",
        "A runtime dependency changed while it was being verified.",
      );
    }

    return {
      requestedPath,
      physicalPath,
      logicalName: basename(requestedPath),
      sha256: digest.digest("hex"),
      bytes,
      dev: beforeMetadata.dev,
      ino: beforeMetadata.ino,
    };
  } catch (error) {
    if (error instanceof RuntimeClosureError) throw error;
    throw new RuntimeClosureError("DEPENDENCY_MISSING", "A runtime dependency could not be verified.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function writeLengthPrefixed(digest: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  digest.update(length);
  digest.update(bytes);
}

export function computeRuntimeClosureSha256(
  platform: RuntimeClosurePlatform,
  executableSha256: string,
  dependencies: readonly RuntimeClosureDigestDependency[],
): string {
  if (!SHA256_PATTERN.test(executableSha256)) {
    throw new RuntimeClosureError(
      "INVALID_EXECUTABLE_HASH",
      "The executable identity is not a SHA-256 digest.",
    );
  }
  const ordered = [...dependencies].sort((left, right) => {
    const byName = compareUtf8(left.logicalName, right.logicalName);
    if (byName !== 0) return byName;
    const byBytes = left.bytes - right.bytes;
    return byBytes !== 0 ? byBytes : compareUtf8(left.sha256, right.sha256);
  });
  const digest = createHash("sha256");
  for (const value of [
    RUNTIME_CLOSURE_PROFILE,
    platform,
    "executable",
    executableSha256,
    "dependency-count",
    String(ordered.length),
  ]) {
    writeLengthPrefixed(digest, value);
  }
  for (const dependency of ordered) {
    writeLengthPrefixed(digest, "dependency");
    writeLengthPrefixed(digest, dependency.logicalName);
    writeLengthPrefixed(digest, String(dependency.bytes));
    writeLengthPrefixed(digest, dependency.sha256);
  }
  return digest.digest("hex");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isSafeLogicalName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 255
    && !hasUnsafeControlCharacter(value)
    && basename(value) === value
    && value !== "."
    && value !== "..";
}

export function parseRuntimeClosureRecord(value: unknown): ParseRuntimeClosureRecordResult {
  const recordKeys = [
    "profile",
    "platform",
    "evidence",
    "executableSha256",
    "closureSha256",
    "dependencyCount",
    "dependencyBytes",
    "dependencies",
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, recordKeys)) {
    return { ok: false, message: "The runtime closure record does not match Wrench media's schema." };
  }
  const platform = value["platform"];
  const evidence = value["evidence"];
  const executableSha256 = value["executableSha256"];
  const closureSha256 = value["closureSha256"];
  const dependencyCount = value["dependencyCount"];
  const dependencyBytes = value["dependencyBytes"];
  const rawDependencies = value["dependencies"];
  if (value["profile"] !== RUNTIME_CLOSURE_PROFILE
    || (platform !== "darwin" && platform !== "linux")
    || evidence !== "dynamic-loader"
    || typeof executableSha256 !== "string"
    || !SHA256_PATTERN.test(executableSha256)
    || typeof closureSha256 !== "string"
    || !SHA256_PATTERN.test(closureSha256)
    || typeof dependencyCount !== "number"
    || !Number.isSafeInteger(dependencyCount)
    || dependencyCount < 0
    || dependencyCount > MAX_RUNTIME_DEPENDENCIES
    || typeof dependencyBytes !== "number"
    || !Number.isSafeInteger(dependencyBytes)
    || dependencyBytes < 0
    || dependencyBytes > MAX_RUNTIME_CLOSURE_BYTES
    || !Array.isArray(rawDependencies)
    || rawDependencies.length !== dependencyCount) {
    return { ok: false, message: "The runtime closure record contains invalid fields." };
  }

  const dependencies: RuntimeClosureDependency[] = [];
  const logicalNames = new Set<string>();
  const physicalPaths = new Set<string>();
  let countedBytes = 0;
  for (const rawDependency of rawDependencies) {
    if (!isRecord(rawDependency)
      || !hasExactKeys(rawDependency, ["physicalPath", "logicalName", "sha256", "bytes"])) {
      return { ok: false, message: "A runtime closure dependency is malformed." };
    }
    const physicalPath = rawDependency["physicalPath"];
    const logicalName = rawDependency["logicalName"];
    const sha256 = rawDependency["sha256"];
    const bytes = rawDependency["bytes"];
    if (typeof physicalPath !== "string"
      || !isSafeAbsolutePath(physicalPath)
      || !isSafeLogicalName(logicalName)
      || typeof sha256 !== "string"
      || !SHA256_PATTERN.test(sha256)
      || typeof bytes !== "number"
      || !Number.isSafeInteger(bytes)
      || bytes < 0
      || bytes > MAX_RUNTIME_DEPENDENCY_BYTES
      || logicalNames.has(logicalName)
      || physicalPaths.has(physicalPath)) {
      return { ok: false, message: "A runtime closure dependency contains invalid fields." };
    }
    countedBytes += bytes;
    if (countedBytes > MAX_RUNTIME_CLOSURE_BYTES) {
      return { ok: false, message: "The runtime closure exceeds Wrench media's byte limit." };
    }
    logicalNames.add(logicalName);
    physicalPaths.add(physicalPath);
    dependencies.push(Object.freeze({ physicalPath, logicalName, sha256, bytes }));
  }
  const ordered = [...dependencies].sort((left, right) => (
    compareUtf8(left.logicalName, right.logicalName)
      || compareUtf8(left.physicalPath, right.physicalPath)
  ));
  if (dependencies.some((dependency, index) => dependency !== ordered[index])
    || countedBytes !== dependencyBytes
    || computeRuntimeClosureSha256(platform, executableSha256, dependencies) !== closureSha256) {
    return { ok: false, message: "The runtime closure record is internally inconsistent." };
  }

  return {
    ok: true,
    record: Object.freeze({
      profile: RUNTIME_CLOSURE_PROFILE,
      platform,
      evidence,
      executableSha256,
      closureSha256,
      dependencyCount,
      dependencyBytes,
      dependencies: Object.freeze(dependencies),
    }),
  };
}

export function stripRuntimeClosureRecord(
  attestation: RuntimeClosureAttestation,
): RuntimeClosureRecord {
  const parsed = parseRuntimeClosureRecord(attestation);
  if (!parsed.ok) {
    throw new RuntimeClosureError(
      "DEPENDENCY_INVALID",
      "The runtime closure attestation cannot be persisted safely.",
    );
  }
  return parsed.record;
}

export function sameRuntimeClosureRecord(
  left: RuntimeClosureRecord,
  right: RuntimeClosureRecord,
): boolean {
  if (left.profile !== right.profile
    || left.platform !== right.platform
    || left.evidence !== right.evidence
    || left.executableSha256 !== right.executableSha256
    || left.closureSha256 !== right.closureSha256
    || left.dependencyCount !== right.dependencyCount
    || left.dependencyBytes !== right.dependencyBytes
    || left.dependencies.length !== right.dependencies.length) {
    return false;
  }
  return left.dependencies.every((dependency, index) => {
    const other = right.dependencies[index];
    return other !== undefined
      && dependency.physicalPath === other.physicalPath
      && dependency.logicalName === other.logicalName
      && dependency.sha256 === other.sha256
      && dependency.bytes === other.bytes;
  });
}

function runtimePlatform(platform: NodeJS.Platform): RuntimeClosurePlatform {
  if (platform === "darwin" || platform === "linux") return platform;
  throw new RuntimeClosureError(
    "UNSUPPORTED_PLATFORM",
    "Runtime closure attestation supports only Darwin and glibc Linux.",
  );
}

function boundedProcessValue(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new RuntimeClosureError(
      "INVALID_PROCESS_LIMIT",
      "The runtime attestation process limit is invalid.",
    );
  }
  return selected;
}

function sameExecutableSnapshot(left: VerifiedExecutable, right: VerifiedExecutable): boolean {
  return left.physicalPath === right.physicalPath
    && left.sha256 === right.sha256
    && sameFileIdentity(left.identity, right.identity);
}

export async function runAttestedRuntimeProcess(
  options: AttestRuntimeClosureOptions,
  dependencies: RuntimeClosureDependencies = defaultDependencies,
): Promise<AttestedRuntimeProcessResult> {
  const platform = runtimePlatform(options.platform ?? process.platform);
  if (!isSafeAbsolutePath(options.executablePath)) {
    throw new RuntimeClosureError("INVALID_EXECUTABLE", "The executable path is invalid.");
  }
  if (!SHA256_PATTERN.test(options.executableSha256)) {
    throw new RuntimeClosureError(
      "INVALID_EXECUTABLE_HASH",
      "The executable identity is not a SHA-256 digest.",
    );
  }
  const beforeExecutable = await verifyExecutableSnapshot(options.executablePath);
  if (beforeExecutable.sha256 !== options.executableSha256) {
    throw new RuntimeClosureError(
      "EXECUTABLE_HASH_MISMATCH",
      "The executable no longer matches its configured identity.",
    );
  }

  const traceEnvironment = buildRuntimeTraceEnvironment(platform);
  const probeArguments = options.probeArguments ?? ["--help"];
  const argv: CommandArgv = [beforeExecutable.physicalPath, ...probeArguments];
  const result = await dependencies.runProcess(argv, {
    env: traceEnvironment,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: boundedProcessValue(
      options.timeoutMs,
      RUNTIME_TRACE_TIMEOUT_MS,
      MAX_RUNTIME_PROCESS_TIMEOUT_MS,
    ),
    maxStdoutBytes: boundedProcessValue(
      options.maxStdoutBytes,
      MAX_RUNTIME_TRACE_BYTES,
      MAX_RUNTIME_PROCESS_OUTPUT_BYTES,
    ),
    maxStderrBytes: boundedProcessValue(
      options.maxStderrBytes,
      MAX_RUNTIME_TRACE_BYTES,
      MAX_RUNTIME_TRACE_BYTES,
    ),
  });
  const afterExecutable = await verifyExecutableSnapshot(options.executablePath);
  if (afterExecutable.sha256 !== options.executableSha256) {
    throw new RuntimeClosureError(
      "EXECUTABLE_HASH_MISMATCH",
      "The executable changed during runtime attestation.",
    );
  }
  if (!sameExecutableSnapshot(beforeExecutable, afterExecutable)) {
    throw new RuntimeClosureError(
      "EXECUTABLE_UNSTABLE",
      "The executable identity changed during runtime attestation.",
    );
  }
  if (!result.ok) {
    throw new RuntimeClosureError(
      "TRACE_PROCESS_FAILED",
      "The executable failed during bounded runtime closure tracing.",
    );
  }
  if (result.stderrTruncated) {
    throw new RuntimeClosureError("TRACE_TOO_LARGE", "The runtime loader trace was truncated.");
  }

  const parsed = parseRuntimeLoaderTrace(result.stderr, {
    platform,
    executablePath: beforeExecutable.physicalPath,
  });
  if (!parsed.ok) throw new RuntimeClosureError(parsed.code, parsed.message);

  const requestedDependencies = parsed.loadedPaths.filter((path) => (
    path !== beforeExecutable.physicalPath && !isPlatformOwnedRuntimePath(path, platform)
  ));
  if (requestedDependencies.length > MAX_RUNTIME_DEPENDENCIES) {
    throw new RuntimeClosureError(
      "DEPENDENCY_LIMIT",
      "The runtime closure exceeds Wrench media's dependency-count limit.",
    );
  }

  const verifiedDependencies: VerifiedDependency[] = [];
  let dependencyBytes = 0;
  for (const dependencyPath of requestedDependencies) {
    const verified = await verifyDependency(dependencyPath);
    dependencyBytes += verified.bytes;
    if (dependencyBytes > MAX_RUNTIME_CLOSURE_BYTES) {
      throw new RuntimeClosureError(
        "DEPENDENCY_LIMIT",
        "The runtime closure exceeds Wrench media's aggregate byte limit.",
      );
    }
    verifiedDependencies.push(verified);
  }

  const byLogicalName = new Map<string, VerifiedDependency>();
  const byPhysicalIdentity = new Map<string, VerifiedDependency>();
  for (const dependency of verifiedDependencies) {
    const logicalCollision = byLogicalName.get(dependency.logicalName);
    if (logicalCollision !== undefined
      && (logicalCollision.dev !== dependency.dev || logicalCollision.ino !== dependency.ino)) {
      throw new RuntimeClosureError(
        "DEPENDENCY_AMBIGUOUS",
        "The runtime closure maps one logical name to multiple physical files.",
      );
    }
    byLogicalName.set(dependency.logicalName, dependency);

    const identity = `${dependency.dev.toString()}:${dependency.ino.toString()}`;
    const physicalCollision = byPhysicalIdentity.get(identity);
    if (physicalCollision !== undefined
      && physicalCollision.logicalName !== dependency.logicalName) {
      throw new RuntimeClosureError(
        "DEPENDENCY_AMBIGUOUS",
        "The runtime closure maps one physical file to multiple logical names.",
      );
    }
    byPhysicalIdentity.set(identity, dependency);
  }

  const closureDependencies = [...byPhysicalIdentity.values()]
    .map((dependency): RuntimeClosureDependency => ({
      physicalPath: dependency.physicalPath,
      logicalName: dependency.logicalName,
      sha256: dependency.sha256,
      bytes: dependency.bytes,
    }))
    .sort((left, right) => compareUtf8(left.logicalName, right.logicalName));
  const countedBytes = closureDependencies.reduce((total, dependency) => total + dependency.bytes, 0);

  const attestation: RuntimeClosureAttestation = Object.freeze({
    profile: RUNTIME_CLOSURE_PROFILE,
    platform,
    evidence: parsed.evidence,
    executableSha256: options.executableSha256,
    closureSha256: computeRuntimeClosureSha256(
      platform,
      options.executableSha256,
      closureDependencies,
    ),
    dependencyCount: closureDependencies.length,
    dependencyBytes: countedBytes,
    dependencies: Object.freeze(closureDependencies),
  });
  return Object.freeze({ process: result, attestation });
}

export async function attestRuntimeClosure(
  options: AttestRuntimeClosureOptions,
  dependencies: RuntimeClosureDependencies = defaultDependencies,
): Promise<RuntimeClosureAttestation> {
  return (await runAttestedRuntimeProcess(options, dependencies)).attestation;
}

export function sameRuntimeClosure(
  left: RuntimeClosureAttestation,
  right: RuntimeClosureAttestation,
): boolean {
  return sameRuntimeClosureRecord(left, right);
}
