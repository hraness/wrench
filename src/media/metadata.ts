import { createHash } from "node:crypto";
import { isLiteralLanguageTag, normalizeAuthContextName } from "./args";
import { compareUtf8 } from "./utf8-order";

export interface CaptionSelection {
  readonly source: "manual" | "automatic";
  readonly language: string;
}

export interface AcquisitionIdentity {
  /** Exact provider identity used only for probe/capture comparison and hashing. */
  readonly extractor: string;
  readonly id: string;
}

export const YT_DLP_OPAQUE_IDENTITY_PROFILE = "yt-dlp-opaque-url-v1" as const;
export const YT_DLP_AUTH_IDENTITY_PROFILE = "yt-dlp-auth-context-v1" as const;
export const AUTH_CONTEXT_IDENTITY_PROFILE = "wrench-media-auth-context-v1" as const;

/** Path-free inputs that let schema verification reproduce an opaque yt-dlp key. */
export interface OpaqueYtDlpIdentity {
  readonly profile: typeof YT_DLP_OPAQUE_IDENTITY_PROFILE;
  readonly providerIdentitySha256: string;
  readonly requestedUrlSha256: string;
}

export type YtDlpPrivateAccessMode = "browser" | "ambient_config";

/** Path-free inputs that isolate one explicit private-access realm. */
export interface AuthenticatedYtDlpIdentity {
  readonly profile: typeof YT_DLP_AUTH_IDENTITY_PROFILE;
  readonly providerIdentitySha256: string;
  readonly requestedUrlSha256: string;
  readonly accessMode: YtDlpPrivateAccessMode;
  readonly authContext: {
    readonly profile: typeof AUTH_CONTEXT_IDENTITY_PROFILE;
    readonly sha256: string;
  };
}

export interface YtDlpAuthorizationIdentityInput {
  readonly mode: YtDlpPrivateAccessMode;
  readonly contextSha256: string;
}

export type SourceProjection = "youtube" | "opaque";

export interface ProbeMetadata {
  readonly acquisitionIdentity: AcquisitionIdentity;
  readonly projection: SourceProjection;
  /** Exact unowned values that must be scrubbed from downstream diagnostics. */
  readonly diagnosticRedactions: readonly string[];
  readonly id: string;
  readonly extractor: string;
  readonly extractorDirectory: string;
  readonly itemDirectory: string;
  readonly assetKey: string;
  /** Present only for unowned yt-dlp sources; never contains a raw URL or provider value. */
  readonly opaqueYtDlpIdentity?: OpaqueYtDlpIdentity;
  /** Present only for explicitly named private access; contains digests, never credentials. */
  readonly authenticatedYtDlpIdentity?: AuthenticatedYtDlpIdentity;
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly uploader?: string;
  readonly channel?: string;
  readonly description?: string;
  readonly license?: string;
  readonly uploadDate?: string;
  readonly timestamp?: number;
  readonly durationSeconds?: number;
  readonly originalLanguage?: string;
  readonly manualCaptionLanguages: readonly string[];
  readonly automaticCaptionLanguages: readonly string[];
}

const IDENTITY_KEY_VERSION = 1 as const;
const DIRECT_HTTP_IDENTITY_VERSION = 1 as const;
const OWNED_YOUTUBE_EXTRACTOR = "Youtube" as const;
const DIRECT_HTTP_EXTRACTOR = "DirectHttp" as const;
const OPAQUE_EXTRACTOR = "External" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const IDENTITY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const EXTRACTOR_DIRECTORY_MAX_LENGTH = 80;
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export const PROVIDER_METADATA_SCHEMA_VERSION = 1 as const;

export interface ProviderMetadataDocument {
  readonly schemaVersion: typeof PROVIDER_METADATA_SCHEMA_VERSION;
  readonly sourceAssetKey: string;
  readonly source: {
    readonly extractor: string;
    readonly id: string;
    readonly canonicalUrl: string;
    readonly title?: string;
    readonly uploader?: string;
    readonly channel?: string;
    readonly description?: string;
    readonly license?: string;
    readonly uploadDate?: string;
    readonly timestamp?: number;
    readonly durationSeconds?: number;
  };
  readonly captions: {
    readonly originalLanguage?: string;
    readonly manualLanguages: readonly string[];
    readonly automaticLanguages: readonly string[];
  };
}

