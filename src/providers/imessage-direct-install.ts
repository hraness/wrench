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
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    return null;
  }
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
  const candidate = imsgInstalledBinaryPath(environment);
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
  const canonical = await realpath(path);
  const stats = await lstat(path);
  if (
    canonical !== path
    || !stats.isDirectory()
    || stats.isSymbolicLink()
    || stats.uid !== process.getuid?.()
    || (stats.mode & 0o077) !== 0
  ) throw new Error("imsg install directory must be an owned physical private directory");
}

async function copyPinnedBinary(
  sourcePath: string,
  destinationPath: string,
  expectedSha256: string,
): Promise<void> {
  const source = await open(
    sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
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
    ) throw new Error("imsg install source is not a trusted executable file");
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
      if (read.bytesRead < 1) throw new Error("imsg install source changed while copied");
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
        if (result.bytesWritten < 1) throw new Error("imsg install copy failed");
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
    ) throw new Error("imsg install source changed or did not match the reviewed digest");
    await destination.sync();
  } finally {
    await destination?.close();
    await source.close();
  }
  await chmod(destinationPath, 0o500);
  if (await sha256File(destinationPath) !== expectedSha256) {
    throw new Error("installed imsg transport failed its reviewed digest");
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
    throw new Error("imsg install source must be an absolute path");
  }
  const artifact = imsgArtifactForCurrentRuntime();
  const destinationPath = imsgInstalledBinaryPath(environment);
  const installDirectory = join(
    wrenchStateHome(environment),
    "tools",
    "imsg",
    IMSG_REVIEWED_VERSION,
  );
  ensurePrivateStateDirectory(installDirectory, environment);
  await validateInstallDirectory(installDirectory);
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
    throw new Error("existing imsg install does not match the reviewed artifact");
  } catch (error) {
    if (
      typeof error !== "object"
      || error === null
      || !("code" in error)
      || error.code !== "ENOENT"
    ) throw error;
  }
  const temporaryPath = join(
    installDirectory,
    `.imsg-install-${randomBytes(16).toString("hex")}`,
  );
  try {
    await copyPinnedBinary(sourcePath, temporaryPath, artifact.executableSha256);
    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "EEXIST"
      ) throw error;
      if (
        await pinnedBinaryCandidate(destinationPath, artifact.executableSha256)
          === null
      ) throw new Error("concurrent imsg install produced unreviewed bytes");
    }
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "ENOENT"
      ) throw error;
    }
  }
  const installed = await pinnedBinaryCandidate(
    destinationPath,
    artifact.executableSha256,
  );
  if (installed === null) throw new Error("imsg install could not be verified");
  return Object.freeze({
    path: installed,
    executableSha256: artifact.executableSha256,
    version: IMSG_REVIEWED_VERSION,
    alreadyPresent: false,
  });
}
