import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CaptureMode } from "./args";
import { directHttpMediaForContainer } from "./http";
import {
  AUTH_CONTEXT_IDENTITY_PROFILE,
  authenticatedYtDlpSourceAssetKey,
  authenticatedYtDlpSourceId,
  createDirectHttpMetadata,
  identityDirectorySegment,
  opaqueYtDlpSourceAssetKey,
  opaqueYtDlpSourceId,
  providerIdentitySha256,
  sourceAssetKey,
  variantAssetKey,
  YT_DLP_AUTH_IDENTITY_PROFILE,
  YT_DLP_OPAQUE_IDENTITY_PROFILE,
  type AuthenticatedYtDlpIdentity,
  type OpaqueYtDlpIdentity,
} from "./metadata";
import {
  isConcreteWhisperCppLanguage,
  normalizeWhisperCppLanguage,
  whisperCppLanguageArgument,
} from "./whisper-language";
import {
  MAX_RUNTIME_DEPENDENCIES,
  RUNTIME_CLOSURE_PROFILE,
} from "./runtime-closure";
import {
  WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
  WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
  revisionContentSha256,
  trackedRevisionAssetKey,
  type MediaTrackedRevision,
} from "./revision";
import { compareUtf8 } from "./utf8-order";

export const WRENCH_MEDIA_SCHEMA_VERSION = 1 as const;
export const WRENCH_MEDIA_VERSION = "0.13.6" as const;
export const WRENCH_MEDIA_MANIFEST_FILE = "wrench-media.json" as const;
export const WRENCH_MEDIA_CHECKSUM_FILE = "manifest-sha256.txt" as const;
const MAX_ITEM_ENTRIES = 4_096;
const MAX_ITEM_DEPTH = 32;
const MAX_DIRECT_HTTP_BODY_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_DIRECT_HTTP_REDIRECTS = 5;
const OWNED_CONTROL_TEMP_PATTERN = /^(?:wrench-media\.json|manifest-sha256\.txt)\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const NORMALIZED_MEDIA_TYPE_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]{1,127}\/[a-z0-9!#$%&'*+.^_`|~-]{1,127}$/u;
const OWNED_YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const LOCAL_TRANSCRIBER_IDENTITY_DOMAIN = "wrench-media-local-transcriber-identity-v1\0";
const LOCAL_TRANSCRIBER_IDENTITY_VERSION = 1 as const;
const MAX_NORMALIZED_PCM_BYTES = (4 * 1024 * 1024 * 1024) - 1;

export const WRENCH_MEDIA_WHISPER_CPP_PROFILE = "wrench-media-whisper-cpp-v1" as const;
export const WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE = RUNTIME_CLOSURE_PROFILE;
export const WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE = "pcm-s16le-16000hz-mono-v1" as const;
export const WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE = "yt-dlp-owned-youtube-v1" as const;

export type ArtifactRole =
  | "capture"
  | "video"
  | "audio"
  | "transcript_vtt"
  | "transcript_text"
  | "transcript_json"
  | "provider_metadata"
  | "description"
  | "thumbnail";

export interface MediaArtifact {
  readonly role: ArtifactRole;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mediaType: string;
}

export interface MediaArtifactDependencies {
  /** Test and platform seam between path inspection and the no-follow open. */
  readonly beforeOpen?: (path: string) => Promise<void>;
}

export interface MediaControlFileDependencies {
  /** Test seam immediately before a no-follow control-file open. */
  readonly beforeOpen?: (path: string) => Promise<void>;
  /** Test seam after bytes are read but before fd/path stability is rechecked. */
  readonly afterRead?: (path: string) => Promise<void>;
}

export interface MediaLocalTranscriptProvenance {
  readonly adapter: "whisper-cpp";
  readonly profile: typeof WRENCH_MEDIA_WHISPER_CPP_PROFILE;
  readonly executableSha256: string;
  readonly runtimeProfile: typeof WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE;
  readonly runtimeSha256: string;
  readonly runtimeDependencyCount: number;
  readonly modelSha256: string;
  readonly requestedLanguage: string;
  readonly input: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly normalized: {
      readonly profile: typeof WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE;
      readonly bytes: number;
      readonly sha256: string;
    };
  };
}

export type MediaTranscript =
  | {
      readonly status: "available";
      readonly source: "manual" | "automatic";
      readonly language: string;
      readonly timedPath: string;
      readonly textPath: string;
      readonly cuesPath: string;
    }
  | {
      readonly status: "available";
      readonly source: "local";
      readonly language: string;
      readonly timedPath: string;
      readonly textPath: string;
      readonly cuesPath: string;
      readonly provenance: MediaLocalTranscriptProvenance;
    }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "provider_has_no_captions"
        | "not_requested"
        | "transcriber_not_configured"
        | "audio_not_present";
    }
  | {
      readonly status: "unavailable";
      readonly reason: "no_speech";
      readonly provenance: MediaLocalTranscriptProvenance;
    };

/** Public, path-free inputs that define one immutable local-transcriber variant. */
export interface MediaLocalTranscriptIdentity {
  readonly adapter: "whisper-cpp";
  readonly profile: typeof WRENCH_MEDIA_WHISPER_CPP_PROFILE;
  readonly executableSha256: string;
  readonly runtimeProfile: typeof WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE;
  readonly runtimeSha256: string;
  readonly runtimeDependencyCount: number;
  readonly modelSha256: string;
  readonly normalizationProfile: typeof WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE;
  readonly requestedLanguage: string;
}

function isNormalizedTranscriptionLanguage(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && normalizeWhisperCppLanguage(value) === value;
}

function localTranscriptLanguagesMatch(requested: string, actual: string): boolean {
  if (requested === "auto") return true;
  const requestedToolLanguage = whisperCppLanguageArgument(requested);
  const actualToolLanguage = whisperCppLanguageArgument(actual);
  return requestedToolLanguage !== null
    && requestedToolLanguage !== "auto"
    && requestedToolLanguage === actualToolLanguage;
}

function boundedTranscriptLanguageSegment(value: string): string {
  const lower = value.toLowerCase();
  const candidate = identityDirectorySegment(lower, "language");
  return candidate.length <= 64
    ? candidate
    : identityDirectorySegment(`/${lower}`, "language");
}

function localTranscriptIdentityDigest(identity: MediaLocalTranscriptIdentity): string {
  if (
    identity.adapter !== "whisper-cpp"
    || identity.profile !== WRENCH_MEDIA_WHISPER_CPP_PROFILE
    || identity.runtimeProfile !== WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE
    || identity.normalizationProfile !== WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE
    || !SHA256_PATTERN.test(identity.executableSha256)
    || !SHA256_PATTERN.test(identity.runtimeSha256)
    || !Number.isSafeInteger(identity.runtimeDependencyCount)
    || identity.runtimeDependencyCount < 0
    || identity.runtimeDependencyCount > MAX_RUNTIME_DEPENDENCIES
    || !SHA256_PATTERN.test(identity.modelSha256)
    || !isNormalizedTranscriptionLanguage(identity.requestedLanguage)
  ) {
    throw new TypeError("local transcript identity is malformed");
  }
  const hash = createHash("sha256");
  hash.update(LOCAL_TRANSCRIBER_IDENTITY_DOMAIN, "utf8");
  for (const component of [
    identity.adapter,
    identity.profile,
    identity.executableSha256,
    identity.runtimeProfile,
    identity.runtimeSha256,
    String(identity.runtimeDependencyCount),
    identity.modelSha256,
    identity.normalizationProfile,
    identity.requestedLanguage.toLowerCase(),
  ]) {
    const bytes = new TextEncoder().encode(component);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.byteLength), false);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Canonical path and asset-key identity for one focused local transcript. */