export type ParseProbeResult =
  | { readonly ok: true; readonly metadata: ProbeMetadata }
  | {
      readonly ok: false;
      readonly kind: "invalid";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly kind: "unsupported";
      readonly reason: "playlist" | "multi-video" | "live" | "upcoming" | "post-live" | "drm";
      readonly message: string;
    };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return true;
  }
  return false;
}

export function isWellFormedIdentity(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertWellFormedIdentity(value: string): void {
  if (!isWellFormedIdentity(value)) {
    throw new TypeError("provider identity contains ill-formed UTF-16");
  }
}

function boundedString(record: Readonly<Record<string, unknown>>, key: string, maximum = 4_096): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : undefined;
}

function boundedIdentityString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  maximum: number,
): string | undefined {
  const value = record[key];
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !hasControlCharacter(value)
    && isWellFormedIdentity(value)
    ? value
    : undefined;
}

function finiteNumber(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function diagnosticRedactions(
  record: Readonly<Record<string, unknown>>,
  acquisitionIdentity: AcquisitionIdentity,
): readonly string[] {
  const values: string[] = [acquisitionIdentity.extractor, acquisitionIdentity.id];
  for (const key of [
    "title",
    "uploader",
    "channel",
    "description",
    "license",
    "upload_date",
    "language",
  ]) {
    const value = record[key];
    if (
      typeof value === "string"
      && value.length > 0
      && value.length <= 64 * 1_024
      && !hasControlCharacter(value)
      && isWellFormedIdentity(value)
    ) {
      values.push(value);
      const normalized = value.normalize("NFC").trim();
      if (
        normalized.length > 0
        && normalized.length <= 64 * 1_024
        && !hasControlCharacter(normalized)
        && isWellFormedIdentity(normalized)
      ) values.push(normalized);
    }
  }
  // Longest-first exact replacement is deterministic and prevents a shorter
  // identity from destroying a match for a longer descriptive value.
  return [...new Set(values)].toSorted((left, right) => right.length - left.length);
}

const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

function parsedSafeWebUrl(value: string | undefined): URL | undefined {
  if (value === undefined || value.length > 8_192 || hasControlCharacter(value)) return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isOwnedYouTubeSource(
  extractor: string,
  providerId: string,
  candidateUrls: readonly (string | undefined)[],
): boolean {
  // The exact extractor key is part of the ownership allowlist. Prefix or
  // case-insensitive matching would let a plugin-defined extractor opt itself
  // into persistence of raw identity and descriptive metadata.
  return extractor === OWNED_YOUTUBE_EXTRACTOR
    && YOUTUBE_VIDEO_ID_PATTERN.test(providerId)
    && candidateUrls.some((value) => {
      const parsed = parsedSafeWebUrl(value);
      return parsed !== undefined && youtubeHosts.has(parsed.hostname.toLowerCase());
    });
}

function canonicalSourceUrl(
  candidateUrls: readonly (string | undefined)[],
  projection: SourceProjection,
  providerId: string,
): string | undefined {
  if (projection === "youtube") {
    // YouTube's public video identity belongs in `v`; every other query
    // parameter is navigation state, tracking data, or potentially secret.
    const canonical = new URL("https://www.youtube.com/watch");
    canonical.searchParams.set("v", providerId);
    return canonical.href;
  }
  for (const value of candidateUrls) {
    const parsed = parsedSafeWebUrl(value);
    if (parsed === undefined) continue;
    // Wrench media does not own the semantics or privacy of arbitrary URL paths.
    // Persist only the public origin until a provider-specific canonicalizer
    // can explicitly allowlist more.
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = "/";
    return parsed.href;
  }
  return undefined;
}

function youtubeCanonicalUrl(providerId: string): string {
  const canonical = new URL("https://www.youtube.com/watch");
  canonical.searchParams.set("v", providerId);
  return canonical.href;
}

function languageKeys(value: unknown): readonly string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value)
    .filter((key) => {
      const tracks = value[key];
      return Array.isArray(tracks)
        && tracks.some(isRecord)
        && isLiteralLanguageTag(key)
        && !hasControlCharacter(key)
        && isWellFormedIdentity(key)
        && !key.includes("/")
        && !key.includes("\\");
    })
    .toSorted(compareUtf8);
}

