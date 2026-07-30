import { isLiteralLanguageTag, isValidBrowserSpec, type CaptureMode } from "./args";
import {
  isWellFormedIdentity,
  parseProbeMetadata,
  type YtDlpAuthorizationIdentityInput,
  type CaptionSelection,
  type ParseProbeResult,
  type ProbeMetadata,
} from "./metadata";
import {
  runProcess,
  urlDerivedRedactions,
  type CommandArgv,
  type ProcessFailureReason,
  type ProcessResult,
  type RunProcessOptions,
} from "./process";

const PROBE_TIMEOUT_MS = 2 * 60 * 1_000;
const CAPTURE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const PROBE_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
const CAPTURE_STDOUT_LIMIT_BYTES = 16 * 1024;
const TOOL_STDERR_LIMIT_BYTES = 2 * 1024 * 1024;
const CAPTURE_IDENTITY_PREFIX = "WRENCH_MEDIA_CAPTURE_IDENTITY_V1\t";
const CAPTURE_IDENTITY_MAX_CODE_UNITS = 512;
const CAPTURE_EXTENSION_MAX_CODE_UNITS = 16;
const RESERVED_CAPTURE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ass",
  "avif",
  "bmp",
  "description",
  "dfxp",
  "gif",
  "ico",
  "jpeg",
  "jfif",
  "jpg",
  "json",
  "json3",
  "jxl",
  "lrc",
  "part",
  "png",
  "sami",
  "scc",
  "srv1",
  "srv2",
  "srv3",
  "srt",
  "svg",
  "tif",
  "tiff",
  "txt",
  "ttml",
  "vtt",
  "webp",
  "xml",
  "ytdl",
]);

// yt-dlp loads ambient configuration before command-line arguments. These
// Wrench media-owned negatives are therefore always emitted on the CLI, including
// when the user explicitly inherits config, so config cannot weaken them.
const OWNED_PROBE_BOUNDARY_ARGS = [
  "--no-remote-components",
  "--ignore-dynamic-mpd",
  "--no-wait-for-video",
  "--no-live-from-start",
  "--no-allow-unplayable-formats",
] as const;

const OWNED_CAPTURE_BOUNDARY_ARGS = [
  ...OWNED_PROBE_BOUNDARY_ARGS,
  "--no-keep-fragments",
  "--no-hls-split-discontinuity",
] as const;

// `after_move` is the first point where a media capture's final file exists.
// Transcript-only runs do not execute that stage, so they report at
// `after_video`, which is the corresponding once-per-item completion boundary.
const CAPTURE_IDENTITY_TEMPLATE = `${CAPTURE_IDENTITY_PREFIX}{"extractor":%(extractor_key,extractor|)j,"id":%(id|)j,"ext":%(ext|)j}`;

export interface YtDlpAuthOptions {
  readonly browser?: string;
  readonly inheritConfig: boolean;
  readonly authContextSha256?: string;
}

export interface ProbeYtDlpOptions extends YtDlpAuthOptions {
  readonly executable: string;
  readonly url: string;
  readonly signal?: AbortSignal;
}