export function localTranscriptVariantSegments(
  identity: MediaLocalTranscriptIdentity,
): readonly ["transcript", "local", string, string] {
  return [
    "transcript",
    "local",
    boundedTranscriptLanguageSegment(identity.requestedLanguage),
    `transcriber-v${String(LOCAL_TRANSCRIBER_IDENTITY_VERSION)}-${localTranscriptIdentityDigest(identity)}`,
  ];
}

export function localTranscriptVariantAssetKey(
  sourceAssetKey: string,
  identity: MediaLocalTranscriptIdentity,
): string {
  return variantAssetKey(sourceAssetKey, localTranscriptVariantSegments(identity));
}

export type MediaAuthentication =
  | { readonly mode: "public" }
  | {
      readonly mode: "browser" | "ambient_config";
      readonly context: {
        readonly profile: typeof AUTH_CONTEXT_IDENTITY_PROFILE;
        readonly sha256: string;
      };
    };

export interface MediaManifestSource {
  readonly extractor: string;
  readonly id: string;
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly uploader?: string;
  readonly channel?: string;
  readonly license?: string;
  readonly uploadDate?: string;
  readonly timestamp?: number;
  readonly durationSeconds?: number;
}

export interface MediaManifestTools {
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
}

export type MediaDirectHttpContainer =
  | "iso-bmff"
  | "matroska"
  | "webm"
  | "ogg"
  | "flac"
  | "wave"
  | "mp3"
  | "mpeg-ts";

export type MediaDirectHttpValidator =
  | { readonly strength: "absent" }
  | { readonly strength: "weak" | "strong"; readonly sha256: string };

export interface MediaDirectHttpProvenance {
  readonly requestedUrlSha256: string;
  readonly effectiveUrlSha256: string;
  readonly validator: MediaDirectHttpValidator;
  readonly lastModified: string | null;
  readonly declaredMediaType: string | null;
  readonly container: MediaDirectHttpContainer;
  readonly body: {
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly redirectCount: number;
}

export interface MediaYtDlpYouTubeIdentity {
  readonly profile: typeof WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE;
  readonly providerIdentitySha256: string;
}

/** Public, path-free inputs that reproduce one current yt-dlp source key. */
export type MediaYtDlpIdentity =
  | MediaYtDlpYouTubeIdentity
  | OpaqueYtDlpIdentity
  | AuthenticatedYtDlpIdentity;

export interface MediaYtDlpAcquisition {
  readonly adapter: "yt-dlp";
  readonly version: string;
  readonly identity: MediaYtDlpIdentity;
}

export interface MediaDirectHttpAcquisition {
  readonly adapter: "direct-http";
  readonly provenance: MediaDirectHttpProvenance;
}

interface MediaManifestBase {
  readonly schemaVersion: typeof WRENCH_MEDIA_SCHEMA_VERSION;
  readonly wrenchVersion: string;
  readonly assetKey: string;
  readonly capturedAt: string;
  readonly mode: CaptureMode;
  readonly source: MediaManifestSource;
  readonly authentication: MediaAuthentication;
  readonly tools: MediaManifestTools;
  readonly artifacts: readonly MediaArtifact[];
  readonly transcript: MediaTranscript;
}

export type MediaYtDlpManifest = MediaManifestBase & {
  readonly acquisition: MediaYtDlpAcquisition;
  readonly revision: MediaTrackedRevision;
};

export type MediaDirectHttpManifest = MediaManifestBase & {
  readonly authentication: { readonly mode: "public" };
  readonly acquisition: MediaDirectHttpAcquisition;
};

export type MediaManifest = MediaYtDlpManifest | MediaDirectHttpManifest;

export type ParseManifestResult =
  | { readonly ok: true; readonly manifest: MediaManifest }
  | { readonly ok: false; readonly message: string };

export interface VerifyItemResult {
  readonly ok: boolean;
  readonly itemDirectory: string;
  readonly assetKey?: string;
  readonly checkedArtifacts: number;
  readonly failures: readonly string[];
}

const artifactRoles = new Set<ArtifactRole>([
  "capture",
  "video",
  "audio",
  "transcript_vtt",
  "transcript_text",
  "transcript_json",
  "provider_metadata",
  "description",
  "thumbnail",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
}

function stringValue(record: Readonly<Record<string, unknown>>, key: string, maximum: number): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0")
    ? value
    : undefined;
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || isAbsolute(value) || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\0"));
}

function parseArtifact(value: unknown): MediaArtifact | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(value, ["role", "path", "bytes", "sha256", "mediaType"])) return null;
  const role = value["role"];
  const path = value["path"];
  const bytes = value["bytes"];
  const sha256 = value["sha256"];
  const mediaType = value["mediaType"];
  if (
    typeof role !== "string" || !artifactRoles.has(role as ArtifactRole) ||
    !safeRelativePath(path) ||
    typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 ||
    typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256) ||
    typeof mediaType !== "string" || mediaType.length === 0 || mediaType.length > 256
  ) return null;
  return { role: role as ArtifactRole, path, bytes, sha256, mediaType };
}

interface ParsedLocalTranscriptInput {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly normalized: {
    readonly profile: typeof WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE;
    readonly bytes: number;
    readonly sha256: string;
  };
}

function parseLocalTranscriptInput(value: unknown): ParsedLocalTranscriptInput | null {
  const input = value;
  if (!isRecord(input) || !hasExactKeys(input, [
    "path",
    "bytes",
    "sha256",
    "normalized",
  ])) return null;
  const normalized = input["normalized"];
  if (!isRecord(normalized) || !hasExactKeys(normalized, [
    "profile",
    "bytes",
    "sha256",
  ])) return null;
  const inputBytes = input["bytes"];
  const normalizedBytes = normalized["bytes"];
  const inputPath = input["path"];
  const inputSha256 = parseSha256(input["sha256"]);
  const normalizedSha256 = parseSha256(normalized["sha256"]);
  if (
    !safeRelativePath(inputPath)
    || typeof inputBytes !== "number"
    || !Number.isSafeInteger(inputBytes)
    || inputBytes <= 0
    || inputSha256 === null
    || normalized["profile"] !== WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE
    || typeof normalizedBytes !== "number"
    || !Number.isSafeInteger(normalizedBytes)
    || normalizedBytes <= 0
    || normalizedBytes > MAX_NORMALIZED_PCM_BYTES
    || normalizedSha256 === null
  ) return null;
  return {
    path: inputPath,
    bytes: inputBytes,
    sha256: inputSha256,
    normalized: {
      profile: WRENCH_MEDIA_PCM_NORMALIZATION_PROFILE,
      bytes: normalizedBytes,
      sha256: normalizedSha256,
    },
  };
}