export function isPortableIdentityDirectorySegment(value: string): boolean {
  return IDENTITY_SEGMENT_PATTERN.test(value)
    && value !== "."
    && value !== ".."
    && !value.endsWith(".")
    && !WINDOWS_DEVICE_NAME_PATTERN.test(value);
}

export function identityDirectorySegment(value: string, fallbackPrefix: string): string {
  const normalized = value.normalize("NFKC");
  // NFKC is useful for detecting compatibility characters, but accepting the
  // normalized spelling would collapse distinct provider identities onto the
  // same physical directory. Only an already-canonical raw value is reused.
  if (
    normalized === value
    && isPortableIdentityDirectorySegment(value)
  ) {
    return normalized;
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
  return `${fallbackPrefix}-${digest}`;
}

/**
 * A readable but filesystem-portable provider item leaf. The digest is always
 * present because provider IDs are case-sensitive while common macOS and
 * Windows volumes are not; it also prevents Unicode normalization aliases.
 */
export function sourceItemDirectory(value: string): string {
  assertWellFormedIdentity(value);
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
  const readable = value.normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[.-]+$/gu, "");
  const maximumPrefixLength = 128 - digest.length - 1;
  const prefix = readable
    .slice(0, maximumPrefixLength)
    .replace(/[.-]+$/gu, "") || "item";
  return `${prefix}-${digest}`;
}

export function sourceExtractorDirectory(value: string): string {
  assertWellFormedIdentity(value);
  const compatibilityNormalized = value.normalize("NFKC");
  const lower = compatibilityNormalized.toLowerCase();
  const slug = lower
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[.-]+$/gu, "");
  const digest = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24);
  const readablePrefix = slug.length === 0 || slug === "." || slug === ".." ? "source" : slug;
  const maximumPrefixLength = EXTRACTOR_DIRECTORY_MAX_LENGTH - digest.length - 1;
  return `${readablePrefix.slice(0, maximumPrefixLength).replace(/[-.]+$/gu, "") || "source"}-${digest}`;
}

