import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  ensurePrivateStateDirectory,
  wrenchStateHome,
} from "../storage";
import {
  IMSG_REVIEWED_VERSION,
  IMSG_TOOL_PIN,
} from "./imessage-direct";

const MAX_IMSG_BINARY_BYTES = 256 * 1024 * 1024;

class ImsgInstallFailure extends Error {}

function installFailure(message: string): ImsgInstallFailure {
  return new ImsgInstallFailure(message);
}

function filesystemErrorCode(error: unknown): string | null {
  if (
    typeof error !== "object"
    || error === null
    || !("code" in error)
    || typeof error.code !== "string"
  ) return null;
  return error.code;
}

function sourceOpenFailure(error: unknown): ImsgInstallFailure {
  const code = filesystemErrorCode(error);
  if (code === "ENOENT") {
    return installFailure("imsg install source file does not exist");
  }
  if (code === "EACCES" || code === "EPERM") {
    return installFailure("imsg install source file is unreadable");
  }
  if (code === "ELOOP") {
    return installFailure("imsg install source is not a trusted executable file");
  }
  return installFailure("imsg install source file could not be opened safely");
}

export type ImsgInstalledArtifact = Readonly<{
  path: string;
  executableSha256: string;
  version: typeof IMSG_REVIEWED_VERSION;
  alreadyPresent: boolean;
}>;

export function imsgArtifactForCurrentRuntime():
  (typeof IMSG_TOOL_PIN.artifacts)[number] {
  const artifact = IMSG_TOOL_PIN.artifacts.find((candidate) =>
    candidate.platform === process.platform && candidate.arch === process.arch);
  if (artifact === undefined) {
    throw new Error(
      `reviewed imsg transport has no artifact for ${process.platform}/${process.arch}`,
    );
  }
  return artifact;
}

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function pinnedBinaryCandidate(
  path: string,
  executableSha256: string,
): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    if (canonical !== path) return null;
    const stats = await lstat(canonical);
    if (
      !stats.isFile()
      || stats.isSymbolicLink()
      || stats.size < 1
      || stats.size > MAX_IMSG_BINARY_BYTES
      || (stats.mode & 0o022) !== 0
      || (stats.mode & 0o111) === 0
      || (stats.uid !== process.getuid?.() && stats.uid !== 0)
    ) return null;
    return await sha256File(canonical) === executableSha256 ? canonical : null;
  } catch {
    return null;
  }
}

export function imsgInstalledBinaryPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(
    wrenchStateHome(environment),
    "tools",
    "imsg",
    IMSG_REVIEWED_VERSION,
    "imsg",
  );
}

export async function resolvePinnedImsgBinary(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const artifact = imsgArtifactForCurrentRuntime();
  let candidate: string;
  try {
    candidate = imsgInstalledBinaryPath(environment);
  } catch {
    throw installFailure(
      `reviewed imsg transport ${IMSG_REVIEWED_VERSION} is unavailable or failed integrity verification`,
    );
  }
  const resolved = await pinnedBinaryCandidate(
    candidate,
    artifact.executableSha256,
  );
  if (resolved === null) {
    throw new Error(
      `reviewed imsg transport ${IMSG_REVIEWED_VERSION} is unavailable or failed integrity verification`,
    );
  }
  return resolved;
}

async function validateInstallDirectory(path: string): Promise<void> {
  try {
    const canonical = await realpath(path);
    const stats = await lstat(path);
    if (
      canonical !== path
      || !stats.isDirectory()
      || stats.isSymbolicLink()
      || stats.uid !== process.getuid?.()
      || (stats.mode & 0o077) !== 0
    ) {
      throw installFailure(
        "imsg install directory must be an owned physical private directory",
      );
    }
  } catch (error) {
    if (error instanceof ImsgInstallFailure) throw error;
    throw installFailure("imsg install state directory is unavailable or unsafe");
  }
}