function parseLocalTranscriptProvenance(
  value: unknown,
): MediaLocalTranscriptProvenance | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "adapter",
    "profile",
    "executableSha256",
    "runtimeProfile",
    "runtimeSha256",
    "runtimeDependencyCount",
    "modelSha256",
    "requestedLanguage",
    "input",
  ])) return null;
  const executableSha256 = parseSha256(value["executableSha256"]);
  const runtimeSha256 = parseSha256(value["runtimeSha256"]);
  const runtimeDependencyCount = value["runtimeDependencyCount"];
  const modelSha256 = parseSha256(value["modelSha256"]);
  const requestedLanguage = value["requestedLanguage"];
  const input = parseLocalTranscriptInput(value["input"]);
  if (
    value["adapter"] !== "whisper-cpp"
    || value["profile"] !== WRENCH_MEDIA_WHISPER_CPP_PROFILE
    || executableSha256 === null
    || value["runtimeProfile"] !== WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE
    || runtimeSha256 === null
    || typeof runtimeDependencyCount !== "number"
    || !Number.isSafeInteger(runtimeDependencyCount)
    || runtimeDependencyCount < 0
    || runtimeDependencyCount > MAX_RUNTIME_DEPENDENCIES
    || modelSha256 === null
    || !isNormalizedTranscriptionLanguage(requestedLanguage)
    || input === null
  ) return null;
  return {
    adapter: "whisper-cpp",
    profile: WRENCH_MEDIA_WHISPER_CPP_PROFILE,
    executableSha256,
    runtimeProfile: WRENCH_MEDIA_RUNTIME_CLOSURE_PROFILE,
    runtimeSha256,
    runtimeDependencyCount,
    modelSha256,
    requestedLanguage,
    input,
  };
}

function parseTranscript(value: unknown): MediaTranscript | null {
  if (!isRecord(value)) return null;
  if (value["status"] === "unavailable") {
    const reason = value["reason"];
    if (reason === "no_speech") {
      if (!hasExactKeys(value, ["status", "reason", "provenance"])) return null;
      const provenance = parseLocalTranscriptProvenance(value["provenance"]);
      return provenance === null
        ? null
        : { status: "unavailable", reason, provenance };
    }
    if (!hasExactKeys(value, ["status", "reason"])) return null;
    return reason === "provider_has_no_captions"
      || reason === "not_requested"
      || reason === "transcriber_not_configured"
      || reason === "audio_not_present"
      ? { status: "unavailable", reason }
      : null;
  }
  if (value["status"] !== "available") return null;
  const source = value["source"];
  const local = source === "local";
  if (!hasExactKeys(
    value,
    [
      "status",
      "source",
      "language",
      "timedPath",
      "textPath",
      "cuesPath",
      ...(local ? ["provenance"] : []),
    ],
  )) return null;
  const language = value["language"];
  const timedPath = value["timedPath"];
  const textPath = value["textPath"];
  const cuesPath = value["cuesPath"];
  if (
    (source !== "manual" && source !== "automatic" && source !== "local")
    || typeof language !== "string"
    || language.length === 0
    || language.length > 128
    || !safeRelativePath(timedPath)
    || !safeRelativePath(textPath)
    || !safeRelativePath(cuesPath)
    || (local && !isConcreteWhisperCppLanguage(language))
  ) return null;
  if (!local) {
    return { status: "available", source, language, timedPath, textPath, cuesPath };
  }
  const provenance = parseLocalTranscriptProvenance(value["provenance"]);
  return provenance === null || !localTranscriptLanguagesMatch(provenance.requestedLanguage, language)
    ? null
    : {
        status: "available",
        source,
        language,
        timedPath,
        textPath,
        cuesPath,
        provenance,
      };
}

function parseSource(value: unknown): MediaManifestSource | null {
  if (!isRecord(value)) return null;
  if (!hasExactKeys(
    value,
    ["extractor", "id", "canonicalUrl"],
    ["title", "uploader", "channel", "license", "uploadDate", "timestamp", "durationSeconds"],
  )) return null;
  const extractor = stringValue(value, "extractor", 512);
  const id = stringValue(value, "id", 512);
  const canonicalUrl = stringValue(value, "canonicalUrl", 8_192);
  if (extractor === undefined || id === undefined || canonicalUrl === undefined) return null;
  try {
    const parsed = new URL(canonicalUrl);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "") return null;
  } catch {
    return null;
  }
  const optionalString = (key: string, maximum: number): string | undefined => stringValue(value, key, maximum);
  const optionalNumber = (key: string): number | undefined => {
    const candidate = value[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
  };
  const title = optionalString("title", 2_048);
  const uploader = optionalString("uploader", 1_024);
  const channel = optionalString("channel", 1_024);
  const license = optionalString("license", 1_024);
  const uploadDate = optionalString("uploadDate", 32);
  const timestamp = optionalNumber("timestamp");
  const durationSeconds = optionalNumber("durationSeconds");
  const optionalStrings = { title, uploader, channel, license, uploadDate } as const;
  for (const [key, parsed] of Object.entries(optionalStrings)) {
    if (Object.hasOwn(value, key) && parsed === undefined) return null;
  }
  if (Object.hasOwn(value, "timestamp") && timestamp === undefined) return null;
  if (Object.hasOwn(value, "durationSeconds") && durationSeconds === undefined) return null;
  return {
    extractor,
    id,
    canonicalUrl,
    ...(title === undefined ? {} : { title }),
    ...(uploader === undefined ? {} : { uploader }),
    ...(channel === undefined ? {} : { channel }),
    ...(license === undefined ? {} : { license }),
    ...(uploadDate === undefined ? {} : { uploadDate }),
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  };
}

const directHttpContainers: ReadonlySet<string> = new Set([
  "iso-bmff",
  "matroska",
  "webm",
  "ogg",
  "flac",
  "wave",
  "mp3",
  "mpeg-ts",
]);

function parseSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function parseDirectHttpValidator(value: unknown): MediaDirectHttpValidator | null {
  if (!isRecord(value)) return null;
  if (value["strength"] === "absent") {
    return hasExactKeys(value, ["strength"]) ? { strength: "absent" } : null;
  }
  if (value["strength"] !== "weak" && value["strength"] !== "strong") return null;
  if (!hasExactKeys(value, ["strength", "sha256"])) return null;
  const sha256 = parseSha256(value["sha256"]);
  return sha256 === null ? null : { strength: value["strength"], sha256 };
}