function tupleDigest(domain: string, components: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("wrench-media-identity-key\0", "utf8");
  for (const component of [domain, ...components]) {
    const bytes = new TextEncoder().encode(component);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(bytes.byteLength), false);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function invalidProbe(message: string): Extract<ParseProbeResult, { readonly kind: "invalid" }> {
  return { ok: false, kind: "invalid", message };
}

function unsupportedProbe(
  reason: Extract<ParseProbeResult, { readonly kind: "unsupported" }>["reason"],
): Extract<ParseProbeResult, { readonly kind: "unsupported" }> {
  const labels = {
    playlist: "playlist",
    "multi-video": "multi-video source",
    live: "live source",
    upcoming: "upcoming live source",
    "post-live": "post-live source",
    drm: "DRM-protected source",
  } as const;
  return {
    ok: false,
    kind: "unsupported",
    reason,
    message: `yt-dlp probe returned an unsupported ${labels[reason]}`,
  };
}

function unsupportedProbeEnvelope(
  value: Readonly<Record<string, unknown>>,
): Extract<ParseProbeResult, { readonly kind: "unsupported" }> | null {
  if (value["_type"] === "playlist") return unsupportedProbe("playlist");
  if (value["_type"] === "multi_video") return unsupportedProbe("multi-video");

  const liveStatus = value["live_status"];
  if (value["is_live"] === true || liveStatus === "is_live") return unsupportedProbe("live");
  if (value["is_upcoming"] === true || liveStatus === "is_upcoming") {
    return unsupportedProbe("upcoming");
  }
  if (liveStatus === "post_live") return unsupportedProbe("post-live");

  if (value["has_drm"] === true || value["_has_drm"] === true) {
    return unsupportedProbe("drm");
  }
  const requestedFormats = value["requested_formats"];
  if (
    Array.isArray(requestedFormats)
    && requestedFormats.some((format) => isRecord(format) && format["has_drm"] === true)
  ) {
    return unsupportedProbe("drm");
  }
  const formats = value["formats"];
  const formatRecords = Array.isArray(formats) ? formats.filter(isRecord) : [];
  if (
    Array.isArray(formats)
    && formatRecords.length > 0
    && formatRecords.length === formats.length
    && formatRecords.every((format) => format["has_drm"] === true)
  ) {
    return unsupportedProbe("drm");
  }
  return null;
}

/** Domain-separated digest of the exact, case-sensitive provider tuple. */
export function providerIdentitySha256(extractor: string, providerId: string): string {
  assertWellFormedIdentity(extractor);
  assertWellFormedIdentity(providerId);
  return tupleDigest("source", [extractor, providerId]);
}

/** SHA-256 of the normalized HTTP(S) request URL after removing only its fragment. */
export function requestedUrlSha256(value: string): string {
  const parsed = parsedSafeWebUrl(value);
  if (parsed === undefined) throw new TypeError("yt-dlp requested URL is malformed");
  parsed.hash = "";
  return createHash("sha256").update(parsed.href, "utf8").digest("hex");
}

/** Stable digest of a canonical user-declared authorization realm name. */
export function authContextSha256(value: string): string {
  const normalized = normalizeAuthContextName(value);
  if (normalized === null) throw new TypeError("authorization context is malformed");
  return tupleDigest("auth-context", [normalized]);
}

/** A collision-resistant, domain-separated identity for the raw provider tuple. */
export function sourceAssetKey(extractor: string, providerId: string): string {
  return `source-v${String(IDENTITY_KEY_VERSION)}-${providerIdentitySha256(extractor, providerId)}`;
}

/** Builds the URL-qualified identity used by every unowned yt-dlp source. */
export function opaqueYtDlpSourceAssetKey(identity: OpaqueYtDlpIdentity): string {
  if (
    identity.profile !== YT_DLP_OPAQUE_IDENTITY_PROFILE
    || !SHA256_PATTERN.test(identity.providerIdentitySha256)
    || !SHA256_PATTERN.test(identity.requestedUrlSha256)
  ) {
    throw new TypeError("opaque yt-dlp identity is malformed");
  }
  return `source-v2-${tupleDigest("yt-dlp-opaque-url", [
    identity.providerIdentitySha256,
    identity.requestedUrlSha256,
  ])}`;
}

/** Stable public projection of a URL-qualified opaque yt-dlp source key. */
export function opaqueYtDlpSourceId(assetKey: string): string {
  const match = /^source-v2-([0-9a-f]{64})$/u.exec(assetKey);
  if (match?.[1] === undefined) throw new TypeError("opaque yt-dlp source asset key is malformed");
  return `opaque-v2-${match[1]}`;
}

/** Builds the disjoint opaque identity used by browser and ambient-config access. */
export function authenticatedYtDlpSourceAssetKey(
  identity: AuthenticatedYtDlpIdentity,
): string {
  if (
    identity.profile !== YT_DLP_AUTH_IDENTITY_PROFILE
    || !SHA256_PATTERN.test(identity.providerIdentitySha256)
    || !SHA256_PATTERN.test(identity.requestedUrlSha256)
    || (identity.accessMode !== "browser" && identity.accessMode !== "ambient_config")
    || identity.authContext.profile !== AUTH_CONTEXT_IDENTITY_PROFILE
    || !SHA256_PATTERN.test(identity.authContext.sha256)
  ) {
    throw new TypeError("authenticated yt-dlp identity is malformed");
  }
  return `source-v3-${tupleDigest("yt-dlp-auth-context", [
    identity.providerIdentitySha256,
    identity.requestedUrlSha256,
    identity.accessMode,
    identity.authContext.sha256,
  ])}`;
}

/** Stable public projection of an authenticated opaque yt-dlp source key. */
export function authenticatedYtDlpSourceId(assetKey: string): string {
  const match = /^source-v3-([0-9a-f]{64})$/u.exec(assetKey);
  if (match?.[1] === undefined) {
    throw new TypeError("authenticated yt-dlp source asset key is malformed");
  }
  return `opaque-v3-${match[1]}`;
}

export interface DirectHttpMetadataInput {
  /** Origin-only public projection of the requested URL. */
  readonly requestedOrigin: string;
  /** SHA-256 of the exact fragment-stripped requested URL. */
  readonly requestedUrlSha256: string;
  /** SHA-256 of the complete response body. */
  readonly bodySha256: string;
}

/**
 * Builds a final direct-file identity only after the complete body is known.
 * URL secrets never cross this boundary: callers provide an origin and hashes.
 */
export function createDirectHttpMetadata(input: DirectHttpMetadataInput): ProbeMetadata {
  if (
    !isOriginOnlyCanonicalUrl(input.requestedOrigin)
    || !SHA256_PATTERN.test(input.requestedUrlSha256)
    || !SHA256_PATTERN.test(input.bodySha256)
  ) {
    throw new TypeError("direct HTTP identity is malformed");
  }
  const acquisitionId = `direct-http-v${String(DIRECT_HTTP_IDENTITY_VERSION)}-${tupleDigest(
    "direct-http",
    [input.requestedUrlSha256, input.bodySha256],
  )}`;
  const assetKey = sourceAssetKey(DIRECT_HTTP_EXTRACTOR, acquisitionId);
  const projectedId = opaqueSourceId(assetKey);
  return {
    acquisitionIdentity: { extractor: DIRECT_HTTP_EXTRACTOR, id: acquisitionId },
    projection: "opaque",
    diagnosticRedactions: [acquisitionId, DIRECT_HTTP_EXTRACTOR],
    id: projectedId,
    extractor: OPAQUE_EXTRACTOR,
    extractorDirectory: sourceExtractorDirectory(OPAQUE_EXTRACTOR),
    itemDirectory: sourceItemDirectory(projectedId),
    assetKey,
    canonicalUrl: input.requestedOrigin,
    manualCaptionLanguages: [],
    automaticCaptionLanguages: [],
  };
}

/** Stable opaque identity projected from a raw provider tuple digest. */
export function opaqueSourceId(assetKey: string): string {
  const prefix = `source-v${String(IDENTITY_KEY_VERSION)}-`;
  if (!assetKey.startsWith(prefix) || !/^[0-9a-f]{64}$/u.test(assetKey.slice(prefix.length))) {
    throw new TypeError("source asset key is malformed");
  }
  return `opaque-v${String(IDENTITY_KEY_VERSION)}-${assetKey.slice(prefix.length)}`;
}

function isOriginOnlyCanonicalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.href === `${url.origin}/`;
  } catch {
    return false;
  }
}

