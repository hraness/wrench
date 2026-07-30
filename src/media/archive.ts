import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, opendir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CaptureMode } from "./args";
import { parseFfmpegVersion } from "./doctor";
import { createMediaDerivatives, type CreateMediaDerivativesOptions, type MediaDerivativeReport, type MediaDerivativeRole } from "./ffmpeg";
import {
  WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
  WRENCH_MEDIA_SCHEMA_VERSION,
  WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
  WRENCH_MEDIA_VERSION,
  createMediaArtifact,
  localTranscriptVariantSegments,
  parseMediaDirectHttpProvenance,
  readMediaManifest,
  relativeArtifactPath,
  verifyMediaItem,
  writeMediaManifest,
  type ArtifactRole,
  type MediaArtifact,
  type MediaManifest,
  type MediaYtDlpManifest,
  type MediaLocalTranscriptIdentity,
  type MediaLocalTranscriptProvenance,
  type MediaTranscript,
  type MediaYtDlpIdentity,
} from "./manifest";
import {
  AUTH_CONTEXT_IDENTITY_PROFILE,
  authContextSha256,
  createDirectHttpMetadata,
  identityDirectorySegment,
  isNormalizedProbeMetadata,
  isPortableIdentityDirectorySegment,
  providerIdentitySha256,
  renderProviderMetadataJson,
  selectCaption,
  variantAssetKey,
  type CaptionSelection,
  type ProbeMetadata,
} from "./metadata";
import {
  acquireItemLock,
  ItemLockBusyError,
  ItemLockLostError,
  type ItemLock,
} from "./lock";
import {
  findExecutable,
  redactDiagnostic,
  runProcess,
  urlDerivedRedactions,
} from "./process";
import { parseWebVtt } from "./transcript";
import {
  loadConfiguredTranscriber,
  type LoadConfiguredTranscriberOptions,
  type LoadConfiguredTranscriberResult,
  type ReadyTranscriber,
} from "./transcriber-config";
import { sameRuntimeClosureRecord } from "./runtime-closure";
import {
  transcribeAudioLocally,
  type LocalTranscriptionResult,
  type TranscribeAudioLocallyOptions,
} from "./local-transcription";
import { normalizeWhisperCppLanguage } from "./whisper-cpp";
import { compareUtf8 } from "./utf8-order";
import {
  resolveDirectMediaProbe,
  routeSource,
  type DirectHttpMediaProbeRoute,
  type DirectHttpTranscriptProbeRoute,
} from "./source-router";
import {
  captureDirectHttp,
  type DirectHttpCapture,
  type DirectHttpCaptureOptions,
  type DirectHttpCaptureResult,
  type DirectHttpCaptureSink,
} from "./http-capture";
import {
  directHttpMediaForContainer,
  type DirectHttpMedia,
} from "./http";
import {
  DirectHttpProbeTransport,
  probeDirectHttp,
  type DirectHttpProbe,
  type DirectHttpProbeOptions,
  type DirectHttpProbeResult,
} from "./http-probe";
import {
  captureWithYtDlp,
  isSafeYtDlpCaptureExtension,
  probeWithYtDlp,
  ytDlpVersion,
  type CaptureYtDlpOptions,
  type ProbeYtDlpOptions,
  type YtDlpCaptureResult,
  type YtDlpProbeResult,
} from "./yt-dlp";
import {
  MAX_REVISION_SEQUENCE,
  MAX_TRACKED_REVISION_ITEMS,
  WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
  WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  REVISION_CAPTURE_NAMESPACE,
  parseRevisionItemLeaf,
  revisionContentSha256,
  revisionItemLeaf,
  trackedRevisionAssetKey,
  type MediaTrackedRevision,
} from "./revision";

const imageExtensions = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
export const FOCUSED_CAPTURE_NAMESPACE = ".wrench-media-variants" as const;
export const DIRECT_HTTP_CAPTURE_NAMESPACE = "direct-http-v1" as const;

export type MediaArchiveErrorCode =
  | "CANCELLED"
  | "DEPENDENCY_MISSING"
  | "UNSUPPORTED_SOURCE"
  | "PROBE_FAILED"
  | "TRANSCRIPT_UNAVAILABLE"
  | "CAPTURE_FAILED"
  | "DERIVATION_FAILED"
  | "TRANSCRIPTION_FAILED"
  | "ARCHIVE_CONFLICT"
  | "ARCHIVE_INVALID"
  | "BUSY"
  | "IO_ERROR";

export class MediaArchiveError extends Error {
  readonly code: MediaArchiveErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: MediaArchiveErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "MediaArchiveError";
    this.code = code;
    this.details = details;
  }
}

export interface MediaArchiveOptions {
  readonly url: string;
  readonly mode: CaptureMode;
  readonly language: string;
  readonly signal?: AbortSignal;
  readonly libraryDirectory?: string;
  readonly browser?: string;
  readonly authContext?: string;
  readonly inheritYtDlpConfig: boolean;
  /** Explicitly reacquire yt-dlp content before resolving the immutable head. */
  readonly refresh?: boolean;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}

export interface MediaArchiveResult {
  readonly status: "created" | "existing";
  readonly itemDirectory: string;
  readonly manifest: MediaManifest;
  readonly warnings: readonly string[];
}

interface OrganizedCapture {
  readonly mediaPath: string | null;
  readonly captionPath: string | null;
  readonly descriptionPath: string | null;
  readonly thumbnailPath: string | null;
}

export interface MediaArchiveDependencies {
  readonly findExecutable: (name: string, options: { readonly env?: Readonly<Record<string, string | undefined>>; readonly homeDirectory?: string }) => Promise<string | null>;
  readonly probe: (options: ProbeYtDlpOptions) => Promise<YtDlpProbeResult>;
  readonly capture: (options: CaptureYtDlpOptions) => Promise<YtDlpCaptureResult>;
  readonly derive: (options: CreateMediaDerivativesOptions) => Promise<MediaDerivativeReport>;
  readonly ytDlpVersion: (executable: string) => Promise<string>;
  readonly ffmpegVersion: (executable: string) => Promise<string>;
  readonly probeDirectHttp: (
    url: string,
    options?: DirectHttpProbeOptions,
  ) => Promise<DirectHttpProbeResult>;
  readonly captureDirectHttp: (
    probe: DirectHttpProbe,
    sink: DirectHttpCaptureSink,
    options?: DirectHttpCaptureOptions,
  ) => Promise<DirectHttpCaptureResult>;
  readonly loadConfiguredTranscriber: (
    options: LoadConfiguredTranscriberOptions,
  ) => Promise<LoadConfiguredTranscriberResult>;
  readonly transcribeAudioLocally: (
    options: TranscribeAudioLocallyOptions,
  ) => Promise<LocalTranscriptionResult>;
  readonly now: () => Date;
}

const defaultDependencies: MediaArchiveDependencies = {
  findExecutable: async (name, options) => await findExecutable(name, options),
  probe: async (options) => await probeWithYtDlp(options),
  capture: async (options) => await captureWithYtDlp(options),
  derive: async (options) => await createMediaDerivatives(options),
  ytDlpVersion: async (executable) => await ytDlpVersion(executable),
  ffmpegVersion: async (executable) => {
    const result = await runProcess([executable, "-version"], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
    if (!result.ok) return "unknown";
    return parseFfmpegVersion(`${result.stdout}\n${result.stderr}`) ?? "unknown";
  },
  probeDirectHttp: async (url, options) => await probeDirectHttp(url, options),
  captureDirectHttp: async (probe, sink, options) =>
    await captureDirectHttp(probe, sink, options),
  loadConfiguredTranscriber: async (options) => await loadConfiguredTranscriber(options),
  transcribeAudioLocally: async (options) => await transcribeAudioLocally(options),
  now: () => new Date(),
};

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function libraryDirectory(options: MediaArchiveOptions): string {
  if (options.libraryDirectory !== undefined) return resolve(options.libraryDirectory);
  const configured = options.environment?.["WRENCH_MEDIA_HOME"];
  if (configured !== undefined && configured.length > 0 && !configured.includes("\0")) return resolve(configured);
  return resolve(options.homeDirectory ?? homedir(), ".local", "share", "wrench", "media");
}

async function requireExecutable(
  name: "yt-dlp" | "ffmpeg" | "ffprobe",
  options: MediaArchiveOptions,
  dependencies: MediaArchiveDependencies,
): Promise<string> {
  const executable = await dependencies.findExecutable(name, {
    ...(options.environment === undefined ? {} : { env: options.environment }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  });
  if (executable === null) throw new MediaArchiveError("DEPENDENCY_MISSING", `${name} is required; run wrench doctor for setup guidance`, { tool: name });
  return executable;
}

async function readExistingManifest(itemDirectory: string): Promise<MediaManifest> {
  const verification = await verifyMediaItem(itemDirectory);
  if (!verification.ok) {
    throw new MediaArchiveError("ARCHIVE_INVALID", "an existing item failed integrity verification", {
      itemDirectory,
      failures: verification.failures,
    });
  }
  try {
    return await readMediaManifest(itemDirectory);
  } catch (error) {
    throw new MediaArchiveError(
      "ARCHIVE_INVALID",
      error instanceof Error ? error.message : "existing wrench-media.json is invalid",
    );
  }
}

function manifestSatisfiesMode(manifest: MediaManifest, mode: CaptureMode): boolean {
  if (manifest.mode !== mode) return false;
  const roles = new Set(manifest.artifacts.map((artifact) => artifact.role));
  const hasTranscriptArtifact = roles.has("transcript_vtt")
    || roles.has("transcript_text")
    || roles.has("transcript_json");
  switch (mode) {
    case "archive":
      return roles.has("capture") && (roles.has("video") || roles.has("audio"));
    case "audio":
      return roles.has("capture")
        && roles.has("audio")
        && !roles.has("video")
        && !hasTranscriptArtifact
        && manifest.transcript.status === "unavailable";
    case "video":
      return roles.has("capture")
        && roles.has("video")
        && !roles.has("audio")
        && !hasTranscriptArtifact
        && manifest.transcript.status === "unavailable";
    case "transcript":
      if (manifest.transcript.status !== "available") return false;
      return manifest.transcript.source === "local"
        ? roles.has("capture") && roles.has("audio") && !roles.has("video")
        : !roles.has("capture") && !roles.has("audio") && !roles.has("video");
  }
}

function requestedDerivativeRoles(mode: CaptureMode): readonly MediaDerivativeRole[] {
  switch (mode) {
    case "archive":
      return ["video", "audio"];
    case "audio":
      return ["audio"];
    case "video":
      return ["video"];
    case "transcript":
      return [];
  }
}

function assertManifestSatisfiesMode(manifest: MediaManifest, mode: CaptureMode): void {
  if (manifestSatisfiesMode(manifest, mode)) return;
  if (mode === "transcript") {
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      "the completed capture does not contain the requested transcript artifact contract",
    );
  }
  throw new MediaArchiveError(
    "DERIVATION_FAILED",
    `the completed capture does not contain the requested ${mode} artifact contract`,
  );
}

export interface CaptureIdentity {
  readonly kind: "archive" | "focused";
  readonly itemPathSegments: readonly string[];
  readonly storagePathSegments: readonly string[];
  readonly assetKey: string;
}

export interface RevisionLineageIdentity {
  readonly itemParentPathSegments: readonly string[];
  readonly storagePathSegments: readonly string[];
  readonly subjectAssetKey: string;
}

export type CaptureIdentityRequest =
  | Readonly<{ mode: "archive" }>
  | Readonly<{ mode: "audio" }>
  | Readonly<{ mode: "video" }>
  | Readonly<{
      mode: "transcript";
      transcript:
        | Readonly<{
            kind: "provider";
            source: "manual" | "automatic";
            language: string;
          }>
        | Readonly<{
            kind: "local";
            identity: MediaLocalTranscriptIdentity;
          }>;
    }>;

type DirectHttpCaptureRoute = DirectHttpMediaProbeRoute | DirectHttpTranscriptProbeRoute;

type LocalTranscriptionPlan =
  | Readonly<{ kind: "not-configured" }>
  | Readonly<{
      kind: "ready";
      requestedLanguage: string;
      transcriber: ReadyTranscriber;
      identity: MediaLocalTranscriptIdentity;
    }>;

function normalizedLocalLanguage(language: string): string {
  const normalized = normalizeWhisperCppLanguage(language);
  if (normalized === null) {
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      "local transcription language must be auto or a literal BCP-47-style tag",
    );
  }
  return normalized;
}