function isNormalizedLastModified(value: string): boolean {
  if (value.length !== 29 || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toUTCString() === value;
}

function isNormalizedMediaType(value: string): boolean {
  return value.length <= 256 && NORMALIZED_MEDIA_TYPE_PATTERN.test(value);
}

function isDirectHttpContainer(value: unknown): value is MediaDirectHttpContainer {
  return typeof value === "string" && directHttpContainers.has(value);
}

export function parseMediaDirectHttpProvenance(value: unknown): MediaDirectHttpProvenance | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "requestedUrlSha256",
    "effectiveUrlSha256",
    "validator",
    "lastModified",
    "declaredMediaType",
    "container",
    "body",
    "redirectCount",
  ])) return null;
  const requestedUrlSha256 = parseSha256(value["requestedUrlSha256"]);
  const effectiveUrlSha256 = parseSha256(value["effectiveUrlSha256"]);
  const validator = parseDirectHttpValidator(value["validator"]);
  const lastModified = value["lastModified"];
  const declaredMediaType = value["declaredMediaType"];
  const container = value["container"];
  const body = value["body"];
  const redirectCount = value["redirectCount"];
  const bodyBytes = isRecord(body) ? body["bytes"] : undefined;
  const bodySha256 = isRecord(body) ? parseSha256(body["sha256"]) : null;
  if (
    requestedUrlSha256 === null
    || effectiveUrlSha256 === null
    || validator === null
    || (lastModified !== null && (typeof lastModified !== "string" || !isNormalizedLastModified(lastModified)))
    || (declaredMediaType !== null && (typeof declaredMediaType !== "string" || !isNormalizedMediaType(declaredMediaType)))
    || !isDirectHttpContainer(container)
    || !isRecord(body)
    || !hasExactKeys(body, ["bytes", "sha256"])
    || typeof bodyBytes !== "number"
    || !Number.isSafeInteger(bodyBytes)
    || bodyBytes < 0
    || bodyBytes > MAX_DIRECT_HTTP_BODY_BYTES
    || bodySha256 === null
    || typeof redirectCount !== "number"
    || !Number.isSafeInteger(redirectCount)
    || redirectCount < 0
    || redirectCount > MAX_DIRECT_HTTP_REDIRECTS
  ) return null;
  return {
    requestedUrlSha256,
    effectiveUrlSha256,
    validator,
    lastModified,
    declaredMediaType,
    container,
    body: { bytes: bodyBytes, sha256: bodySha256 },
    redirectCount,
  };
}

function parsePublicYtDlpIdentity(value: unknown): MediaYtDlpYouTubeIdentity | OpaqueYtDlpIdentity | null {
  if (!isRecord(value)) return null;
  const profile = value["profile"];
  const providerDigest = parseSha256(value["providerIdentitySha256"]);
  if (
    profile === WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE
    && hasExactKeys(value, ["profile", "providerIdentitySha256"])
  ) {
    return providerDigest === null
      ? null
      : {
          profile: WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE,
          providerIdentitySha256: providerDigest,
        };
  }
  if (
    profile !== YT_DLP_OPAQUE_IDENTITY_PROFILE
    || !hasExactKeys(value, [
      "profile",
      "providerIdentitySha256",
      "requestedUrlSha256",
    ])
  ) return null;
  const requestedUrlDigest = parseSha256(value["requestedUrlSha256"]);
  return providerDigest === null || requestedUrlDigest === null
    ? null
    : {
        profile: YT_DLP_OPAQUE_IDENTITY_PROFILE,
        providerIdentitySha256: providerDigest,
        requestedUrlSha256: requestedUrlDigest,
      };
}

function parseAuthenticatedYtDlpIdentity(value: unknown): AuthenticatedYtDlpIdentity | null {
  if (
    !isRecord(value)
    || value["profile"] !== YT_DLP_AUTH_IDENTITY_PROFILE
    || !hasExactKeys(value, [
      "profile",
      "providerIdentitySha256",
      "requestedUrlSha256",
      "accessMode",
      "authContext",
    ])
  ) return null;
  const providerDigest = parseSha256(value["providerIdentitySha256"]);
  const requestedUrlDigest = parseSha256(value["requestedUrlSha256"]);
  const accessMode = value["accessMode"];
  const authContext = value["authContext"];
  if (
    providerDigest === null
    || requestedUrlDigest === null
    || (accessMode !== "browser" && accessMode !== "ambient_config")
    || !isRecord(authContext)
    || !hasExactKeys(authContext, ["profile", "sha256"])
    || authContext["profile"] !== AUTH_CONTEXT_IDENTITY_PROFILE
  ) return null;
  const authContextDigest = parseSha256(authContext["sha256"]);
  return authContextDigest === null
    ? null
    : {
        profile: YT_DLP_AUTH_IDENTITY_PROFILE,
        providerIdentitySha256: providerDigest,
        requestedUrlSha256: requestedUrlDigest,
        accessMode,
        authContext: {
          profile: AUTH_CONTEXT_IDENTITY_PROFILE,
          sha256: authContextDigest,
        },
      };
}

function parseCurrentYtDlpIdentity(value: unknown): MediaYtDlpIdentity | null {
  return parseAuthenticatedYtDlpIdentity(value) ?? parsePublicYtDlpIdentity(value);
}

function parseAcquisition(value: unknown): MediaYtDlpAcquisition | MediaDirectHttpAcquisition | null {
  if (!isRecord(value)) return null;
  if (value["adapter"] === "yt-dlp") {
    if (!hasExactKeys(value, ["adapter", "version", "identity"])) return null;
    const version = stringValue(value, "version", 256);
    const identity = parseCurrentYtDlpIdentity(value["identity"]);
    return version === undefined || identity === null
      ? null
      : { adapter: "yt-dlp", version, identity };
  }
  if (value["adapter"] !== "direct-http" || !hasExactKeys(value, ["adapter", "provenance"])) return null;
  const provenance = parseMediaDirectHttpProvenance(value["provenance"]);
  return provenance === null ? null : { adapter: "direct-http", provenance };
}

function parseAuthentication(value: unknown): MediaAuthentication | null {
  if (!isRecord(value)) return null;
  if (value["mode"] === "public") {
    return hasExactKeys(value, ["mode"]) ? { mode: "public" } : null;
  }
  const mode = value["mode"];
  const context = value["context"];
  if (
    (mode !== "browser" && mode !== "ambient_config")
    || !hasExactKeys(value, ["mode", "context"])
    || !isRecord(context)
    || !hasExactKeys(context, ["profile", "sha256"])
    || context["profile"] !== AUTH_CONTEXT_IDENTITY_PROFILE
  ) return null;
  const sha256 = parseSha256(context["sha256"]);
  return sha256 === null
    ? null
    : {
        mode,
        context: { profile: AUTH_CONTEXT_IDENTITY_PROFILE, sha256 },
      };
}

function parseTrackedRevision(value: unknown): MediaTrackedRevision | null {
  if (
    !isRecord(value)
    || value["profile"] !== WRENCH_MEDIA_TRACKED_REVISION_PROFILE
    || !hasExactKeys(
      value,
      ["profile", "sequence", "subjectAssetKey", "content"],
      ["previousAssetKey"],
    )
  ) return null;
  const sequence = value["sequence"];
  const subjectAssetKey = stringValue(value, "subjectAssetKey", 256);
  const previousAssetKey = stringValue(value, "previousAssetKey", 256);
  const content = value["content"];
  if (
    typeof sequence !== "number"
    || !Number.isSafeInteger(sequence)
    || sequence < 1
    || subjectAssetKey === undefined
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(subjectAssetKey)
    || (Object.hasOwn(value, "previousAssetKey")
      && (
        previousAssetKey === undefined
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(previousAssetKey)
      ))
    || !isRecord(content)
    || !hasExactKeys(content, ["profile", "sha256"])
    || content["profile"] !== WRENCH_MEDIA_REVISION_CONTENT_PROFILE
  ) return null;
  const contentSha256 = parseSha256(content["sha256"]);
  if (contentSha256 === null) return null;
  const revision: MediaTrackedRevision = {
    profile: WRENCH_MEDIA_TRACKED_REVISION_PROFILE,
    sequence,
    subjectAssetKey,
    ...(previousAssetKey === undefined ? {} : { previousAssetKey }),
    content: {
      profile: WRENCH_MEDIA_REVISION_CONTENT_PROFILE,
      sha256: contentSha256,
    },
  };
  try {
    trackedRevisionAssetKey(revision);
    return revision;
  } catch {
    return null;
  }
}

function isOriginOnlyUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.username === ""
      && parsed.password === ""
      && parsed.pathname === "/"
      && parsed.search === ""
      && parsed.hash === ""
      && parsed.href === `${parsed.origin}/`;
  } catch {
    return false;
  }
}

function localTranscriptProvenance(
  transcript: MediaTranscript,
): MediaLocalTranscriptProvenance | null {
  if (transcript.status === "available") {
    return transcript.source === "local" ? transcript.provenance : null;
  }
  return transcript.reason === "no_speech" ? transcript.provenance : null;
}

function localTranscriptIdentity(
  provenance: MediaLocalTranscriptProvenance,
): MediaLocalTranscriptIdentity {
  return {
    adapter: provenance.adapter,
    profile: provenance.profile,
    executableSha256: provenance.executableSha256,
    runtimeProfile: provenance.runtimeProfile,
    runtimeSha256: provenance.runtimeSha256,
    runtimeDependencyCount: provenance.runtimeDependencyCount,
    modelSha256: provenance.modelSha256,
    normalizationProfile: provenance.input.normalized.profile,
    requestedLanguage: provenance.requestedLanguage,
  };
}

function projectedLocalTranscriptAssetKey(
  baseSourceAssetKey: string,
  provenance: MediaLocalTranscriptProvenance | null,
): string | null {
  return provenance === null
    ? null
    : localTranscriptVariantAssetKey(
        baseSourceAssetKey,
        localTranscriptIdentity(provenance),
      );
}

function youtubeCanonicalUrl(videoId: string): string {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  return url.href;
}

function currentYtDlpSourceAssetKey(
  source: MediaManifestSource,
  identity: MediaYtDlpIdentity,
): string | null {
  if (identity.profile === WRENCH_MEDIA_YT_DLP_YOUTUBE_IDENTITY_PROFILE) {
    if (
      source.extractor !== "Youtube"
      || !OWNED_YOUTUBE_ID_PATTERN.test(source.id)
      || source.canonicalUrl !== youtubeCanonicalUrl(source.id)
      || identity.providerIdentitySha256 !== providerIdentitySha256("Youtube", source.id)
    ) return null;
    return sourceAssetKey("Youtube", source.id);
  }
  if (identity.profile === YT_DLP_OPAQUE_IDENTITY_PROFILE) {
    let baseSourceAssetKey: string;
    try {
      baseSourceAssetKey = opaqueYtDlpSourceAssetKey(identity);
    } catch {
      return null;
    }
    return source.extractor === "External"
      && source.id === opaqueYtDlpSourceId(baseSourceAssetKey)
      && isOriginOnlyUrl(source.canonicalUrl)
      && !sourceHasDescription(source)
      ? baseSourceAssetKey
      : null;
  }
  let baseSourceAssetKey: string;
  try {
    baseSourceAssetKey = authenticatedYtDlpSourceAssetKey(identity);
  } catch {
    return null;
  }
  return source.extractor === "External"
    && source.id === authenticatedYtDlpSourceId(baseSourceAssetKey)
    && isOriginOnlyUrl(source.canonicalUrl)
    && !sourceHasDescription(source)
    ? baseSourceAssetKey
    : null;
}

function currentAuthenticationMatchesIdentity(
  authentication: MediaAuthentication,
  identity: MediaYtDlpIdentity,
): boolean {
  if (identity.profile !== YT_DLP_AUTH_IDENTITY_PROFILE) {
    return authentication.mode === "public";
  }
  return authentication.mode === identity.accessMode
    && authentication.context.profile === identity.authContext.profile
    && authentication.context.sha256 === identity.authContext.sha256;
}

function currentYtDlpAssetKey(
  baseSourceAssetKey: string,
  mode: CaptureMode,
  transcript: MediaTranscript,
): string | null {
  if (mode === "archive") return baseSourceAssetKey;
  if (mode === "audio" || mode === "video") {
    return variantAssetKey(baseSourceAssetKey, [mode]);
  }
  if (transcript.status !== "available") return null;
  return transcript.source === "local"
    ? localTranscriptVariantAssetKey(
        baseSourceAssetKey,
        localTranscriptIdentity(transcript.provenance),
      )
    : variantAssetKey(baseSourceAssetKey, [
        "transcript",
        transcript.source,
        boundedTranscriptLanguageSegment(transcript.language),
      ]);
}

function transcriptModeIsValid(
  mode: CaptureMode,
  transcript: MediaTranscript,
  captureCount: number,
  videoCount: number,
  audioCount: number,
): boolean {
  if (mode === "audio" || mode === "video") {
    return captureCount === 1
      && audioCount === (mode === "audio" ? 1 : 0)
      && videoCount === (mode === "video" ? 1 : 0)
      && transcript.status === "unavailable"
      && transcript.reason === "not_requested";
  }
  if (mode === "transcript") {
    if (transcript.status !== "available") return false;
    return transcript.source === "local"
      ? captureCount === 1 && audioCount === 1 && videoCount === 0
      : captureCount === 0 && audioCount === 0 && videoCount === 0;
  }
  if (captureCount !== 1 || transcript.status === "unavailable" && transcript.reason === "not_requested") {
    return false;
  }
  if (transcript.status === "available" && transcript.source === "local") {
    return audioCount === 1;
  }
  if (transcript.status === "unavailable") {
    if (transcript.reason === "no_speech") return audioCount === 1;
    if (transcript.reason === "audio_not_present") {
      return audioCount === 0 && videoCount === 1;
    }
  }
  return videoCount === 1 || audioCount === 1;
}

function sourceHasDescription(source: MediaManifestSource): boolean {
  return source.title !== undefined
    || source.uploader !== undefined
    || source.channel !== undefined
    || source.license !== undefined
    || source.uploadDate !== undefined
    || source.timestamp !== undefined
    || source.durationSeconds !== undefined;
}