/** Validates the complete in-memory projection before any path or artifact write. */
export function isNormalizedProbeMetadata(metadata: ProbeMetadata): boolean {
  try {
    if (metadata.projection !== "youtube" && metadata.projection !== "opaque") return false;
    const raw = metadata.acquisitionIdentity;
    if (
      raw.extractor.length === 0
      || raw.extractor.length > 512
      || raw.id.length === 0
      || raw.id.length > 512
      || hasControlCharacter(raw.extractor)
      || hasControlCharacter(raw.id)
      || !isWellFormedIdentity(raw.extractor)
      || !isWellFormedIdentity(raw.id)
    ) return false;
    const v1AssetKey = sourceAssetKey(raw.extractor, raw.id);
    const opaqueIdentity = metadata.opaqueYtDlpIdentity;
    const authenticatedIdentity = metadata.authenticatedYtDlpIdentity;
    if (opaqueIdentity !== undefined && authenticatedIdentity !== undefined) return false;
    const assetKey = authenticatedIdentity !== undefined
      ? authenticatedYtDlpSourceAssetKey(authenticatedIdentity)
      : opaqueIdentity === undefined
        ? v1AssetKey
        : opaqueYtDlpSourceAssetKey(opaqueIdentity);
    const expectedExtractor = metadata.projection === "youtube"
      ? OWNED_YOUTUBE_EXTRACTOR
      : OPAQUE_EXTRACTOR;
    const expectedId = metadata.projection === "youtube"
      ? raw.id
      : authenticatedIdentity !== undefined
        ? authenticatedYtDlpSourceId(assetKey)
        : opaqueIdentity === undefined
          ? opaqueSourceId(assetKey)
          : opaqueYtDlpSourceId(assetKey);
    if (
      metadata.assetKey !== assetKey
      || metadata.extractor !== expectedExtractor
      || metadata.id !== expectedId
      || metadata.extractorDirectory !== sourceExtractorDirectory(expectedExtractor)
      || metadata.itemDirectory !== sourceItemDirectory(expectedId)
      || !isPortableIdentityDirectorySegment(metadata.extractorDirectory)
      || !isPortableIdentityDirectorySegment(metadata.itemDirectory)
    ) return false;

    if (metadata.projection === "youtube") {
      return raw.extractor === OWNED_YOUTUBE_EXTRACTOR
        && YOUTUBE_VIDEO_ID_PATTERN.test(raw.id)
        && metadata.canonicalUrl === youtubeCanonicalUrl(raw.id)
        && opaqueIdentity === undefined
        && authenticatedIdentity === undefined
        && metadata.diagnosticRedactions.length === 0;
    }
    const directHttpIdentity = raw.extractor === DIRECT_HTTP_EXTRACTOR
      && /^direct-http-v1-[0-9a-f]{64}$/u.test(raw.id);
    if (directHttpIdentity) {
      if (opaqueIdentity !== undefined || authenticatedIdentity !== undefined) return false;
    } else if (authenticatedIdentity !== undefined) {
      if (
        authenticatedIdentity.profile !== YT_DLP_AUTH_IDENTITY_PROFILE
        || authenticatedIdentity.providerIdentitySha256 !== providerIdentitySha256(raw.extractor, raw.id)
        || !SHA256_PATTERN.test(authenticatedIdentity.requestedUrlSha256)
        || (authenticatedIdentity.accessMode !== "browser" && authenticatedIdentity.accessMode !== "ambient_config")
        || authenticatedIdentity.authContext.profile !== AUTH_CONTEXT_IDENTITY_PROFILE
        || !SHA256_PATTERN.test(authenticatedIdentity.authContext.sha256)
      ) return false;
    } else {
      if (
        opaqueIdentity === undefined
        || opaqueIdentity.profile !== YT_DLP_OPAQUE_IDENTITY_PROFILE
        || opaqueIdentity.providerIdentitySha256 !== providerIdentitySha256(raw.extractor, raw.id)
        || !SHA256_PATTERN.test(opaqueIdentity.requestedUrlSha256)
      ) return false;
    }
    if (!isOriginOnlyCanonicalUrl(metadata.canonicalUrl)) return false;
    if (
      metadata.title !== undefined
      || metadata.uploader !== undefined
      || metadata.channel !== undefined
      || metadata.description !== undefined
      || metadata.license !== undefined
      || metadata.uploadDate !== undefined
      || metadata.timestamp !== undefined
      || metadata.durationSeconds !== undefined
      || metadata.originalLanguage !== undefined
    ) return false;
    if (
      !metadata.diagnosticRedactions.includes(raw.extractor)
      || !metadata.diagnosticRedactions.includes(raw.id)
      || metadata.diagnosticRedactions.length > 16
      || metadata.diagnosticRedactions.some((value) =>
        value.length === 0
        || value.length > 64 * 1_024
        || hasControlCharacter(value)
        || !isWellFormedIdentity(value))
    ) return false;
    return true;
  } catch {
    return false;
  }
}