function localTranscriberLoadOptions(
  options: MediaArchiveOptions,
): LoadConfiguredTranscriberOptions {
  return {
    ...(options.environment === undefined ? {} : { env: options.environment }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
  };
}

async function loadLocalTranscriptionPlan(
  options: MediaArchiveOptions,
  dependencies: MediaArchiveDependencies,
): Promise<LocalTranscriptionPlan> {
  const requestedLanguage = normalizedLocalLanguage(options.language);
  let configured: LoadConfiguredTranscriberResult;
  try {
    configured = await dependencies.loadConfiguredTranscriber(
      localTranscriberLoadOptions(options),
    );
  } catch {
    throw new MediaArchiveError(
      "DEPENDENCY_MISSING",
      "the local transcriber configuration could not be verified",
      { dependency: "local-transcriber" },
    );
  }
  if (configured.kind === "not-configured") return configured;
  if (configured.kind === "invalid") {
    throw new MediaArchiveError(
      "DEPENDENCY_MISSING",
      configured.message,
      { dependency: "local-transcriber", reason: configured.reason },
    );
  }
  return {
    kind: "ready",
    requestedLanguage,
    transcriber: configured.transcriber,
    identity: {
      adapter: configured.transcriber.descriptor.adapter,
      profile: configured.transcriber.descriptor.profile,
      executableSha256: configured.transcriber.descriptor.executableSha256,
      runtimeProfile: configured.transcriber.descriptor.runtimeProfile,
      runtimeSha256: configured.transcriber.descriptor.runtimeSha256,
      runtimeDependencyCount: configured.transcriber.descriptor.runtimeDependencyCount,
      modelSha256: configured.transcriber.descriptor.modelSha256,
      normalizationProfile: WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
      requestedLanguage,
    },
  };
}

function sameReadyTranscriber(left: ReadyTranscriber, right: ReadyTranscriber): boolean {
  return left.executablePath === right.executablePath
    && left.modelPath === right.modelPath
    && left.descriptor.adapter === right.descriptor.adapter
    && left.descriptor.profile === right.descriptor.profile
    && left.descriptor.executableSha256 === right.descriptor.executableSha256
    && left.descriptor.runtimeProfile === right.descriptor.runtimeProfile
    && left.descriptor.runtimeSha256 === right.descriptor.runtimeSha256
    && left.descriptor.runtimeDependencyCount === right.descriptor.runtimeDependencyCount
    && left.descriptor.modelSha256 === right.descriptor.modelSha256
    && left.descriptor.modelBytes === right.descriptor.modelBytes
    && sameRuntimeClosureRecord(left.runtimeClosure, right.runtimeClosure);
}

async function reverifyLocalTranscriptionPlan(
  options: MediaArchiveOptions,
  plan: Extract<LocalTranscriptionPlan, { kind: "ready" }>,
  dependencies: MediaArchiveDependencies,
): Promise<ReadyTranscriber> {
  let configured: LoadConfiguredTranscriberResult;
  try {
    configured = await dependencies.loadConfiguredTranscriber(
      localTranscriberLoadOptions(options),
    );
  } catch {
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      "the local transcriber could not be reverified immediately before transcription",
    );
  }
  if (configured.kind !== "ready" || !sameReadyTranscriber(configured.transcriber, plan.transcriber)) {
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      "the configured local transcriber changed after the capture identity was planned",
    );
  }
  return configured.transcriber;
}

function requireFocusedLocalPlan(plan: LocalTranscriptionPlan): Extract<LocalTranscriptionPlan, { kind: "ready" }> {
  if (plan.kind === "not-configured") {
    throw new MediaArchiveError(
      "TRANSCRIPT_UNAVAILABLE",
      "the provider exposes no captions and no local transcriber is configured",
    );
  }
  return plan;
}

function boundedLanguageSegment(value: string): string {
  const candidate = identityDirectorySegment(value.toLowerCase(), "language");
  return candidate.length <= 64
    ? candidate
    : identityDirectorySegment(`/${value.toLowerCase()}`, "language");
}

function focusedVariantSegments(
  request: Exclude<CaptureIdentityRequest, { readonly mode: "archive" }>,
): readonly string[] {
  switch (request.mode) {
    case "audio":
      return ["audio"];
    case "video":
      return ["video"];
    case "transcript": {
      if (request.transcript.kind === "local") {
        return localTranscriptVariantSegments(request.transcript.identity);
      }
      return [
        "transcript",
        request.transcript.source,
        boundedLanguageSegment(request.transcript.language),
      ];
    }
  }
}

function assertNormalizedSourceIdentity(metadata: ProbeMetadata): void {
  if (!isNormalizedProbeMetadata(metadata)) {
    throw new MediaArchiveError(
      "PROBE_FAILED",
      "the provider returned an inconsistent normalized source identity",
    );
  }
}

export function captureIdentity(
  metadata: ProbeMetadata,
  request: CaptureIdentityRequest,
): CaptureIdentity {
  assertNormalizedSourceIdentity(metadata);
  if (request.mode === "archive") {
    return {
      kind: "archive",
      itemPathSegments: [metadata.itemDirectory],
      storagePathSegments: [metadata.assetKey],
      assetKey: metadata.assetKey,
    };
  }
  const variantSegments = focusedVariantSegments(request);
  return {
    kind: "focused",
    itemPathSegments: [
      FOCUSED_CAPTURE_NAMESPACE,
      metadata.itemDirectory,
      ...variantSegments,
    ],
    storagePathSegments: [
      FOCUSED_CAPTURE_NAMESPACE,
      metadata.assetKey,
      ...variantSegments,
    ],
    assetKey: variantAssetKey(metadata.assetKey, variantSegments),
  };
}

/** Stable parent and lock identity shared by every occurrence of one subject. */
export function revisionLineageIdentity(
  metadata: ProbeMetadata,
  request: CaptureIdentityRequest,
): RevisionLineageIdentity {
  const subject = captureIdentity(metadata, request);
  const variantSegments = request.mode === "archive"
    ? ["archive"]
    : focusedVariantSegments(request);
  return {
    itemParentPathSegments: [
      REVISION_CAPTURE_NAMESPACE,
      metadata.itemDirectory,
      ...variantSegments,
    ],
    storagePathSegments: [
      REVISION_CAPTURE_NAMESPACE,
      metadata.assetKey,
      ...variantSegments,
    ],
    subjectAssetKey: subject.assetKey,
  };
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MediaArchiveError("IO_ERROR", `archive path is not a physical directory: ${path}`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new MediaArchiveError("IO_ERROR", `archive path is not a physical directory: ${path}`);
  }
}

async function ensurePhysicalChildDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MediaArchiveError("IO_ERROR", `archive path is not a physical directory: ${path}`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      if (!isErrno(mkdirError, "EEXIST")) throw mkdirError;
    }
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new MediaArchiveError("IO_ERROR", `archive path is not a physical directory: ${path}`);
    }
  }
}

async function discardStagingItem(path: string): Promise<void> {
  const quarantine = join(dirname(path), `.wrench-media-discard-${randomUUID()}`);
  try {
    await rename(path, quarantine);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  const metadata = await lstat(quarantine);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new MediaArchiveError(
      "IO_ERROR",
      "capture staging is not a discardable physical directory",
      { quarantinedPath: quarantine },
    );
  }
  await rm(quarantine, { recursive: true, force: true });
}

async function resetStagingItem(path: string): Promise<void> {
  await discardStagingItem(path);
  await ensurePhysicalChildDirectory(path);
}

async function adoptCaptureAttempt(source: string, destination: string): Promise<void> {
  try {
    const metadata = await lstat(destination);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MediaArchiveError(
        "IO_ERROR",
        "existing capture staging is not a physical directory",
      );
    }
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  await rename(source, destination);
}