export function parseMediaManifest(value: unknown): ParseManifestResult {
  if (!isRecord(value) || value["schemaVersion"] !== WRENCH_MEDIA_SCHEMA_VERSION) {
    return { ok: false, message: "unsupported or missing Wrench media manifest schema" };
  }
  const acquisition = parseAcquisition(value["acquisition"]);
  const ytDlpAcquisition = acquisition?.adapter === "yt-dlp" ? acquisition : null;
  const directHttpAcquisition = acquisition?.adapter === "direct-http" ? acquisition : null;
  if (!hasExactKeys(
    value,
    [
      "schemaVersion",
      "wrenchVersion",
      "assetKey",
      "capturedAt",
      "mode",
      "source",
      "authentication",
      "acquisition",
      "tools",
      "artifacts",
      "transcript",
      ...(ytDlpAcquisition === null ? [] : ["revision"]),
    ],
  )) return { ok: false, message: "Wrench media manifest has an invalid top-level contract" };
  const wrenchVersion = stringValue(value, "wrenchVersion", 64);
  const assetKey = stringValue(value, "assetKey", 256);
  const capturedAt = stringValue(value, "capturedAt", 64);
  const mode = value["mode"];
  const source = parseSource(value["source"]);
  const authentication = parseAuthentication(value["authentication"]);
  const tools = value["tools"];
  const transcript = parseTranscript(value["transcript"]);
  const trackedRevision = ytDlpAcquisition === null
    ? null
    : parseTrackedRevision(value["revision"]);
  const artifactValues = value["artifacts"];
  if (
    wrenchVersion === undefined
    || assetKey === undefined
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(assetKey)
    || capturedAt === undefined
    || Number.isNaN(Date.parse(capturedAt))
    || (mode !== "archive" && mode !== "audio" && mode !== "video" && mode !== "transcript")
    || source === null
    || authentication === null
    || acquisition === null
    || !isRecord(tools)
    || transcript === null
    || !Array.isArray(artifactValues)
    || artifactValues.length > 128
  ) return { ok: false, message: "Wrench media manifest has an invalid top-level contract" };
  const ffmpeg = stringValue(tools, "ffmpeg", 256);
  const ffprobe = stringValue(tools, "ffprobe", 256);
  if (
    !hasExactKeys(tools, [], ["ffmpeg", "ffprobe"])
    || (Object.hasOwn(tools, "ffmpeg") && ffmpeg === undefined)
    || (Object.hasOwn(tools, "ffprobe") && ffprobe === undefined)
    || (ytDlpAcquisition !== null && trackedRevision === null)
  ) {
    return { ok: false, message: "Wrench media manifest has an invalid acquisition contract" };
  }
  if (directHttpAcquisition !== null && authentication.mode !== "public") {
    return { ok: false, message: "Wrench media direct HTTP acquisition must use public authentication" };
  }
  if (directHttpAcquisition !== null && !isOriginOnlyUrl(source.canonicalUrl)) {
    return { ok: false, message: "Wrench media direct HTTP source URL must be an origin-only public projection" };
  }
  const artifacts: MediaArtifact[] = [];
  const paths = new Set<string>();
  for (const artifactValue of artifactValues) {
    const artifact = parseArtifact(artifactValue);
    if (artifact === null || paths.has(artifact.path)) return { ok: false, message: "Wrench media manifest has an invalid or duplicate artifact" };
    paths.add(artifact.path);
    artifacts.push(artifact);
  }
  const artifactsByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact] as const));
  const roleCount = (role: ArtifactRole): number => artifacts.filter((artifact) => artifact.role === role).length;
  for (const role of artifactRoles) {
    if (roleCount(role) > 1) {
      return { ok: false, message: "Wrench media manifest has duplicate singleton artifact roles" };
    }
  }
  if (roleCount("provider_metadata") !== 1) {
    return { ok: false, message: "Wrench media manifest must contain exactly one provider metadata artifact" };
  }
  if (transcript.status === "available") {
    const references = [transcript.timedPath, transcript.textPath, transcript.cuesPath] as const;
    if (!references.every((path) => paths.has(path))) {
      return { ok: false, message: "Wrench media transcript references an unrecorded artifact" };
    }
    if (
      new Set(references).size !== references.length
      || artifactsByPath.get(transcript.timedPath)?.role !== "transcript_vtt"
      || artifactsByPath.get(transcript.textPath)?.role !== "transcript_text"
      || artifactsByPath.get(transcript.cuesPath)?.role !== "transcript_json"
    ) {
      return { ok: false, message: "Wrench media transcript paths do not map to their exact artifact roles" };
    }
  } else if (
    roleCount("transcript_vtt") !== 0
    || roleCount("transcript_text") !== 0
    || roleCount("transcript_json") !== 0
  ) {
    return { ok: false, message: "Wrench media unavailable transcript must not have transcript artifacts" };
  }
  const captureCount = roleCount("capture");
  const videoCount = roleCount("video");
  const audioCount = roleCount("audio");
  if (!transcriptModeIsValid(mode, transcript, captureCount, videoCount, audioCount)) {
    return { ok: false, message: "Wrench media manifest artifacts do not satisfy its capture mode" };
  }

  const localProvenance = localTranscriptProvenance(transcript);
  if (localProvenance !== null) {
    const inputArtifact = artifactsByPath.get(localProvenance.input.path);
    if (
      inputArtifact?.role !== "audio"
      || inputArtifact.bytes !== localProvenance.input.bytes
      || inputArtifact.sha256 !== localProvenance.input.sha256
    ) {
      return {
        ok: false,
        message: "Wrench media local transcript provenance does not match its audio artifact",
      };
    }
  }
  const localAttempt = localProvenance !== null
    || transcript.status === "unavailable" && transcript.reason === "audio_not_present";
  if (localAttempt && (ffmpeg === undefined || ffprobe === undefined)) {
    return {
      ok: false,
      message: "Wrench media local transcript requires FFmpeg and ffprobe provenance",
    };
  }
  if (ytDlpAcquisition !== null && trackedRevision !== null) {
    const baseSourceAssetKey = currentAuthenticationMatchesIdentity(
      authentication,
      ytDlpAcquisition.identity,
    )
      ? currentYtDlpSourceAssetKey(source, ytDlpAcquisition.identity)
      : null;
    let subjectAssetKey: string | null = null;
    if (baseSourceAssetKey !== null) {
      try {
        subjectAssetKey = currentYtDlpAssetKey(baseSourceAssetKey, mode, transcript);
      } catch {
        subjectAssetKey = null;
      }
    }
    let contentSha256: string | null = null;
    try {
      contentSha256 = revisionContentSha256(artifacts);
    } catch {
      contentSha256 = null;
    }
    const predecessorIsValid = trackedRevision.sequence === 1
      ? trackedRevision.previousAssetKey === undefined
      : trackedRevision.previousAssetKey !== undefined
        && /^revision-v1-[0-9a-f]{64}$/u.test(trackedRevision.previousAssetKey);
    let expectedRevisionAssetKey: string | null = null;
    try {
      expectedRevisionAssetKey = trackedRevisionAssetKey(trackedRevision);
    } catch {
      expectedRevisionAssetKey = null;
    }
    if (
      subjectAssetKey === null
      || trackedRevision.subjectAssetKey !== subjectAssetKey
      || trackedRevision.content.sha256 !== contentSha256
      || !predecessorIsValid
      || assetKey !== expectedRevisionAssetKey
    ) {
      return {
        ok: false,
        message: "Wrench media tracked revision identity projection is inconsistent",
      };
    }
  }

  if (directHttpAcquisition !== null) {
    const captureArtifact = artifacts.find((artifact) => artifact.role === "capture");
    if (
      captureArtifact === undefined
      || directHttpAcquisition.provenance.body.bytes !== captureArtifact.bytes
      || directHttpAcquisition.provenance.body.sha256 !== captureArtifact.sha256
    ) {
      return {
        ok: false,
        message: "Wrench media direct HTTP provenance does not match its capture artifact",
      };
    }
    let expectedMetadata;
    try {
      expectedMetadata = createDirectHttpMetadata({
        requestedOrigin: source.canonicalUrl,
        requestedUrlSha256: directHttpAcquisition.provenance.requestedUrlSha256,
        bodySha256: directHttpAcquisition.provenance.body.sha256,
      });
    } catch {
      return { ok: false, message: "Wrench media direct HTTP identity projection is invalid" };
    }
    let expectedAssetKey: string | null;
    try {
      expectedAssetKey = mode === "archive"
        ? expectedMetadata.assetKey
        : mode === "transcript" && localProvenance !== null
          ? projectedLocalTranscriptAssetKey(
              expectedMetadata.assetKey,
              localProvenance,
            )
          : variantAssetKey(expectedMetadata.assetKey, [mode]);
    } catch {
      return { ok: false, message: "Wrench media direct HTTP identity projection is invalid" };
    }
    const expectedMedia = directHttpMediaForContainer(directHttpAcquisition.provenance.container);
    const transcriptIsValid = mode === "archive"
        ? transcript.status === "unavailable" || transcript.source === "local"
        : mode === "transcript"
          ? transcript.status === "available" && transcript.source === "local"
          : transcript.status === "unavailable" && transcript.reason === "not_requested";
    if (
      assetKey !== expectedAssetKey
      || source.extractor !== expectedMetadata.extractor
      || source.id !== expectedMetadata.id
      || sourceHasDescription(source)
      || captureArtifact.path !== `data/capture/media.${expectedMedia.extension}`
      || captureArtifact.mediaType !== expectedMedia.mediaType
      || roleCount("description") !== 0
      || roleCount("thumbnail") !== 0
      || ffmpeg === undefined
      || ffprobe === undefined
      || !transcriptIsValid
    ) {
      return { ok: false, message: "Wrench media direct HTTP identity or media projection is inconsistent" };
    }
  }

  const sortedArtifacts = artifacts.toSorted((left, right) => compareUtf8(left.path, right.path));
  const parsedTools: MediaManifestTools = {
    ...(ffmpeg === undefined ? {} : { ffmpeg }),
    ...(ffprobe === undefined ? {} : { ffprobe }),
  };
  const common = {
    schemaVersion: WRENCH_MEDIA_SCHEMA_VERSION,
    wrenchVersion,
    assetKey,
    capturedAt,
    mode,
    source,
    artifacts: sortedArtifacts,
    transcript,
    tools: parsedTools,
  } as const;
  return directHttpAcquisition !== null
    ? {
        ok: true,
        manifest: {
          ...common,
          authentication: { mode: "public" },
          acquisition: directHttpAcquisition,
        },
      }
    : ytDlpAcquisition !== null && trackedRevision !== null
      ? {
          ok: true,
          manifest: {
            ...common,
            authentication,
            acquisition: ytDlpAcquisition,
            revision: trackedRevision,
          },
        }
      : { ok: false, message: "Wrench media manifest has an invalid acquisition contract" };
}