/** A disjoint identity for one focused view of a source archive. */
export function variantAssetKey(
  sourceKey: string,
  variantSegments: readonly string[],
): string {
  return `variant-v${String(IDENTITY_KEY_VERSION)}-${tupleDigest("variant", [sourceKey, ...variantSegments])}`;
}

export function parseProbeMetadata(
  value: unknown,
  requestedUrl: string,
  authorization?: YtDlpAuthorizationIdentityInput,
): ParseProbeResult {
  if (!isRecord(value)) return invalidProbe("yt-dlp probe did not return an object");
  const unsupported = unsupportedProbeEnvelope(value);
  if (unsupported !== null) return unsupported;
  const id = boundedIdentityString(value, "id", 512);
  const extractor = boundedIdentityString(value, "extractor_key", 512)
    ?? boundedIdentityString(value, "extractor", 512);
  if (id === undefined || extractor === undefined) {
    return invalidProbe("yt-dlp probe is missing a bounded extractor identity");
  }
  const candidateUrls = [
    boundedString(value, "webpage_url", 8_192),
    boundedString(value, "original_url", 8_192),
    requestedUrl,
  ] as const;
  if (
    authorization !== undefined
    && (
      (authorization.mode !== "browser" && authorization.mode !== "ambient_config")
      || !SHA256_PATTERN.test(authorization.contextSha256)
    )
  ) return invalidProbe("yt-dlp authorization identity is malformed");
  const projection: SourceProjection = authorization === undefined
    && isOwnedYouTubeSource(extractor, id, candidateUrls)
    ? "youtube"
    : "opaque";
  const canonicalUrl = canonicalSourceUrl(candidateUrls, projection, id);
  if (canonicalUrl === undefined) return invalidProbe("yt-dlp probe is missing a safe canonical URL");
  let opaqueIdentity: OpaqueYtDlpIdentity | undefined;
  let authenticatedIdentity: AuthenticatedYtDlpIdentity | undefined;
  if (projection === "opaque") {
    let requestDigest: string;
    try {
      requestDigest = requestedUrlSha256(requestedUrl);
    } catch {
      return invalidProbe("yt-dlp probe is missing a safe requested URL");
    }
    const providerDigest = providerIdentitySha256(extractor, id);
    if (authorization === undefined) {
      opaqueIdentity = {
        profile: YT_DLP_OPAQUE_IDENTITY_PROFILE,
        providerIdentitySha256: providerDigest,
        requestedUrlSha256: requestDigest,
      };
    } else {
      authenticatedIdentity = {
        profile: YT_DLP_AUTH_IDENTITY_PROFILE,
        providerIdentitySha256: providerDigest,
        requestedUrlSha256: requestDigest,
        accessMode: authorization.mode,
        authContext: {
          profile: AUTH_CONTEXT_IDENTITY_PROFILE,
          sha256: authorization.contextSha256,
        },
      };
    }
  }
  const assetKey = authenticatedIdentity !== undefined
    ? authenticatedYtDlpSourceAssetKey(authenticatedIdentity)
    : opaqueIdentity === undefined
      ? sourceAssetKey(extractor, id)
      : opaqueYtDlpSourceAssetKey(opaqueIdentity);
  const projectedExtractor = projection === "youtube" ? OWNED_YOUTUBE_EXTRACTOR : OPAQUE_EXTRACTOR;
  const projectedId = projection === "youtube"
    ? id
    : authenticatedIdentity === undefined
      ? opaqueYtDlpSourceId(assetKey)
      : authenticatedYtDlpSourceId(assetKey);
  const extractorPath = sourceExtractorDirectory(projectedExtractor);
  const itemPath = sourceItemDirectory(projectedId);
  // Descriptive fields are provider-owned public metadata only when the source
  // is on Wrench media's narrow ownership allowlist. Generic extractors frequently
  // derive these strings from signed URL basenames.
  const title = projection === "youtube" ? boundedString(value, "title", 2_048) : undefined;
  const uploader = projection === "youtube" ? boundedString(value, "uploader", 1_024) : undefined;
  const channel = projection === "youtube" ? boundedString(value, "channel", 1_024) : undefined;
  const description = projection === "youtube" ? boundedString(value, "description", 64 * 1_024) : undefined;
  const license = projection === "youtube" ? boundedString(value, "license", 1_024) : undefined;
  const uploadDate = projection === "youtube" ? boundedString(value, "upload_date", 32) : undefined;
  const timestamp = projection === "youtube" ? finiteNumber(value, "timestamp") : undefined;
  const durationSeconds = projection === "youtube" ? finiteNumber(value, "duration") : undefined;
  const originalLanguage = projection === "youtube" ? boundedString(value, "language", 128) : undefined;
  return {
    ok: true,
    metadata: {
      acquisitionIdentity: { extractor, id },
      projection,
      diagnosticRedactions: projection === "opaque"
        ? diagnosticRedactions(value, { extractor, id })
        : [],
      id: projectedId,
      extractor: projectedExtractor,
      extractorDirectory: extractorPath,
      itemDirectory: itemPath,
      assetKey,
      ...(opaqueIdentity === undefined ? {} : { opaqueYtDlpIdentity: opaqueIdentity }),
      ...(authenticatedIdentity === undefined
        ? {}
        : { authenticatedYtDlpIdentity: authenticatedIdentity }),
      canonicalUrl,
      ...(title === undefined ? {} : { title }),
      ...(uploader === undefined ? {} : { uploader }),
      ...(channel === undefined ? {} : { channel }),
      ...(description === undefined ? {} : { description }),
      ...(license === undefined ? {} : { license }),
      ...(uploadDate === undefined ? {} : { uploadDate }),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(originalLanguage === undefined ? {} : { originalLanguage }),
      manualCaptionLanguages: languageKeys(value["subtitles"]),
      automaticCaptionLanguages: languageKeys(value["automatic_captions"]),
    },
  };
}