async function copyPinnedBinary(
  sourcePath: string,
  destinationPath: string,
  expectedSha256: string,
): Promise<void> {
  let source: Awaited<ReturnType<typeof open>>;
  try {
    source = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw sourceOpenFailure(error);
  }
  let destination;
  try {
    const before = await source.stat();
    if (
      !before.isFile()
      || before.size < 1
      || before.size > MAX_IMSG_BINARY_BYTES
      || (before.mode & 0o022) !== 0
      || (before.mode & 0o111) === 0
      || (before.uid !== process.getuid?.() && before.uid !== 0)
    ) throw installFailure("imsg install source is not a trusted executable file");
    destination = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o500,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const read = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (read.bytesRead < 1) {
        throw installFailure("imsg install source changed while copied");
      }
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await destination.write(
          chunk,
          written,
          chunk.byteLength - written,
          offset + written,
        );
        if (result.bytesWritten < 1) {
          throw installFailure("imsg install copy failed");
        }
        written += result.bytesWritten;
      }
      offset += read.bytesRead;
    }
    const extra = await source.read(Buffer.allocUnsafe(1), 0, 1, offset);
    const after = await source.stat();
    if (
      extra.bytesRead !== 0
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || hash.digest("hex") !== expectedSha256
    ) {
      throw installFailure(
        "imsg install source changed or did not match the reviewed digest",
      );
    }
    await destination.sync();
  } finally {
    await destination?.close();
    await source.close();
  }
  await chmod(destinationPath, 0o500);
  if (await sha256File(destinationPath) !== expectedSha256) {
    throw installFailure("installed imsg transport failed its reviewed digest");
  }
}

/**
 * Install only the exact current-platform bytes produced by the reviewed build.
 * Existing mismatched bytes are never replaced implicitly.
 */
export async function installReviewedImsgBinary(
  sourcePath: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ImsgInstalledArtifact> {
  if (!isAbsolute(sourcePath)) {
    throw installFailure("imsg install source must be an absolute path");
  }
  const artifact = imsgArtifactForCurrentRuntime();
  let stateHome: string;
  try {
    stateHome = wrenchStateHome(environment);
  } catch {
    throw installFailure("imsg install state directory is unavailable or unsafe");
  }
  const installDirectory = join(
    stateHome,
    "tools",
    "imsg",
    IMSG_REVIEWED_VERSION,
  );
  const destinationPath = join(installDirectory, "imsg");
  try {
    ensurePrivateStateDirectory(installDirectory, environment);
    await validateInstallDirectory(installDirectory);
  } catch (error) {
    if (error instanceof ImsgInstallFailure) throw error;
    throw installFailure("imsg install state directory is unavailable or unsafe");
  }
  const existing = await pinnedBinaryCandidate(
    destinationPath,
    artifact.executableSha256,
  );
  if (existing !== null) {
    return Object.freeze({
      path: existing,
      executableSha256: artifact.executableSha256,
      version: IMSG_REVIEWED_VERSION,
      alreadyPresent: true,
    });
  }
  try {
    await lstat(destinationPath);
    throw installFailure(
      "existing imsg install does not match the reviewed artifact",
    );
  } catch (error) {
    if (error instanceof ImsgInstallFailure) throw error;
    if (filesystemErrorCode(error) !== "ENOENT") {
      throw installFailure(
        "existing imsg install could not be inspected safely",
      );
    }
  }
  const temporaryPath = join(
    installDirectory,
    `.imsg-install-${randomBytes(16).toString("hex")}`,
  );
  try {
    try {
      await copyPinnedBinary(
        sourcePath,
        temporaryPath,
        artifact.executableSha256,
      );
    } catch (error) {
      if (error instanceof ImsgInstallFailure) throw error;
      throw installFailure("imsg install I/O failed safely");
    }
    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      if (filesystemErrorCode(error) !== "EEXIST") {
        throw installFailure("imsg install I/O failed safely");
      }
      if (
        await pinnedBinaryCandidate(destinationPath, artifact.executableSha256)
          === null
      ) throw installFailure("concurrent imsg install produced unreviewed bytes");
    }
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (filesystemErrorCode(error) !== "ENOENT") {
        throw installFailure("imsg install I/O cleanup failed safely");
      }
    }
  }
  const installed = await pinnedBinaryCandidate(
    destinationPath,
    artifact.executableSha256,
  );
  if (installed === null) {
    throw installFailure("imsg install could not be verified");
  }
  return Object.freeze({
    path: installed,
    executableSha256: artifact.executableSha256,
    version: IMSG_REVIEWED_VERSION,
    alreadyPresent: false,
  });
}