function containedPath(root: string, relativePath: string): string {
  if (!safeRelativePath(relativePath)) throw new Error("unsafe artifact path");
  const path = resolve(root, ...relativePath.split("/"));
  if (path === root || !path.startsWith(`${root}${sep}`)) throw new Error(`artifact escapes item directory: ${relativePath}`);
  return path;
}

async function hashRegularFile(
  itemRoot: string,
  relativePath: string,
  dependencies: MediaArtifactDependencies = {},
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const path = containedPath(itemRoot, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`artifact is not a regular file: ${relativePath}`);
  const physicalParent = await realpath(dirname(path));
  if (physicalParent !== dirname(path)) throw new Error(`artifact parent traverses a symbolic link: ${relativePath}`);
  await dependencies.beforeOpen?.(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size !== metadata.size
    ) {
      throw new Error(`artifact changed before hashing: ${relativePath}`);
    }
    const hash = createHash("sha256");
    const buffer = new Uint8Array(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (result.bytesRead === 0) throw new Error(`artifact ended while hashing: ${relativePath}`);
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, opened.size)).bytesRead !== 0) {
      throw new Error(`artifact grew while hashing: ${relativePath}`);
    }
    const [finished, finalPath] = await Promise.all([
      handle.stat(),
      lstat(path),
    ]);
    if (
      !finalPath.isFile()
      || finalPath.isSymbolicLink()
      || finalPath.dev !== opened.dev
      || finalPath.ino !== opened.ino
      || finalPath.size !== opened.size
      || finished.size !== opened.size
      || finished.mtimeMs !== opened.mtimeMs
      || finished.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`artifact changed while hashing: ${relativePath}`);
    }
    return { bytes: opened.size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function readBoundedRegularFile(
  itemRoot: string,
  relativePath: string,
  maximumBytes: number,
  dependencies: MediaControlFileDependencies = {},
): Promise<string> {
  const path = containedPath(itemRoot, relativePath);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${relativePath} is not a regular file`);
  }
  if (metadata.size > maximumBytes) {
    throw new Error(`${relativePath} exceeds the ${String(maximumBytes)} byte verification bound`);
  }
  const physicalParent = await realpath(dirname(path));
  if (physicalParent !== dirname(path)) {
    throw new Error(`${relativePath} parent traverses a symbolic link`);
  }

  await dependencies.beforeOpen?.(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== metadata.dev
      || opened.ino !== metadata.ino
      || opened.size !== metadata.size
      || opened.size > maximumBytes
    ) {
      throw new Error(`${relativePath} changed or is not a bounded regular file`);
    }
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw new Error(`${relativePath} ended while reading`);
      }
      offset += result.bytesRead;
    }
    const overflow = new Uint8Array(1);
    if ((await handle.read(overflow, 0, 1, bytes.byteLength)).bytesRead !== 0) {
      throw new Error(`${relativePath} grew while reading`);
    }
    await dependencies.afterRead?.(path);
    const [finished, finalPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !finalPath.isFile()
      || finalPath.isSymbolicLink()
      || finalPath.dev !== opened.dev
      || finalPath.ino !== opened.ino
      || finalPath.size !== opened.size
      || finished.size !== opened.size
      || finished.mtimeMs !== opened.mtimeMs
      || finished.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${relativePath} changed while reading`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${relativePath} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

function parseManifestSource(manifestSource: string): MediaManifest {
  let value: unknown;
  try {
    value = JSON.parse(manifestSource);
  } catch {
    throw new Error("wrench-media.json is not valid JSON");
  }
  const parsed = parseMediaManifest(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.manifest;
}

export async function readMediaManifest(
  itemDirectoryInput: string,
  dependencies: MediaControlFileDependencies = {},
): Promise<MediaManifest> {
  const requestedItemDirectory = resolve(itemDirectoryInput);
  const rootMetadata = await lstat(requestedItemDirectory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("item directory must be a real directory, not a symbolic link");
  }
  const itemDirectory = await realpath(requestedItemDirectory);
  return parseManifestSource(await readBoundedRegularFile(
    itemDirectory,
    WRENCH_MEDIA_MANIFEST_FILE,
    1024 * 1024,
    dependencies,
  ));
}

function mediaTypeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop();
  const types: Readonly<Record<string, string>> = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska", mka: "audio/x-matroska",
    mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac",
    vtt: "text/vtt", txt: "text/plain; charset=utf-8", json: "application/json", jpg: "image/jpeg", jpeg: "image/jpeg",
    png: "image/png", webp: "image/webp", avif: "image/avif",
  };
  return extension === undefined ? "application/octet-stream" : (types[extension] ?? "application/octet-stream");
}

export async function createMediaArtifact(
  itemRootInput: string,
  path: string,
  role: ArtifactRole,
  dependencies: MediaArtifactDependencies = {},
): Promise<MediaArtifact> {
  const itemRoot = await realpath(resolve(itemRootInput));
  const hashed = await hashRegularFile(itemRoot, path, dependencies);
  return { role, path, ...hashed, mediaType: mediaTypeForPath(path) };
}

function checksumLine(digest: string, path: string): string {
  return `${digest}  ${path}`;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function removeStaleControlTemps(itemRoot: string): Promise<void> {
  const entries = await readdir(itemRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!OWNED_CONTROL_TEMP_PATTERN.test(entry.name)) continue;
    const path = resolve(itemRoot, entry.name);
    const metadata = await lstat(path);
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || metadata.isSymbolicLink()
      || !metadata.isFile()
    ) {
      throw new Error(`stale control temp is not a regular file: ${entry.name}`);
    }
    await unlink(path);
  }
}