/**
 * Builds the complete provider metadata artifact from Wrench media's owned probe model.
 * Unknown yt-dlp fields never cross this boundary, including formats, fragment
 * URLs, request headers, cookies, and extractor-private state.
 */
export function createProviderMetadataDocument(
  metadata: ProbeMetadata,
): ProviderMetadataDocument {
  if (!isNormalizedProbeMetadata(metadata)) {
    throw new TypeError("provider metadata projection is inconsistent");
  }
  return {
    schemaVersion: PROVIDER_METADATA_SCHEMA_VERSION,
    sourceAssetKey: metadata.assetKey,
    source: {
      extractor: metadata.extractor,
      id: metadata.id,
      canonicalUrl: metadata.canonicalUrl,
      ...(metadata.title === undefined ? {} : { title: metadata.title }),
      ...(metadata.uploader === undefined ? {} : { uploader: metadata.uploader }),
      ...(metadata.channel === undefined ? {} : { channel: metadata.channel }),
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
      ...(metadata.license === undefined ? {} : { license: metadata.license }),
      ...(metadata.uploadDate === undefined ? {} : { uploadDate: metadata.uploadDate }),
      ...(metadata.timestamp === undefined ? {} : { timestamp: metadata.timestamp }),
      ...(metadata.durationSeconds === undefined
        ? {}
        : { durationSeconds: metadata.durationSeconds }),
    },
    captions: {
      ...(metadata.originalLanguage === undefined
        ? {}
        : { originalLanguage: metadata.originalLanguage }),
      manualLanguages: [...metadata.manualCaptionLanguages],
      automaticLanguages: [...metadata.automaticCaptionLanguages],
    },
  };
}