export interface CaptureYtDlpOptions extends YtDlpAuthOptions {
  readonly executable: string;
  readonly url: string;
  readonly mode: CaptureMode;
  readonly captureDirectory: string;
  readonly temporaryDirectory: string;
  readonly caption: CaptionSelection | null;
  readonly persistDescriptiveMetadata: boolean;
  readonly privateRedactions?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface YtDlpProcessFailure {
  readonly ok: false;
  readonly diagnostic: string;
  /** Exact process-layer reason; archive maps `aborted` to cancellation. */
  readonly processReason: ProcessFailureReason;
}

export interface YtDlpOutputFailure {
  readonly ok: false;
  readonly diagnostic: string;
  readonly processReason?: never;
}

export type YtDlpProbeResult =
  | { readonly ok: true; readonly metadata: ProbeMetadata }
  | Extract<ParseProbeResult, { readonly kind: "unsupported" }>
  | YtDlpProcessFailure
  | YtDlpOutputFailure;

export interface YtDlpCaptureIdentity {
  readonly extractor: string;
  readonly id: string;
  readonly ext: string;
}

export type YtDlpCaptureResult =
  | { readonly ok: true; readonly identity: YtDlpCaptureIdentity }
  | YtDlpProcessFailure
  | YtDlpOutputFailure;

export type ParseYtDlpCaptureIdentityResult = YtDlpCaptureResult;

export interface YtDlpDependencies {
  readonly runProcess: (argv: CommandArgv, options: RunProcessOptions) => Promise<ProcessResult>;
}

const defaultDependencies: YtDlpDependencies = { runProcess: (argv, options) => runProcess(argv, options) };
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function authorizationIdentity(
  options: YtDlpAuthOptions,
): YtDlpAuthorizationIdentityInput | undefined {
  if (options.browser !== undefined && !isValidBrowserSpec(options.browser)) {
    throw new TypeError("yt-dlp browser selector is malformed");
  }
  if (options.browser !== undefined && options.inheritConfig) {
    throw new TypeError("yt-dlp browser and ambient configuration are mutually exclusive");
  }
  const hasPrivateAccess = options.browser !== undefined || options.inheritConfig;
  if (hasPrivateAccess !== (options.authContextSha256 !== undefined)) {
    throw new TypeError("yt-dlp private access requires exactly one authorization context");
  }
  if (options.authContextSha256 === undefined) return undefined;
  if (!SHA256_PATTERN.test(options.authContextSha256)) {
    throw new TypeError("yt-dlp authorization context digest is malformed");
  }
  return {
    mode: options.browser === undefined ? "ambient_config" : "browser",
    contextSha256: options.authContextSha256,
  };
}

function configurationArgs(options: YtDlpAuthOptions): string[] {
  return options.inheritConfig ? [] : ["--ignore-config", "--no-plugin-dirs"];
}

function authenticationArgs(options: YtDlpAuthOptions): string[] {
  return options.browser === undefined ? [] : ["--cookies-from-browser", options.browser];
}

export function buildYtDlpProbeArgv(options: ProbeYtDlpOptions): CommandArgv {
  authorizationIdentity(options);
  return [
    options.executable,
    ...configurationArgs(options),
    ...OWNED_PROBE_BOUNDARY_ARGS,
    "--no-playlist",
    "--skip-download",
    "--dump-single-json",
    "--no-warnings",
    ...authenticationArgs(options),
    "--",
    options.url,
  ];
}

function modeArgs(mode: CaptureMode): string[] {
  switch (mode) {
    case "archive":
      return ["--format", "bv*+ba/b", "--merge-output-format", "mkv"];
    case "audio":
      return ["--format", "bestaudio/best"];
    case "video":
      return ["--format", "bestvideo/best"];
    case "transcript":
      return ["--skip-download"];
  }
}

function captionArgs(caption: CaptionSelection | null): string[] {
  if (caption === null) return [];
  if (!isLiteralLanguageTag(caption.language)) {
    throw new TypeError("caption language must be a literal BCP-47-style tag");
  }
  return [
    caption.source === "manual" ? "--write-subs" : "--write-auto-subs",
    "--sub-langs",
    caption.language,
    "--sub-format",
    "vtt/best",
    "--convert-subs",
    "vtt",
  ];
}

function captureIdentityPrintArg(mode: CaptureMode): string {
  const when = mode === "transcript" ? "after_video" : "after_move";
  return `${when}:${CAPTURE_IDENTITY_TEMPLATE}`;
}

export function buildYtDlpCaptureArgv(options: CaptureYtDlpOptions): CommandArgv {
  authorizationIdentity(options);
  return [
    options.executable,
    ...configurationArgs(options),
    ...OWNED_CAPTURE_BOUNDARY_ARGS,
    "--no-playlist",
    "--abort-on-error",
    "--abort-on-unavailable-fragments",
    "--check-formats",
    "--quiet",
    "--no-progress",
    "--no-simulate",
    "--continue",
    "--part",
    "--no-overwrites",
    "--no-mtime",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--retry-sleep",
    "http:exp=1:20",
    "--retry-sleep",
    "fragment:exp=1:20",
    // Probe JSON is parsed into Wrench media's owned metadata model. Explicitly disable
    // raw info sidecars even when an inherited yt-dlp config enables them.
    "--no-write-info-json",
    ...(options.persistDescriptiveMetadata
      ? ["--write-description", "--write-thumbnail"]
      : ["--no-write-description", "--no-write-thumbnail"]),
    ...captionArgs(options.caption),
    ...modeArgs(options.mode),
    "--paths",
    `home:${options.captureDirectory}`,
    "--paths",
    `temp:${options.temporaryDirectory}`,
    "--output",
    "media.%(ext)s",
    // `--print` is a machine-readable provenance channel, not user-facing
    // progress. JSON conversion safely quotes arbitrary extractor identities.
    "--print",
    captureIdentityPrintArg(options.mode),
    ...authenticationArgs(options),
    "--",
    options.url,
  ];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasIdentityControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function boundedIdentityString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Provider identity is opaque. Normalizing or trimming here could make two
  // distinct post-capture identities compare equal across the probe boundary.
  return value.length > 0
    && value.length <= CAPTURE_IDENTITY_MAX_CODE_UNITS
    && !hasIdentityControlCharacter(value)
    && isWellFormedIdentity(value)
    ? value
    : null;
}

/** Revalidates completion extensions at every injected adapter boundary. */
export function isSafeYtDlpCaptureExtension(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= CAPTURE_EXTENSION_MAX_CODE_UNITS
    && /^[a-z0-9]+$/u.test(value)
    && !RESERVED_CAPTURE_EXTENSIONS.has(value);
}

/**
 * Parses only Wrench media's prefixed, allowlisted completion record. Other stdout can
 * be produced by an explicitly inherited yt-dlp config, but never crosses this
 * boundary. Exactly one Wrench media record is required.
 */
export function parseYtDlpCaptureIdentity(
  stdout: unknown,
): ParseYtDlpCaptureIdentityResult {
  if (typeof stdout !== "string") {
    return { ok: false, diagnostic: "yt-dlp capture did not return an identity record" };
  }

  const records = stdout
    .split("\n")
    .filter((line) => line.startsWith(CAPTURE_IDENTITY_PREFIX));
  if (records.length === 0) {
    return { ok: false, diagnostic: "yt-dlp capture did not return an identity record" };
  }
  if (records.length !== 1) {
    return { ok: false, diagnostic: "yt-dlp capture returned multiple identity records" };
  }

  const record = records[0];
  if (record === undefined) {
    return { ok: false, diagnostic: "yt-dlp capture did not return an identity record" };
  }

  let value: unknown;
  try {
    value = JSON.parse(record.slice(CAPTURE_IDENTITY_PREFIX.length));
  } catch {
    return { ok: false, diagnostic: "yt-dlp capture returned a malformed identity record" };
  }
  if (!isRecord(value)) {
    return { ok: false, diagnostic: "yt-dlp capture returned a malformed identity record" };
  }
  const keys = Object.keys(value).toSorted();
  if (
    keys.length !== 3
    || keys[0] !== "ext"
    || keys[1] !== "extractor"
    || keys[2] !== "id"
  ) {
    return { ok: false, diagnostic: "yt-dlp capture returned a malformed identity record" };
  }
  const extractor = boundedIdentityString(value["extractor"]);
  const id = boundedIdentityString(value["id"]);
  const ext = value["ext"];
  if (extractor === null || id === null || !isSafeYtDlpCaptureExtension(ext)) {
    return { ok: false, diagnostic: "yt-dlp capture returned a malformed identity record" };
  }
  return { ok: true, identity: { extractor, id, ext } };
}

export async function probeWithYtDlp(
  options: ProbeYtDlpOptions,
  dependencies: YtDlpDependencies = defaultDependencies,
): Promise<YtDlpProbeResult> {
  const result = await dependencies.runProcess(buildYtDlpProbeArgv(options), {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxStdoutBytes: PROBE_STDOUT_LIMIT_BYTES,
    maxStderrBytes: TOOL_STDERR_LIMIT_BYTES,
    redactions: [
      options.url,
      ...urlDerivedRedactions(options.url),
      ...(options.browser === undefined ? [] : [options.browser]),
    ],
  });
  if (!result.ok) {
    return {
      ok: false,
      diagnostic: result.diagnostic,
      processReason: result.reason,
    };
  }
  if (result.stdoutTruncated) return { ok: false, diagnostic: "yt-dlp probe exceeded Wrench media's metadata limit" };
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch { return { ok: false, diagnostic: "yt-dlp probe did not return valid JSON" }; }
  const parsed = parseProbeMetadata(value, options.url, authorizationIdentity(options));
  if (parsed.ok || parsed.kind === "unsupported") return parsed;
  return { ok: false, diagnostic: parsed.message };
}

export async function captureWithYtDlp(
  options: CaptureYtDlpOptions,
  dependencies: YtDlpDependencies = defaultDependencies,
): Promise<YtDlpCaptureResult> {
  const result = await dependencies.runProcess(buildYtDlpCaptureArgv(options), {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: CAPTURE_TIMEOUT_MS,
    maxStdoutBytes: CAPTURE_STDOUT_LIMIT_BYTES,
    maxStderrBytes: TOOL_STDERR_LIMIT_BYTES,
    redactions: [
      options.url,
      ...urlDerivedRedactions(options.url),
      ...(options.privateRedactions ?? []),
      ...(options.browser === undefined ? [] : [options.browser]),
    ],
  });
  if (!result.ok) {
    return {
      ok: false,
      diagnostic: result.diagnostic,
      processReason: result.reason,
    };
  }
  if (result.stdoutTruncated) {
    return { ok: false, diagnostic: "yt-dlp capture exceeded Wrench media's identity output limit" };
  }
  return parseYtDlpCaptureIdentity(result.stdout);
}

export async function ytDlpVersion(
  executable: string,
  dependencies: YtDlpDependencies = defaultDependencies,
): Promise<string> {
  const result = await dependencies.runProcess([executable, "--version"], {
    timeoutMs: 15_000,
    maxStdoutBytes: 32 * 1024,
    maxStderrBytes: 32 * 1024,
  });
  if (!result.ok) return "unknown";
  const firstLine = result.stdout.trim().split(/\s+/u)[0];
  return firstLine === undefined || firstLine.length === 0 || firstLine.length > 128 ? "unknown" : firstLine;
}