async function ensurePhysicalDirectorySegments(
  base: string,
  segments: readonly string[],
): Promise<string> {
  let current = base;
  for (const segment of segments) {
    if (
      segment !== FOCUSED_CAPTURE_NAMESPACE
      && segment !== REVISION_CAPTURE_NAMESPACE
      && !isPortableIdentityDirectorySegment(segment)
    ) {
      throw new MediaArchiveError("IO_ERROR", "archive identity contains an unsafe path segment");
    }
    current = join(current, segment);
    await ensurePhysicalChildDirectory(current);
  }
  return current;
}

function splitIdentityLeaf(segments: readonly string[]): Readonly<{
  parentSegments: readonly string[];
  leaf: string;
}> {
  const leaf = segments.at(-1);
  if (leaf === undefined) throw new MediaArchiveError("IO_ERROR", "archive identity is empty");
  return { parentSegments: segments.slice(0, -1), leaf };
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
}

async function moveSidecar(source: string, destination: string): Promise<string> {
  await rename(source, destination);
  return destination;
}

async function removeRegularFileIfPresent(path: string, label: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new MediaArchiveError("IO_ERROR", `${label} is not a regular file`);
    }
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function writeProviderMetadata(
  itemRoot: string,
  metadata: ProbeMetadata,
): Promise<string> {
  const metadataDirectory = join(itemRoot, "data", "metadata");
  const path = join(metadataDirectory, "provider.json");
  await writeFile(path, renderProviderMetadataJson(metadata), {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

export async function organizeCaptureFiles(
  itemRoot: string,
  expectedMediaExtension: string,
  persistDescriptiveSidecars = true,
): Promise<OrganizedCapture> {
  if (!isSafeYtDlpCaptureExtension(expectedMediaExtension)) {
    throw new MediaArchiveError(
      "CAPTURE_FAILED",
      "the acquisition adapter returned an unsafe primary media extension",
    );
  }
  const captureDirectory = join(itemRoot, "data", "capture");
  const metadataDirectory = join(itemRoot, "data", "metadata");
  const captionsDirectory = join(itemRoot, "data", "captions");
  const entries = await readdir(captureDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new MediaArchiveError("IO_ERROR", `the acquisition adapter produced an unsupported filesystem entry: ${entry.name}`);
    }
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .toSorted(compareUtf8);
  const rawInfoFiles = files.filter((name) => name.endsWith(".info.json"));
  for (const name of rawInfoFiles) {
    await removeRegularFileIfPresent(
      join(captureDirectory, name),
      "raw yt-dlp provider metadata",
    );
  }
  const expectedMediaName = `media.${expectedMediaExtension}`;
  const mediaFiles = files.filter((name) => name === expectedMediaName);
  const captionFiles = files.filter((name) => name.startsWith("media.") && extension(name) === "vtt");
  const thumbnailFiles = files.filter((name) => name.startsWith("media.") && imageExtensions.has(extension(name)));
  if (mediaFiles.length > 1) throw new MediaArchiveError("ARCHIVE_CONFLICT", "capture staging contains more than one primary media file", { files: mediaFiles });
  if (captionFiles.length > 1) throw new MediaArchiveError("ARCHIVE_CONFLICT", "capture staging contains more than one selected caption file", { files: captionFiles });
  if (thumbnailFiles.length > 1) throw new MediaArchiveError("ARCHIVE_CONFLICT", "capture staging contains more than one thumbnail file", { files: thumbnailFiles });

  const descriptionName = files.find((name) => name === "media.description");
  const captionName = captionFiles[0];
  const thumbnailName = thumbnailFiles[0];
  const descriptionSource = descriptionName === undefined
    ? null
    : join(captureDirectory, descriptionName);
  const thumbnailSource = thumbnailName === undefined
    ? null
    : join(captureDirectory, thumbnailName);
  const claimedFiles = new Set([
    ...rawInfoFiles,
    ...mediaFiles,
    ...captionFiles,
    ...thumbnailFiles,
    ...(descriptionName === undefined ? [] : [descriptionName]),
  ]);
  const unclaimedFiles = files.filter((name) => !claimedFiles.has(name));
  if (unclaimedFiles.length > 0) {
    throw new MediaArchiveError(
      "ARCHIVE_CONFLICT",
      "capture staging contains files that are not owned by Wrench media's acquisition contract",
      { files: unclaimedFiles },
    );
  }
  if (!persistDescriptiveSidecars) {
    if (descriptionSource !== null) {
      await removeRegularFileIfPresent(descriptionSource, "unowned provider description");
    }
    if (thumbnailSource !== null) {
      await removeRegularFileIfPresent(thumbnailSource, "unowned provider thumbnail");
    }
  }
  return {
    mediaPath: mediaFiles[0] === undefined ? null : join(captureDirectory, mediaFiles[0]),
    descriptionPath: descriptionSource === null || !persistDescriptiveSidecars
      ? null
      : await moveSidecar(descriptionSource, join(metadataDirectory, "description.txt")),
    captionPath: captionName === undefined ? null : await moveSidecar(join(captureDirectory, captionName), join(captionsDirectory, "transcript.vtt")),
    thumbnailPath: thumbnailSource === null || thumbnailName === undefined || !persistDescriptiveSidecars
      ? null
      : await moveSidecar(thumbnailSource, join(metadataDirectory, `thumbnail.${extension(thumbnailName)}`)),
  };
}

async function transcriptArtifacts(
  itemRoot: string,
  captionPath: string | null,
  caption: CaptionSelection | null,
  mode: CaptureMode,
): Promise<{ readonly transcript: MediaTranscript; readonly artifacts: readonly MediaArtifact[] }> {
  if (caption === null) {
    return {
      transcript: {
        status: "unavailable",
        reason: mode === "audio" || mode === "video"
          ? "not_requested"
          : "provider_has_no_captions",
      },
      artifacts: [],
    };
  }
  if (captionPath === null) {
    throw new MediaArchiveError(
      "CAPTURE_FAILED",
      "yt-dlp completed without the selected provider transcript",
    );
  }
  const metadata = await lstat(captionPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024 * 1024) {
    throw new MediaArchiveError("DERIVATION_FAILED", "provider transcript is missing, unsafe, or larger than 64 MiB");
  }
  const parsed = parseWebVtt(await readFile(captionPath, "utf8"));
  if (!parsed.ok) throw new MediaArchiveError("DERIVATION_FAILED", parsed.error.message, { transcriptCode: parsed.error.code });
  const captionsDirectory = join(itemRoot, "data", "captions");
  const textPath = join(captionsDirectory, "transcript.txt");
  const cuesPath = join(captionsDirectory, "transcript.json");
  await writeFile(textPath, parsed.text, { encoding: "utf8", mode: 0o600 });
  await writeFile(cuesPath, parsed.json, { encoding: "utf8", mode: 0o600 });
  const timedRelative = relativeArtifactPath(itemRoot, captionPath);
  const textRelative = relativeArtifactPath(itemRoot, textPath);
  const cuesRelative = relativeArtifactPath(itemRoot, cuesPath);
  return {
    transcript: {
      status: "available",
      source: caption.source,
      language: caption.language,
      timedPath: timedRelative,
      textPath: textRelative,
      cuesPath: cuesRelative,
    },
    artifacts: [
      await createMediaArtifact(itemRoot, timedRelative, "transcript_vtt"),
      await createMediaArtifact(itemRoot, textRelative, "transcript_text"),
      await createMediaArtifact(itemRoot, cuesRelative, "transcript_json"),
    ],
  };
}

interface TranscriptArtifactsResult {
  readonly transcript: MediaTranscript;
  readonly artifacts: readonly MediaArtifact[];
}

function unavailableTranscript(
  reason: "not_requested" | "transcriber_not_configured" | "audio_not_present",
): TranscriptArtifactsResult {
  return { transcript: { status: "unavailable", reason }, artifacts: [] };
}

async function persistLocalTranscript(
  itemRoot: string,
  result: Extract<LocalTranscriptionResult, { status: "transcribed" }>,
): Promise<TranscriptArtifactsResult> {
  const captionsDirectory = join(itemRoot, "data", "captions");
  const timedPath = join(captionsDirectory, "transcript.vtt");
  const textPath = join(captionsDirectory, "transcript.txt");
  const cuesPath = join(captionsDirectory, "transcript.json");
  await Promise.all([
    writeFile(timedPath, result.transcript.vtt, { encoding: "utf8", mode: 0o600 }),
    writeFile(textPath, result.transcript.text, { encoding: "utf8", mode: 0o600 }),
    writeFile(cuesPath, result.transcript.json, { encoding: "utf8", mode: 0o600 }),
  ]);
  const timedRelative = relativeArtifactPath(itemRoot, timedPath);
  const textRelative = relativeArtifactPath(itemRoot, textPath);
  const cuesRelative = relativeArtifactPath(itemRoot, cuesPath);
  return {
    transcript: {
      status: "available",
      source: "local",
      language: result.language,
      timedPath: timedRelative,
      textPath: textRelative,
      cuesPath: cuesRelative,
      provenance: result.provenance,
    },
    artifacts: await Promise.all([
      createMediaArtifact(itemRoot, timedRelative, "transcript_vtt"),
      createMediaArtifact(itemRoot, textRelative, "transcript_text"),
      createMediaArtifact(itemRoot, cuesRelative, "transcript_json"),
    ]),
  };
}

function localProvenanceMatchesPlan(
  provenance: MediaLocalTranscriptProvenance,
  plan: Extract<LocalTranscriptionPlan, { kind: "ready" }>,
  audioArtifact: MediaArtifact,
): boolean {
  return provenance.adapter === plan.identity.adapter
    && provenance.profile === plan.identity.profile
    && provenance.executableSha256 === plan.identity.executableSha256
    && provenance.runtimeProfile === plan.identity.runtimeProfile
    && provenance.runtimeSha256 === plan.identity.runtimeSha256
    && provenance.runtimeDependencyCount === plan.identity.runtimeDependencyCount
    && provenance.modelSha256 === plan.identity.modelSha256
    && provenance.requestedLanguage === plan.identity.requestedLanguage
    && provenance.input.path === audioArtifact.path
    && provenance.input.bytes === audioArtifact.bytes
    && provenance.input.sha256 === audioArtifact.sha256
    && provenance.input.normalized.profile === plan.identity.normalizationProfile;
}

async function localTranscriptArtifacts(
  itemRoot: string,
  mode: "archive" | "transcript",
  plan: LocalTranscriptionPlan,
  artifacts: readonly MediaArtifact[],
  ffmpegExecutable: string | null,
  options: MediaArchiveOptions,
  dependencies: MediaArchiveDependencies,
): Promise<TranscriptArtifactsResult> {
  if (plan.kind === "not-configured") {
    if (mode === "transcript") requireFocusedLocalPlan(plan);
    return unavailableTranscript("transcriber_not_configured");
  }
  const audioArtifact = artifacts.find((artifact) => artifact.role === "audio");
  if (audioArtifact === undefined) {
    if (mode === "transcript") {
      throw new MediaArchiveError(
        "TRANSCRIPT_UNAVAILABLE",
        "the captured media does not contain an audio stream to transcribe",
      );
    }
    return unavailableTranscript("audio_not_present");
  }
  if (ffmpegExecutable === null) {
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      "FFmpeg is unavailable for local transcription",
    );
  }

  const reverifiedTranscriber = await reverifyLocalTranscriptionPlan(
    options,
    plan,
    dependencies,
  );

  const attemptDirectory = await mkdtemp(join(itemRoot, ".tmp", "transcription-attempt-"));
  await chmod(attemptDirectory, 0o700);
  let result: LocalTranscriptionResult;
  try {
    result = await dependencies.transcribeAudioLocally({
      audioPath: join(itemRoot, audioArtifact.path),
      audioArtifact,
      attemptDirectory,
      ffmpegExecutable,
      requestedLanguage: plan.requestedLanguage,
      transcriber: reverifiedTranscriber,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    if (isCancelled(options.signal)) {
      throw new MediaArchiveError("CANCELLED", "local transcription was cancelled");
    }
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      "the local transcription adapter failed unexpectedly",
      { stage: "transcriber" },
    );
  } finally {
    await rm(attemptDirectory, { recursive: true, force: true });
  }

  if (result.status === "failed") {
    if (result.stage === "cancelled" || isCancelled(options.signal)) {
      throw new MediaArchiveError("CANCELLED", "local transcription was cancelled");
    }
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      result.diagnostic,
      { stage: result.stage },
    );
  }
  if (!localProvenanceMatchesPlan(result.provenance, plan, audioArtifact)) {
    throw new MediaArchiveError(
      "TRANSCRIPTION_FAILED",
      "local transcription returned provenance that does not match the frozen capture identity",
    );
  }
  if (result.status === "no-speech") {
    if (mode === "transcript") {
      throw new MediaArchiveError(
        "TRANSCRIPT_UNAVAILABLE",
        "local transcription found no speech in the captured audio",
      );
    }
    return {
      transcript: {
        status: "unavailable",
        reason: "no_speech",
        provenance: result.provenance,
      },
      artifacts: [],
    };
  }
  return await persistLocalTranscript(itemRoot, result);
}

function archiveTranscriptWarnings(transcript: MediaManifest["transcript"]): readonly string[] {
  if (transcript.status === "available") return [];
  switch (transcript.reason) {
    case "not_requested":
      return [];
    case "transcriber_not_configured":
      return ["provider has no transcript and no local transcriber is configured; the media archive is complete"];
    case "audio_not_present":
      return ["provider has no transcript and the media has no audio stream; the media archive is complete"];
    case "no_speech":
      return ["provider has no transcript and local transcription found no speech; the media archive is complete"];
    case "provider_has_no_captions":
      return ["provider has no transcript; the media archive is complete"];
  }
}

async function addArtifact(artifacts: MediaArtifact[], itemRoot: string, path: string | null, role: ArtifactRole): Promise<void> {
  if (path !== null) artifacts.push(await createMediaArtifact(itemRoot, relativeArtifactPath(itemRoot, path), role));
}

async function hardenTree(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new MediaArchiveError("IO_ERROR", `archive contains a symbolic link: ${path}`);
  if (metadata.isFile()) {
    await chmod(path, 0o600);
    return;
  }
  if (!metadata.isDirectory()) throw new MediaArchiveError("IO_ERROR", `archive contains an unsupported entry: ${path}`);
  await chmod(path, 0o700);
  const entries = await readdir(path);
  for (const entry of entries) await hardenTree(join(path, entry));
}

function sourceManifest(metadata: ProbeMetadata): MediaManifest["source"] {
  return {
    extractor: metadata.extractor,
    id: metadata.id,
    canonicalUrl: metadata.canonicalUrl,
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.uploader === undefined ? {} : { uploader: metadata.uploader }),
    ...(metadata.channel === undefined ? {} : { channel: metadata.channel }),
    ...(metadata.license === undefined ? {} : { license: metadata.license }),
    ...(metadata.uploadDate === undefined ? {} : { uploadDate: metadata.uploadDate }),
    ...(metadata.timestamp === undefined ? {} : { timestamp: metadata.timestamp }),
    ...(metadata.durationSeconds === undefined ? {} : { durationSeconds: metadata.durationSeconds }),
  };
}

function ytDlpManifestIdentity(metadata: ProbeMetadata): MediaYtDlpIdentity {
  if (metadata.authenticatedYtDlpIdentity !== undefined) {
    return metadata.authenticatedYtDlpIdentity;
  }
  if (metadata.opaqueYtDlpIdentity !== undefined) {
    return metadata.opaqueYtDlpIdentity;
  }
  return {
    profile: WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
    providerIdentitySha256: providerIdentitySha256("Youtube", metadata.id),
  };
}

function manifestAuthenticationMatchesRequest(
  manifest: MediaManifest,
  privateAccess: Readonly<{
    mode: "browser" | "ambient_config";
    contextSha256: string;
  }> | undefined,
): boolean {
  if (privateAccess === undefined) return manifest.authentication.mode === "public";
  return manifest.authentication.mode === privateAccess.mode
    && manifest.authentication.context.profile === AUTH_CONTEXT_IDENTITY_PROFILE
    && manifest.authentication.context.sha256 === privateAccess.contextSha256;
}

type YtDlpArchiveHead = Readonly<{
  itemDirectory: string;
  manifest: MediaYtDlpManifest;
  contentSha256: string;
}>;

function manifestMatchesYtDlpRequest(
  manifest: MediaManifest,
  metadata: ProbeMetadata,
  subjectAssetKey: string,
  mode: CaptureMode,
  caption: CaptionSelection | null,
  privateAccess: Readonly<{
    mode: "browser" | "ambient_config";
    contextSha256: string;
  }> | undefined,
): boolean {
  if (
    !("revision" in manifest)
    || manifest.acquisition.adapter !== "yt-dlp"
    || manifest.revision.subjectAssetKey !== subjectAssetKey
    || manifest.source.extractor !== metadata.extractor
    || manifest.source.id !== metadata.id
    || !manifestAuthenticationMatchesRequest(manifest, privateAccess)
    || !manifestSatisfiesMode(manifest, mode)
  ) return false;
  return mode !== "transcript"
    || caption === null
    || manifest.transcript.status !== "available"
    || (
      manifest.transcript.source === caption.source
      && manifest.transcript.language.toLowerCase() === caption.language.toLowerCase()
    );
}

async function trackedYtDlpHead(
  providerDirectory: string,
  metadata: ProbeMetadata,
  lineage: RevisionLineageIdentity,
  mode: CaptureMode,
  caption: CaptionSelection | null,
  privateAccess: Readonly<{
    mode: "browser" | "ambient_config";
    contextSha256: string;
  }> | undefined,
): Promise<YtDlpArchiveHead | null> {
  const parent = await ensurePhysicalDirectorySegments(
    providerDirectory,
    lineage.itemParentPathSegments,
  );
  const entries: Dirent[] = [];
  const directory = await opendir(parent);
  for await (const entry of directory) {
    if (entries.length >= MAX_TRACKED_REVISION_ITEMS) {
      throw new MediaArchiveError(
        "ARCHIVE_INVALID",
        "the revision history exceeds Wrench media's supported entry limit",
        {
          revisionParent: parent,
          maximumEntries: MAX_TRACKED_REVISION_ITEMS,
        },
      );
    }
    entries.push(entry);
  }
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  if (entries.length === 0) return null;

  const revisions: Array<{
    readonly itemDirectory: string;
    readonly manifest: MediaYtDlpManifest;
  }> = [];
  for (const entry of entries) {
    const leaf = parseRevisionItemLeaf(entry.name);
    if (
      leaf === null
      || !entry.isDirectory()
      || entry.isSymbolicLink()
    ) {
      throw new MediaArchiveError(
        "ARCHIVE_INVALID",
        "the revision history contains an unowned or malformed entry",
        { revisionParent: parent },
      );
    }
    const itemDirectory = join(parent, entry.name);
    const manifest = await readExistingManifest(itemDirectory);
    if (
      !("revision" in manifest)
      || manifest.acquisition.adapter !== "yt-dlp"
      || manifest.revision.sequence !== leaf.sequence
      || manifest.assetKey !== leaf.assetKey
      || !manifestMatchesYtDlpRequest(
        manifest,
        metadata,
        lineage.subjectAssetKey,
        mode,
        caption,
        privateAccess,
      )
    ) {
      throw new MediaArchiveError(
        "ARCHIVE_INVALID",
        "the revision history contains an inconsistent item",
        { itemDirectory },
      );
    }
    revisions.push({ itemDirectory, manifest });
  }

  let previous: MediaYtDlpManifest | null = null;
  for (const [index, revision] of revisions.entries()) {
    const expectedSequence = index + 1;
    const predecessorIsValid = previous === null
      ? revision.manifest.revision.previousAssetKey === undefined
      : revision.manifest.revision.previousAssetKey === previous.assetKey;
    if (
      revision.manifest.revision.sequence !== expectedSequence
      || !predecessorIsValid
    ) {
      throw new MediaArchiveError(
        "ARCHIVE_INVALID",
        "the revision history is gapped, forked, or has a broken predecessor",
        { revisionParent: parent },
      );
    }
    previous = revision.manifest;
  }
  const head = revisions.at(-1);
  if (head === undefined) return null;
  return {
    itemDirectory: head.itemDirectory,
    manifest: head.manifest,
    contentSha256: head.manifest.revision.content.sha256,
  };
}

async function discoverYtDlpHead(
  providerDirectory: string,
  metadata: ProbeMetadata,
  lineage: RevisionLineageIdentity,
  mode: CaptureMode,
  caption: CaptionSelection | null,
  privateAccess: Readonly<{
    mode: "browser" | "ambient_config";
    contextSha256: string;
  }> | undefined,
): Promise<YtDlpArchiveHead | null> {
  return await trackedYtDlpHead(
    providerDirectory,
    metadata,
    lineage,
    mode,
    caption,
    privateAccess,
  );
}

function redactedArchiveDetails(
  details: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    const rendered = redactDiagnostic(JSON.stringify(details), { secrets });
    const parsed: unknown = JSON.parse(rendered);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OwnedAdapterFailure {
  readonly code?: string;
  readonly message: string;
}

function ownedDirectProbeFailure(code: unknown): OwnedAdapterFailure {
  switch (code) {
    case "invalid-request":
      return { code, message: "direct HTTP probe request is invalid" };
    case "redirect-policy":
    case "too-many-redirects":
      return { code, message: "direct HTTP probe rejected the redirect policy" };
    case "timeout":
      return { code, message: "direct HTTP probe timed out" };
    case "aborted":
      return { code, message: "direct HTTP probe was aborted" };
    case "network":
      return { code, message: "direct HTTP probe failed on the network" };
    case "unsupported-content-encoding":
      return { code, message: "direct HTTP probe received an unsupported content encoding" };
    case "invalid-response-length":
      return { code, message: "direct HTTP probe received inconsistent response lengths" };
    case "invalid-content-type":
      return { code, message: "direct HTTP probe received a malformed media type" };
    case "body-too-large":
      return { code, message: "direct HTTP probe exceeded the body limit" };
    case "response-read":
      return { code, message: "direct HTTP probe could not read the response" };
    default:
      return { message: "direct HTTP probe adapter returned an invalid failure" };
  }
}

function ownedDirectCaptureFailure(code: unknown): OwnedAdapterFailure {
  switch (code) {
    case "invalid-request":
      return { code, message: "direct HTTP capture request is invalid" };
    case "aborted":
      return { code, message: "direct HTTP capture was cancelled" };
    case "transport":
      return { code, message: "direct HTTP capture transport failed" };
    case "http-status":
      return { code, message: "direct HTTP capture returned an unsupported status" };
    case "unsupported-content-encoding":
      return { code, message: "direct HTTP capture received an unsupported content encoding" };
    case "invalid-response-length":
      return { code, message: "direct HTTP capture received inconsistent response lengths" };
    case "body-too-large":
      return { code, message: "direct HTTP capture exceeded the body limit" };
    case "invalid-content-type":
      return { code, message: "direct HTTP capture received a malformed media type" };
    case "declared-text":
      return { code, message: "direct HTTP capture received a declared text response" };
    case "response-read":
      return { code, message: "direct HTTP capture could not read the response" };
    case "total-timeout":
      return { code, message: "direct HTTP capture exceeded its total timeout" };
    case "sink":
      return { code, message: "direct HTTP capture could not write its destination" };
    case "media-unrecognized":
      return { code, message: "direct HTTP capture did not contain recognized media" };
    case "media-changed":
      return { code, message: "direct HTTP media changed after its probe" };
    default:
      return { message: "direct HTTP capture adapter returned an invalid failure" };
  }
}

function parseDirectCaptureSuccess(
  value: unknown,
  route: DirectHttpCaptureRoute,
  ownedMedia: DirectHttpMedia,
): DirectHttpCapture | null {
  if (!isRecord(value) || value["ok"] !== true || !isRecord(value["capture"])) return null;
  const capture = value["capture"];
  const provenance = parseMediaDirectHttpProvenance(capture["provenance"]);
  const media = capture["media"];
  const bytes = capture["bytes"];
  const sha256 = capture["sha256"];
  const attempts = capture["attempts"];
  const resumed = capture["resumed"];
  if (
    provenance === null
    || !isRecord(media)
    || media["container"] !== ownedMedia.container
    || media["extension"] !== ownedMedia.extension
    || media["mediaType"] !== ownedMedia.mediaType
    || typeof bytes !== "number"
    || !Number.isSafeInteger(bytes)
    || bytes < 0
    || typeof sha256 !== "string"
    || provenance.requestedUrlSha256 !== route.requestUrlSha256
    || provenance.container !== ownedMedia.container
    || provenance.body.bytes !== bytes
    || provenance.body.sha256 !== sha256
    || typeof attempts !== "number"
    || !Number.isSafeInteger(attempts)
    || attempts < 1
    || attempts > 10
    || typeof resumed !== "boolean"
  ) return null;
  return {
    bytes,
    sha256,
    media: ownedMedia,
    provenance,
    attempts,
    resumed,
  };
}

function isDirectHttpProbeBoundary(value: unknown): value is DirectHttpProbe {
  if (!isRecord(value) || !isRecord(value["media"])) return false;
  const media = value["media"];
  return value["transport"] instanceof DirectHttpProbeTransport
    && typeof value["publicOrigin"] === "string"
    && typeof value["requestedUrlSha256"] === "string"
    && typeof value["effectiveUrlSha256"] === "string"
    && typeof value["redirectCount"] === "number"
    && Number.isSafeInteger(value["redirectCount"])
    && value["redirectCount"] >= 0
    && value["redirectCount"] <= 5
    && (value["declaredMediaType"] === null || typeof value["declaredMediaType"] === "string")
    && (value["lastModified"] === null || typeof value["lastModified"] === "string")
    && (value["expectedBytes"] === null
      || (typeof value["expectedBytes"] === "number"
        && Number.isSafeInteger(value["expectedBytes"])
        && value["expectedBytes"] >= 0))
    && typeof media["container"] === "string"
    && typeof media["extension"] === "string"
    && typeof media["mediaType"] === "string";
}

const DIRECT_SINK_SETTLE_TIMEOUT_MS = 5_000;

async function settleDirectSink(
  sink: DirectHttpCaptureSink,
  action: "abort" | "close",
): Promise<"settled" | "failed" | "timeout"> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let operation: Promise<void>;
    try {
      operation = sink[action](controller.signal);
    } catch {
      return "failed";
    }
    return await Promise.race([
      operation.then(
        () => "settled" as const,
        () => "failed" as const,
      ),
      new Promise<"timeout">((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout("timeout"), DIRECT_SINK_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function createDirectCaptureFileSink(path: string): Promise<DirectHttpCaptureSink> {
  const handle = await open(path, "wx", 0o600);
  const opened = await handle.stat();
  let position = 0;
  let closed = false;

  const closeHandle = async (): Promise<void> => {
    if (closed) return;
    await handle.close();
    closed = true;
  };

  return {
    write: async (chunk) => {
      if (closed) throw new Error("direct capture sink is closed");
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await handle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
          position,
        );
        if (written.bytesWritten <= 0) throw new Error("direct capture sink made no progress");
        offset += written.bytesWritten;
        position += written.bytesWritten;
      }
    },
    restart: async () => {
      if (closed) throw new Error("direct capture sink is closed");
      await handle.truncate(0);
      position = 0;
    },
    close: async () => {
      if (closed) return;
      await handle.sync();
      await closeHandle();
    },
    abort: async () => {
      try {
        await closeHandle();
      } catch {
        // The pathname identity check below still prevents deleting a swap.
      }
      try {
        const current = await lstat(path);
        if (
          current.isFile()
          && !current.isSymbolicLink()
          && current.dev === opened.dev
          && current.ino === opened.ino
        ) {
          await unlink(path);
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    },
  };
}

function directManifestMatches(
  manifest: MediaManifest,
  metadata: ProbeMetadata,
  request: CaptureIdentityRequest,
  probe: DirectHttpProbe,
  captureArtifact: MediaArtifact,
): boolean {
  const recordedCapture = manifest.artifacts.find((artifact) => artifact.role === "capture");
  return manifest.acquisition.adapter === "direct-http"
    && manifest.authentication.mode === "public"
    && manifest.assetKey === captureIdentity(metadata, request).assetKey
    && manifest.source.extractor === metadata.extractor
    && manifest.source.id === metadata.id
    && manifest.source.canonicalUrl === metadata.canonicalUrl
    && manifest.acquisition.provenance.requestedUrlSha256 === probe.requestedUrlSha256
    && manifest.acquisition.provenance.body.bytes === captureArtifact.bytes
    && manifest.acquisition.provenance.body.sha256 === captureArtifact.sha256
    && recordedCapture?.bytes === captureArtifact.bytes
    && recordedCapture.sha256 === captureArtifact.sha256
    && manifestSatisfiesMode(manifest, request.mode);
}

function directProbeMedia(probe: DirectHttpProbe): DirectHttpMedia | null {
  try {
    const owned = directHttpMediaForContainer(probe.media.container);
    return owned !== undefined
      && probe.media.extension === owned.extension
      && probe.media.mediaType === owned.mediaType
      ? owned
      : null;
  } catch {
    return null;
  }
}

async function mediaDirectHttp(
  options: MediaArchiveOptions,
  route: DirectHttpCaptureRoute,
  probe: DirectHttpProbe,
  dependencies: MediaArchiveDependencies,
): Promise<MediaArchiveResult> {
  const probeRequestUrl = probe.transport instanceof DirectHttpProbeTransport
    ? probe.transport.requestUrl()
    : null;
  const ownedMedia = directProbeMedia(probe);
  if (
    probeRequestUrl !== route.requestUrl
    || probe.requestedUrlSha256 !== route.requestUrlSha256
    || probe.publicOrigin !== `${new URL(route.requestUrl).origin}/`
    || ownedMedia === null
  ) {
    throw new MediaArchiveError(
      "PROBE_FAILED",
      "direct HTTP probe returned an inconsistent request identity",
    );
  }
  let localPlan: LocalTranscriptionPlan | null = route.mode === "transcript"
    ? requireFocusedLocalPlan(await loadLocalTranscriptionPlan(options, dependencies))
    : null;
  const requestedRoot = libraryDirectory(options);
  await ensurePhysicalDirectory(requestedRoot);
  const root = await realpath(requestedRoot);
  const stagingRoot = join(root, ".wrench-media-staging");
  const lockRoot = join(root, ".wrench-media-locks");
  await ensurePhysicalChildDirectory(stagingRoot);
  await ensurePhysicalChildDirectory(lockRoot);
  const provisionalSegments = [
    DIRECT_HTTP_CAPTURE_NAMESPACE,
    route.requestUrlSha256,
  ] as const;
  const provisionalIdentity = splitIdentityLeaf(provisionalSegments);
  const stagingParent = await ensurePhysicalDirectorySegments(
    stagingRoot,
    provisionalIdentity.parentSegments,
  );
  const lockParent = await ensurePhysicalDirectorySegments(
    lockRoot,
    provisionalIdentity.parentSegments,
  );
  const stagingItem = join(stagingParent, provisionalIdentity.leaf);
  const lockPath = join(lockParent, `${provisionalIdentity.leaf}.lock`);
  let itemLock: ItemLock;
  try {
    itemLock = await acquireItemLock(lockPath);
  } catch (error) {
    if (error instanceof ItemLockBusyError) {
      throw new MediaArchiveError("BUSY", error.message, { lockPath });
    }
    throw error;
  }

  const sourceDiagnosticSecrets = [
    options.url,
    route.requestUrl,
    ...urlDerivedRedactions(options.url),
    ...urlDerivedRedactions(route.requestUrl),
  ];
  try {
    await resetStagingItem(stagingItem);
    for (const directory of [
      join(stagingItem, "data"),
      join(stagingItem, "data", "capture"),
      join(stagingItem, "data", "derivatives"),
      join(stagingItem, "data", "captions"),
      join(stagingItem, "data", "metadata"),
      join(stagingItem, ".tmp"),
    ]) await ensurePhysicalDirectory(directory);

    const capturePath = join(
      stagingItem,
      "data",
      "capture",
      `media.${ownedMedia.extension}`,
    );
    const sink = await createDirectCaptureFileSink(capturePath);
    let directValue: unknown;
    try {
      directValue = await dependencies.captureDirectHttp(
        probe,
        sink,
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch {
      await settleDirectSink(sink, "abort");
      if (isCancelled(options.signal)) {
        throw new MediaArchiveError("CANCELLED", "direct HTTP capture was cancelled");
      }
      throw new MediaArchiveError(
        "CAPTURE_FAILED",
        "direct HTTP capture adapter failed unexpectedly",
        { stagingDirectory: stagingItem },
      );
    }
    if (isRecord(directValue) && directValue["ok"] === false) {
      await settleDirectSink(sink, "abort");
      const error = isRecord(directValue["error"])
        ? ownedDirectCaptureFailure(directValue["error"]["code"])
        : ownedDirectCaptureFailure(undefined);
      if (error.code === "aborted") {
        throw new MediaArchiveError("CANCELLED", error.message);
      }
      throw new MediaArchiveError(
        "CAPTURE_FAILED",
        error.message,
        {
          ...(error.code === undefined ? {} : { captureCode: error.code }),
          stagingDirectory: stagingItem,
        },
      );
    }
    const direct = parseDirectCaptureSuccess(directValue, route, ownedMedia);
    if (direct === null) {
      await settleDirectSink(sink, "abort");
      throw new MediaArchiveError(
        "CAPTURE_FAILED",
        "direct HTTP capture returned inconsistent provenance",
        { stagingDirectory: stagingItem },
      );
    }
    if (await settleDirectSink(sink, "close") !== "settled") {
      await settleDirectSink(sink, "abort");
      throw new MediaArchiveError(
        "CAPTURE_FAILED",
        "direct HTTP capture could not finalize its destination",
        { stagingDirectory: stagingItem },
      );
    }

    const hashedCaptureArtifact = await createMediaArtifact(
      stagingItem,
      relativeArtifactPath(stagingItem, capturePath),
      "capture",
    );
    const captureArtifact: MediaArtifact = {
      ...hashedCaptureArtifact,
      mediaType: ownedMedia.mediaType,
    };
    if (
      captureArtifact.bytes !== direct.bytes
      || captureArtifact.sha256 !== direct.sha256
    ) {
      await settleDirectSink(sink, "abort");
      throw new MediaArchiveError(
        "CAPTURE_FAILED",
        "direct HTTP capture bytes disagree with the completed file",
        { stagingDirectory: stagingItem },
      );
    }
    const metadata = createDirectHttpMetadata({
      requestedOrigin: probe.publicOrigin,
      requestedUrlSha256: route.requestUrlSha256,
      bodySha256: captureArtifact.sha256,
    });
    const identityRequest: CaptureIdentityRequest = route.mode === "transcript"
      ? {
          mode: "transcript",
          transcript: {
            kind: "local",
            identity: requireFocusedLocalPlan(localPlan ?? { kind: "not-configured" }).identity,
          },
        }
      : { mode: route.mode };
    const identity = captureIdentity(metadata, identityRequest);
    const providerDirectory = join(root, metadata.extractorDirectory);
    await ensurePhysicalChildDirectory(providerDirectory);
    const itemIdentity = splitIdentityLeaf(identity.itemPathSegments);
    const itemParentDirectory = await ensurePhysicalDirectorySegments(
      providerDirectory,
      itemIdentity.parentSegments,
    );
    const itemDirectory = join(itemParentDirectory, itemIdentity.leaf);
    try {
      const existing = await lstat(itemDirectory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new MediaArchiveError(
          "ARCHIVE_CONFLICT",
          "the direct item path already exists but is not a physical directory",
        );
      }
      const manifest = await readExistingManifest(itemDirectory);
      if (!directManifestMatches(manifest, metadata, identityRequest, probe, captureArtifact)) {
        throw new MediaArchiveError(
          "ARCHIVE_CONFLICT",
          "the existing direct item belongs to a different source or capture identity",
          { itemDirectory },
        );
      }
      await discardStagingItem(stagingItem);
      return { status: "existing", itemDirectory, manifest, warnings: [] };
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }

    if (route.mode === "archive") {
      localPlan = await loadLocalTranscriptionPlan(options, dependencies);
    }

    const ffmpegExecutable = await requireExecutable("ffmpeg", options, dependencies);
    const ffprobeExecutable = await requireExecutable("ffprobe", options, dependencies);
    const providerMetadataPath = await writeProviderMetadata(stagingItem, metadata);
    const artifacts: MediaArtifact[] = [captureArtifact];
    await addArtifact(artifacts, stagingItem, providerMetadataPath, "provider_metadata");
    const derivatives = await dependencies.derive({
      capturePath,
      derivativesDirectory: join(stagingItem, "data", "derivatives"),
      roles: route.mode === "transcript"
        ? ["audio"]
        : requestedDerivativeRoles(route.mode),
      ffmpegExecutable,
      ffprobeExecutable,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (isCancelled(options.signal)) {
      throw new MediaArchiveError("CANCELLED", "media derivation was cancelled");
    }
    const failed = [derivatives.video, derivatives.audio]
      .filter((result) => result.status === "failed");
    if (failed.length > 0) {
      throw new MediaArchiveError(
        "DERIVATION_FAILED",
        "FFmpeg could not create every available direct-media derivative",
        {
          failures: failed.map((result) => result.status === "failed"
            ? { role: result.role, stage: result.stage, diagnostic: result.diagnostic }
            : null),
          stagingDirectory: stagingItem,
        },
      );
    }
    if (derivatives.video.status === "created" || derivatives.video.status === "exists") {
      await addArtifact(artifacts, stagingItem, derivatives.video.path, "video");
    }
    if (derivatives.audio.status === "created" || derivatives.audio.status === "exists") {
      await addArtifact(artifacts, stagingItem, derivatives.audio.path, "audio");
    }
    const transcript = route.mode === "archive" || route.mode === "transcript"
      ? await localTranscriptArtifacts(
          stagingItem,
          route.mode,
          localPlan ?? { kind: "not-configured" },
          artifacts,
          ffmpegExecutable,
          options,
          dependencies,
        )
      : unavailableTranscript("not_requested");
    artifacts.push(...transcript.artifacts);
    const [ffmpegVersion, ffprobeVersion] = await Promise.all([
      dependencies.ffmpegVersion(ffmpegExecutable),
      dependencies.ffmpegVersion(ffprobeExecutable),
    ]);
    const manifest: MediaManifest = {
      schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
      wrenchVersion: WRENCH_MEDIA_VERSION,
      assetKey: identity.assetKey,
      capturedAt: dependencies.now().toISOString(),
      mode: route.mode,
      source: sourceManifest(metadata),
      authentication: { mode: "public" },
      acquisition: {
        adapter: "direct-http",
        provenance: direct.provenance,
      },
      tools: { ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion },
      artifacts,
      transcript: transcript.transcript,
    };
    assertManifestSatisfiesMode(manifest, route.mode);
    await rm(join(stagingItem, ".tmp"), { recursive: true, force: true });
    const written = await writeMediaManifest(stagingItem, manifest);
    await hardenTree(stagingItem);
    const stagedVerification = await verifyMediaItem(stagingItem);
    if (!stagedVerification.ok) {
      throw new MediaArchiveError(
        "ARCHIVE_INVALID",
        "the staged direct item failed its closed integrity verification",
        { failures: stagedVerification.failures, stagingDirectory: stagingItem },
      );
    }
    try {
      await itemLock.assertOwned();
    } catch (error) {
      if (error instanceof ItemLockLostError) {
        throw new MediaArchiveError("BUSY", error.message, { lockPath });
      }
      throw error;
    }
    const promotionParentDirectory = await ensurePhysicalDirectorySegments(
      providerDirectory,
      itemIdentity.parentSegments,
    );
    if (promotionParentDirectory !== itemParentDirectory) {
      throw new MediaArchiveError("IO_ERROR", "direct archive promotion parent changed unexpectedly");
    }
    try {
      await lstat(itemDirectory);
      throw new MediaArchiveError(
        "ARCHIVE_CONFLICT",
        "the completed direct item path appeared during capture",
      );
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    await rename(stagingItem, itemDirectory);
    return {
      status: "created",
      itemDirectory,
      manifest: written,
      warnings: route.mode === "archive"
        ? archiveTranscriptWarnings(written.transcript)
        : [],
    };
  } catch (error) {
    try {
      await itemLock.assertOwned();
      await discardStagingItem(stagingItem);
    } catch {
      // Preserve the primary failure. A lost lock means another owner controls
      // this staging identity; a failed discard is retried on the next run.
    }
    if (error instanceof MediaArchiveError) {
      throw new MediaArchiveError(
        error.code,
        redactDiagnostic(error.message, { secrets: sourceDiagnosticSecrets }),
        redactedArchiveDetails(error.details, sourceDiagnosticSecrets),
      );
    }
    throw new MediaArchiveError(
      "IO_ERROR",
      redactDiagnostic(
        error instanceof Error ? error.message : "direct archive pipeline failed",
        { secrets: sourceDiagnosticSecrets },
      ),
      { stagingDirectory: stagingItem },
    );
  } finally {
    try {
      await itemLock.release();
    } catch {
      // A dead owner is reclaimed safely on the next run.
    }
  }
}

async function mediaWithYtDlp(
  options: MediaArchiveOptions,
  dependencies: MediaArchiveDependencies,
): Promise<MediaArchiveResult> {
  const requestedRoot = libraryDirectory(options);
  await ensurePhysicalDirectory(requestedRoot);
  const root = await realpath(requestedRoot);
  const ytDlpExecutable = await requireExecutable("yt-dlp", options, dependencies);
  const privateAccess = options.authContext === undefined
    ? undefined
    : {
        mode: options.browser === undefined ? "ambient_config" as const : "browser" as const,
        contextSha256: authContextSha256(options.authContext),
      };
  let probe: YtDlpProbeResult;
  try {
    probe = await dependencies.probe({
      executable: ytDlpExecutable,
      url: options.url,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(privateAccess === undefined
        ? {}
        : { authContextSha256: privateAccess.contextSha256 }),
      inheritConfig: options.inheritYtDlpConfig,
    });
  } catch {
    if (isCancelled(options.signal)) {
      throw new MediaArchiveError("CANCELLED", "yt-dlp probe was cancelled");
    }
    throw new MediaArchiveError("PROBE_FAILED", "yt-dlp probe adapter failed unexpectedly");
  }
  if (!probe.ok) {
    if ("kind" in probe) {
      throw new MediaArchiveError("UNSUPPORTED_SOURCE", probe.message, {
        reason: probe.reason,
      });
    }
    if ("processReason" in probe && probe.processReason === "aborted") {
      throw new MediaArchiveError("CANCELLED", "yt-dlp probe was cancelled");
    }
    throw new MediaArchiveError("PROBE_FAILED", probe.diagnostic);
  }
  const metadata = probe.metadata;
  const sourceDiagnosticSecrets = [
    options.url,
    ...urlDerivedRedactions(options.url),
    ...(options.browser === undefined ? [] : [options.browser]),
    ...(options.authContext === undefined ? [] : [options.authContext]),
    ...metadata.diagnosticRedactions,
  ];
  const caption = options.mode === "audio" || options.mode === "video"
    ? null
    : selectCaption(metadata, options.language);
  let localPlan: LocalTranscriptionPlan | null = options.mode === "transcript" && caption === null
    ? requireFocusedLocalPlan(await loadLocalTranscriptionPlan(options, dependencies))
    : null;
  const identityRequest: CaptureIdentityRequest = options.mode === "transcript"
    ? caption === null
      ? {
          mode: "transcript",
          transcript: {
            kind: "local",
            identity: requireFocusedLocalPlan(localPlan ?? { kind: "not-configured" }).identity,
          },
        }
      : {
          mode: "transcript",
          transcript: {
            kind: "provider",
            source: caption.source,
            language: caption.language,
          },
        }
    : { mode: options.mode };
  const lineage = revisionLineageIdentity(metadata, identityRequest);
  const providerDirectory = join(root, metadata.extractorDirectory);
  await ensurePhysicalChildDirectory(providerDirectory);
  const initialHead = await discoverYtDlpHead(
    providerDirectory,
    metadata,
    lineage,
    options.mode,
    caption,
    privateAccess,
  );
  if (initialHead !== null && options.refresh !== true) {
    return {
      status: "existing",
      itemDirectory: initialHead.itemDirectory,
      manifest: initialHead.manifest,
      warnings: [],
    };
  }

  if (options.mode === "archive" && caption === null) {
    localPlan = await loadLocalTranscriptionPlan(options, dependencies);
  }

  const requiresMedia = options.mode !== "transcript" || localPlan?.kind === "ready";
  const ffmpegExecutable = requiresMedia ? await requireExecutable("ffmpeg", options, dependencies) : null;
  const ffprobeExecutable = requiresMedia ? await requireExecutable("ffprobe", options, dependencies) : null;
  const stagingRoot = join(root, ".wrench-media-staging");
  const lockRoot = join(root, ".wrench-media-locks");
  await ensurePhysicalChildDirectory(stagingRoot);
  await ensurePhysicalChildDirectory(lockRoot);
  const storageIdentity = splitIdentityLeaf(lineage.storagePathSegments);
  const stagingParentDirectory = await ensurePhysicalDirectorySegments(
    stagingRoot,
    storageIdentity.parentSegments,
  );
  const lockParentDirectory = await ensurePhysicalDirectorySegments(
    lockRoot,
    storageIdentity.parentSegments,
  );
  const stagingItem = join(stagingParentDirectory, storageIdentity.leaf);
  const lockPath = join(lockParentDirectory, `${storageIdentity.leaf}.lock`);
  let itemLock: ItemLock;
  try {
    itemLock = await acquireItemLock(lockPath);
  } catch (error) {
    if (error instanceof ItemLockBusyError) {
      throw new MediaArchiveError("BUSY", error.message, { lockPath });
    }
    throw error;
  }

  try {
    // A cache miss can race a completed promotion. Refresh also re-reads the
    // exact chain head while holding the stable subject lock before capture.
    const currentHead = await discoverYtDlpHead(
      providerDirectory,
      metadata,
      lineage,
      options.mode,
      caption,
      privateAccess,
    );
    if (currentHead !== null && options.refresh !== true) {
      return {
        status: "existing",
        itemDirectory: currentHead.itemDirectory,
        manifest: currentHead.manifest,
        warnings: [],
      };
    }
    // A previous process may have died before its post-download identity was
    // validated. Safe restart deliberately replaces the exact lock-owned leaf
    // rather than resuming bytes whose source provenance is unproven.
    await resetStagingItem(stagingItem);
    for (const directory of [
      join(stagingItem, "data"),
      join(stagingItem, "data", "derivatives"),
      join(stagingItem, "data", "captions"),
      join(stagingItem, "data", "metadata"),
      join(stagingItem, ".tmp"),
    ]) await ensurePhysicalDirectory(directory);

    // yt-dlp writes only into a fresh attempt directory. Its --no-overwrites
    // behavior must never mix an unverified prior process with
    // the identity emitted by this process.
    const captureAttempt = await mkdtemp(join(stagingItem, ".tmp", "capture-attempt-"));
    await chmod(captureAttempt, 0o700);
    const captureAttemptDirectory = join(captureAttempt, "capture");
    const captureAttemptTemporaryDirectory = join(captureAttempt, "temporary");
    await ensurePhysicalChildDirectory(captureAttemptDirectory);
    await ensurePhysicalChildDirectory(captureAttemptTemporaryDirectory);
    let capture: YtDlpCaptureResult;
    try {
      capture = await dependencies.capture({
        executable: ytDlpExecutable,
        url: options.url,
        mode: options.mode === "transcript" && localPlan?.kind === "ready"
          ? "audio"
          : options.mode,
        captureDirectory: captureAttemptDirectory,
        temporaryDirectory: captureAttemptTemporaryDirectory,
        caption,
        persistDescriptiveMetadata: metadata.projection === "youtube",
        privateRedactions: metadata.diagnosticRedactions,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.browser === undefined ? {} : { browser: options.browser }),
        ...(privateAccess === undefined
          ? {}
          : { authContextSha256: privateAccess.contextSha256 }),
        inheritConfig: options.inheritYtDlpConfig,
      });
    } catch (error) {
      await rm(captureAttempt, { recursive: true, force: true });
      if (isCancelled(options.signal)) {
        throw new MediaArchiveError("CANCELLED", "yt-dlp capture was cancelled");
      }
      throw error;
    }
    if (!capture.ok) {
      await rm(captureAttempt, { recursive: true, force: true });
      if ("processReason" in capture && capture.processReason === "aborted") {
        throw new MediaArchiveError("CANCELLED", "yt-dlp capture was cancelled");
      }
      throw new MediaArchiveError("CAPTURE_FAILED", capture.diagnostic, { stagingDirectory: stagingItem });
    }
    if (
      capture.identity.extractor !== metadata.acquisitionIdentity.extractor
      || capture.identity.id !== metadata.acquisitionIdentity.id
    ) {
      // yt-dlp uses --no-overwrites. Keeping bytes written by
      // source B under source A's staging identity could therefore let a later
      // A/A run bless and promote B. This exact lock-owned leaf is discarded.
      await discardStagingItem(stagingItem);
      throw new MediaArchiveError(
        "CAPTURE_FAILED",
        "the completed download belongs to a different provider source than the probe",
        { stagingDirectory: stagingItem },
      );
    }
    await adoptCaptureAttempt(
      captureAttemptDirectory,
      join(stagingItem, "data", "capture"),
    );
    await rm(captureAttempt, { recursive: true, force: true });
    const organized = await organizeCaptureFiles(
      stagingItem,
      capture.identity.ext,
      metadata.projection === "youtube",
    );
    if (requiresMedia && organized.mediaPath === null) throw new MediaArchiveError("CAPTURE_FAILED", "yt-dlp completed without a primary media file", { stagingDirectory: stagingItem });
    const providerMetadataPath = await writeProviderMetadata(stagingItem, metadata);

    const artifacts: MediaArtifact[] = [];
    await addArtifact(artifacts, stagingItem, organized.mediaPath, "capture");
    await addArtifact(artifacts, stagingItem, providerMetadataPath, "provider_metadata");
    await addArtifact(artifacts, stagingItem, organized.descriptionPath, "description");
    await addArtifact(artifacts, stagingItem, organized.thumbnailPath, "thumbnail");

    if (organized.mediaPath !== null && ffmpegExecutable !== null && ffprobeExecutable !== null) {
      const derivatives = await dependencies.derive({
        capturePath: organized.mediaPath,
        derivativesDirectory: join(stagingItem, "data", "derivatives"),
        roles: options.mode === "transcript" && localPlan?.kind === "ready"
          ? ["audio"]
          : requestedDerivativeRoles(options.mode),
        ffmpegExecutable,
        ffprobeExecutable,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (isCancelled(options.signal)) {
        throw new MediaArchiveError("CANCELLED", "media derivation was cancelled");
      }
      const failed = [derivatives.video, derivatives.audio].filter((result) => result.status === "failed");
      if (failed.length > 0) {
        throw new MediaArchiveError("DERIVATION_FAILED", "FFmpeg could not create every available stream-copy derivative", {
          failures: failed.map((result) => result.status === "failed" ? { role: result.role, stage: result.stage, diagnostic: result.diagnostic } : null),
          stagingDirectory: stagingItem,
        });
      }
      if (derivatives.video.status === "created" || derivatives.video.status === "exists") await addArtifact(artifacts, stagingItem, derivatives.video.path, "video");
      if (derivatives.audio.status === "created" || derivatives.audio.status === "exists") await addArtifact(artifacts, stagingItem, derivatives.audio.path, "audio");
    }

    const transcript = caption !== null
      ? await transcriptArtifacts(
          stagingItem,
          organized.captionPath,
          caption,
          options.mode,
        )
      : options.mode === "archive" || options.mode === "transcript"
        ? await localTranscriptArtifacts(
            stagingItem,
            options.mode,
            localPlan ?? { kind: "not-configured" },
            artifacts,
            ffmpegExecutable,
            options,
            dependencies,
          )
        : unavailableTranscript("not_requested");
    artifacts.push(...transcript.artifacts);
    const contentSha256 = revisionContentSha256(artifacts);
    if (currentHead !== null && currentHead.contentSha256 === contentSha256) {
      await discardStagingItem(stagingItem);
      return {
        status: "existing",
        itemDirectory: currentHead.itemDirectory,
        manifest: currentHead.manifest,
        warnings: [],
      };
    }
    const revisionSequence = currentHead === null
      ? 1
      : currentHead.manifest.revision.sequence + 1;
    if (
      revisionSequence > MAX_REVISION_SEQUENCE
      || revisionSequence > MAX_TRACKED_REVISION_ITEMS
    ) {
      throw new MediaArchiveError(
        "ARCHIVE_CONFLICT",
        "the revision history has exhausted Wrench media's supported lineage capacity",
        { maximumEntries: MAX_TRACKED_REVISION_ITEMS },
      );
    }
    const revision: MediaTrackedRevision = {
      profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
      sequence: revisionSequence,
      subjectAssetKey: lineage.subjectAssetKey,
      ...(currentHead === null
        ? {}
        : { previousAssetKey: currentHead.manifest.assetKey }),
      content: {
        profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
        sha256: contentSha256,
      },
    };
    const revisionAssetKey = trackedRevisionAssetKey(revision);
    const revisionLeaf = revisionItemLeaf(revisionSequence, revisionAssetKey);
    const ytVersion = await dependencies.ytDlpVersion(ytDlpExecutable);
    const ffmpegVersion = ffmpegExecutable === null ? undefined : await dependencies.ffmpegVersion(ffmpegExecutable);
    const ffprobeVersion = ffprobeExecutable === null ? undefined : await dependencies.ffmpegVersion(ffprobeExecutable);
    const manifest: MediaManifest = {
      schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
      wrenchVersion: WRENCH_MEDIA_VERSION,
      assetKey: revisionAssetKey,
      capturedAt: dependencies.now().toISOString(),
      mode: options.mode,
      source: sourceManifest(metadata),
      authentication: privateAccess === undefined
        ? { mode: "public" }
        : {
            mode: privateAccess.mode,
            context: {
              profile: AUTH_CONTEXT_IDENTITY_PROFILE,
              sha256: privateAccess.contextSha256,
            },
          },
      acquisition: {
        adapter: "yt-dlp",
        version: ytVersion,
        identity: ytDlpManifestIdentity(metadata),
      },
      revision,
      tools: {
        ...(ffmpegVersion === undefined ? {} : { ffmpeg: ffmpegVersion }),
        ...(ffprobeVersion === undefined ? {} : { ffprobe: ffprobeVersion }),
      },
      artifacts,
      transcript: transcript.transcript,
    };
    assertManifestSatisfiesMode(manifest, options.mode);
    await rm(join(stagingItem, ".tmp"), { recursive: true, force: true });
    const written = await writeMediaManifest(stagingItem, manifest);
    await hardenTree(stagingItem);
    const stagedVerification = await verifyMediaItem(stagingItem);
    if (!stagedVerification.ok) {
      throw new MediaArchiveError(
        "ARCHIVE_INVALID",
        "the staged item failed its closed integrity verification",
        { failures: stagedVerification.failures, stagingDirectory: stagingItem },
      );
    }
    try {
      await itemLock.assertOwned();
    } catch (error) {
      if (error instanceof ItemLockLostError) {
        throw new MediaArchiveError("BUSY", error.message, { lockPath });
      }
      throw error;
    }
    await ensurePhysicalChildDirectory(providerDirectory);
    const promotionParentDirectory = await ensurePhysicalDirectorySegments(
      providerDirectory,
      lineage.itemParentPathSegments,
    );
    const itemDirectory = join(promotionParentDirectory, revisionLeaf);
    try { await lstat(itemDirectory); throw new MediaArchiveError("ARCHIVE_CONFLICT", "the completed item path appeared during capture"); } catch (error) { if (!isErrno(error, "ENOENT")) throw error; }
    await rename(stagingItem, itemDirectory);
    return {
      status: "created",
      itemDirectory,
      manifest: written,
      warnings: options.mode === "archive"
        ? archiveTranscriptWarnings(written.transcript)
        : [],
    };
  } catch (error) {
    if (error instanceof MediaArchiveError && error.code === "CANCELLED") {
      try {
        await itemLock.assertOwned();
        await discardStagingItem(stagingItem);
      } catch {
        // Preserve cancellation. A lost lock means another owner controls the
        // staging identity; a failed discard is retried on the next run.
      }
    }
    if (error instanceof MediaArchiveError) {
      throw new MediaArchiveError(
        error.code,
        redactDiagnostic(error.message, { secrets: sourceDiagnosticSecrets }),
        redactedArchiveDetails(error.details, sourceDiagnosticSecrets),
      );
    }
    throw new MediaArchiveError(
      "IO_ERROR",
      redactDiagnostic(
        error instanceof Error ? error.message : "archive pipeline failed",
        { secrets: sourceDiagnosticSecrets },
      ),
      { stagingDirectory: stagingItem },
    );
  } finally {
    try { await itemLock.release(); } catch { /* A dead owner is reclaimed safely on the next run. */ }
  }
}

/** Selects the acquisition boundary before entering an adapter-owned pipeline. */
export async function mediaUrl(
  options: MediaArchiveOptions,
  dependencies: MediaArchiveDependencies = defaultDependencies,
): Promise<MediaArchiveResult> {
  if (isCancelled(options.signal)) {
    throw new MediaArchiveError("CANCELLED", "capture was cancelled before it started");
  }
  const route = routeSource(options);
  if (route.kind === "reject") {
    throw new MediaArchiveError(
      "PROBE_FAILED",
      `source URL was rejected by the acquisition router: ${route.reason}`,
    );
  }
  const routedOptions = route.kind === "yt-dlp"
    ? { ...options, url: route.requestUrl, authContext: route.authContext }
    : { ...options, url: route.requestUrl };
  if (route.kind === "yt-dlp") {
    return await mediaWithYtDlp(routedOptions, dependencies);
  }
  let directProbeValue: unknown;
  try {
    directProbeValue = await dependencies.probeDirectHttp(
      route.requestUrl,
      options.signal === undefined ? {} : { signal: options.signal },
    );
  } catch {
    if (isCancelled(options.signal)) {
      throw new MediaArchiveError("CANCELLED", "direct HTTP probe was cancelled");
    }
    throw new MediaArchiveError(
      "PROBE_FAILED",
      "direct HTTP probe adapter failed unexpectedly",
    );
  }
  if (!isRecord(directProbeValue) || typeof directProbeValue["ok"] !== "boolean") {
    throw new MediaArchiveError("PROBE_FAILED", "direct HTTP probe adapter returned an invalid result");
  }
  if (directProbeValue["ok"] === false) {
    if (
      directProbeValue["kind"] === "not-applicable"
      && (
        directProbeValue["reason"] === "http-status"
        || directProbeValue["reason"] === "empty-response"
        || directProbeValue["reason"] === "declared-text"
        || directProbeValue["reason"] === "unrecognized-media"
      )
    ) {
      return await mediaWithYtDlp(routedOptions, dependencies);
    }
    const failure = directProbeValue["kind"] === "error" && isRecord(directProbeValue["error"])
      ? ownedDirectProbeFailure(directProbeValue["error"]["code"])
      : ownedDirectProbeFailure(undefined);
    if (failure.code === "aborted") {
      throw new MediaArchiveError("CANCELLED", "direct HTTP probe was cancelled");
    }
    throw new MediaArchiveError("PROBE_FAILED", failure.message, {
      ...(failure.code === undefined ? {} : { probeCode: failure.code }),
    });
  }
  if (!isDirectHttpProbeBoundary(directProbeValue["probe"])) {
    throw new MediaArchiveError("PROBE_FAILED", "direct HTTP probe adapter returned an invalid success");
  }
  const directProbe = directProbeValue["probe"];
  if (route.intent === "transcript-probe-only") {
    return await mediaDirectHttp(routedOptions, route, directProbe, dependencies);
  }
  const resolution = resolveDirectMediaProbe(route, { kind: "applicable" });
  if (resolution.kind !== "direct-http-capture") {
    return await mediaWithYtDlp(routedOptions, dependencies);
  }
  return await mediaDirectHttp(routedOptions, route, directProbe, dependencies);
}