export function renderProviderMetadataJson(metadata: ProbeMetadata): string {
  return `${JSON.stringify(createProviderMetadataDocument(metadata), null, 2)}\n`;
}

function languageFamily(value: string): string {
  return value.toLowerCase().split("-")[0] ?? "";
}

export function selectCaption(metadata: ProbeMetadata, requestedLanguage: string): CaptionSelection | null {
  const requested = requestedLanguage.toLowerCase();
  const requestedFamily = languageFamily(requested);
  const original = metadata.originalLanguage?.toLowerCase();
  const originalFamily = original === undefined ? undefined : languageFamily(original);
  const relevance = (language: string): number => {
    const normalized = language.toLowerCase();
    if (normalized === requested) return 0;
    if (languageFamily(normalized) === requestedFamily) return 1;
    if (original !== undefined && normalized === original) return 2;
    if (originalFamily !== undefined && languageFamily(normalized) === originalFamily) return 3;
    return 4;
  };

  let best: Readonly<{
    selection: CaptionSelection;
    relevance: number;
    quality: number;
    order: number;
  }> | null = null;
  let order = 0;
  for (const [source, languages] of [
    ["manual", metadata.manualCaptionLanguages],
    ["automatic", metadata.automaticCaptionLanguages],
  ] as const) {
    const quality = source === "manual" ? 0 : 1;
    for (const language of languages) {
      const candidate = {
        selection: { source, language },
        relevance: relevance(language),
        quality,
        order,
      } as const;
      order += 1;
      if (
        best === null
        || candidate.relevance < best.relevance
        || (candidate.relevance === best.relevance && candidate.quality < best.quality)
        || (
          candidate.relevance === best.relevance
          && candidate.quality === best.quality
          && candidate.order < best.order
        )
      ) {
        best = candidate;
      }
    }
  }
  return best?.selection ?? null;
}