export async function writeMediaManifest(itemRootInput: string, manifestInput: MediaManifest): Promise<MediaManifest> {
  const itemRoot = await realpath(resolve(itemRootInput));
  const parsed = parseMediaManifest(manifestInput);
  if (!parsed.ok) throw new Error(parsed.message);
  const manifest = {
    ...parsed.manifest,
    artifacts: parsed.manifest.artifacts.toSorted((left, right) => compareUtf8(left.path, right.path)),
  };
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  await removeStaleControlTemps(itemRoot);
  await atomicWrite(resolve(itemRoot, WRENCH_MEDIA_MANIFEST_FILE), manifestSource);
  const manifestDigest = createHash("sha256").update(manifestSource, "utf8").digest("hex");
  const lines = [
    ...manifest.artifacts.map((artifact) => checksumLine(artifact.sha256, artifact.path)),
    checksumLine(manifestDigest, WRENCH_MEDIA_MANIFEST_FILE),
  ].toSorted(compareUtf8);
  await atomicWrite(resolve(itemRoot, WRENCH_MEDIA_CHECKSUM_FILE), `${lines.join("\n")}\n`);
  return manifest;
}

function parseChecksumSource(source: string): ReadonlyMap<string, string> | null {
  if (source.length === 0 || source.length > 64 * 1_024 || !source.endsWith("\n")) return null;
  const entries = new Map<string, string>();
  for (const line of source.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    const digest = match?.[1];
    const path = match?.[2];
    if (digest === undefined || path === undefined || (!safeRelativePath(path) && path !== WRENCH_MEDIA_MANIFEST_FILE) || entries.has(path)) return null;
    entries.set(path, digest);
  }
  return entries;
}

async function itemFileSet(itemDirectory: string): Promise<ReadonlySet<string>> {
  const files = new Set<string>();
  let entries = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_ITEM_DEPTH) throw new Error("item directory exceeds the verification depth bound");
    if (await realpath(directory) !== directory) {
      throw new Error("item directory traverses a symbolic-link ancestor");
    }
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        entries += 1;
        if (entries > MAX_ITEM_ENTRIES) {
          throw new Error("item directory exceeds the verification entry bound");
        }
        const path = resolve(directory, entry.name);
        const metadata = await lstat(path);
        if (metadata.isSymbolicLink() || entry.isSymbolicLink()) {
          throw new Error(`item contains a symbolic link: ${entry.name}`);
        }
        if (metadata.isDirectory() && entry.isDirectory()) {
          await walk(path, depth + 1);
          continue;
        }
        if (!metadata.isFile() || !entry.isFile()) {
          throw new Error(`item contains an unsupported filesystem entry: ${entry.name}`);
        }
        const itemPath = relative(itemDirectory, path).split(sep).join("/");
        if (!safeRelativePath(itemPath)) throw new Error("item contains an unsafe file path");
        files.add(itemPath);
      }
    } finally {
      try {
        await handle.close();
      } catch {
        // `for await` closes the directory on normal exhaustion in Bun.
      }
    }
  };
  await walk(itemDirectory, 0);
  return files;
}

export async function verifyMediaItem(
  itemDirectoryInput: string,
  dependencies: MediaControlFileDependencies = {},
): Promise<VerifyItemResult> {
  const requestedItemDirectory = resolve(itemDirectoryInput);
  const failures: string[] = [];
  try {
    const rootMetadata = await lstat(requestedItemDirectory);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("item directory must be a real directory, not a symbolic link");
    }
    const itemDirectory = await realpath(requestedItemDirectory);
    const manifestSource = await readBoundedRegularFile(
      itemDirectory,
      WRENCH_MEDIA_MANIFEST_FILE,
      1024 * 1024,
      dependencies,
    );
    const parsedManifest = parseManifestSource(manifestSource);
    const checksumSource = await readBoundedRegularFile(
      itemDirectory,
      WRENCH_MEDIA_CHECKSUM_FILE,
      64 * 1024,
      dependencies,
    );
    const checksums = parseChecksumSource(checksumSource);
    if (checksums === null) throw new Error("manifest-sha256.txt is invalid");
    const expectedPaths = new Set([...parsedManifest.artifacts.map((artifact) => artifact.path), WRENCH_MEDIA_MANIFEST_FILE]);
    if (checksums.size !== expectedPaths.size || [...expectedPaths].some((path) => !checksums.has(path))) {
      failures.push("checksum file does not name exactly the manifest and recorded artifacts");
    }
    const manifestHash = createHash("sha256").update(manifestSource, "utf8").digest("hex");
    if (checksums.get(WRENCH_MEDIA_MANIFEST_FILE) !== manifestHash) failures.push("wrench-media.json checksum mismatch");
    const expectedItemFiles = new Set([...expectedPaths, WRENCH_MEDIA_CHECKSUM_FILE]);
    const actualItemFiles = await itemFileSet(itemDirectory);
    if (
      actualItemFiles.size !== expectedItemFiles.size
      || [...expectedItemFiles].some((path) => !actualItemFiles.has(path))
    ) {
      failures.push("item directory does not contain exactly the recorded artifacts and control files");
    }
    for (const artifact of parsedManifest.artifacts) {
      try {
        const actual = await hashRegularFile(itemDirectory, artifact.path);
        if (actual.bytes !== artifact.bytes) failures.push(`${artifact.path}: byte length mismatch`);
        if (actual.sha256 !== artifact.sha256 || checksums.get(artifact.path) !== actual.sha256) failures.push(`${artifact.path}: SHA-256 mismatch`);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : `${artifact.path}: verification failed`);
      }
    }
    const finalItemFiles = await itemFileSet(itemDirectory);
    if (
      finalItemFiles.size !== expectedItemFiles.size
      || [...expectedItemFiles].some((path) => !finalItemFiles.has(path))
    ) {
      failures.push("item directory changed or contains an unrecorded file");
    }
    return {
      ok: failures.length === 0,
      itemDirectory: requestedItemDirectory,
      assetKey: parsedManifest.assetKey,
      checkedArtifacts: parsedManifest.artifacts.length,
      failures,
    };
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "item verification failed");
    return { ok: false, itemDirectory: requestedItemDirectory, checkedArtifacts: 0, failures };
  }
}

export function relativeArtifactPath(itemRoot: string, artifactPath: string): string {
  const value = relative(resolve(itemRoot), resolve(artifactPath)).split(sep).join("/");
  if (!safeRelativePath(value)) throw new Error("artifact path is outside the item directory");
  return value;
}
