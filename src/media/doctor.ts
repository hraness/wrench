import {
  findExecutable,
  redactDiagnostic,
  runProcess,
  type CommandArgv,
  type ExecutableDiscoveryOptions,
  type ProcessResult,
  type RunProcessOptions,
} from "./process";
import {
  loadConfiguredTranscriber,
  type LoadConfiguredTranscriberOptions,
  type LoadConfiguredTranscriberResult,
} from "./transcriber-config";

export const MINIMUM_RECOMMENDED_YT_DLP_VERSION = "2026.07.04";
export const MINIMUM_RECOMMENDED_FFMPEG_VERSION = "7.1.5";

const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
const VERSION_OUTPUT_LIMIT_BYTES = 32 * 1024;

export type DoctorToolName = "yt-dlp" | "ffmpeg" | "ffprobe" | "deno" | "transcriber";
type DoctorExecutableName = Exclude<DoctorToolName, "transcriber">;
export type DoctorCheckStatus = "ok" | "warning" | "missing" | "error" | "optional-missing";

export type DoctorCheck = Readonly<{
  name: DoctorToolName;
  required: boolean;
  status: DoctorCheckStatus;
  executable: string | null;
  version: string | null;
  message: string;
}>;

export type DoctorReport = Readonly<{
  ok: boolean;
  checks: readonly DoctorCheck[];
  warnings: readonly string[];
  errors: readonly string[];
  capabilities: Readonly<{
    /** Built into Wrench media; no external executable is required. */
    directHttp: true;
    acquisition: boolean;
    mediaSeparation: boolean;
    javascriptRuntime: boolean;
    localTranscription: boolean;
  }>;
}>;

export type DoctorOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  extraExecutableDirectories?: readonly string[];
  probeTimeoutMs?: number;
  includeOptional?: boolean;
}>;

export type DoctorDependencies = Readonly<{
  findExecutable: (
    name: DoctorExecutableName,
    options: ExecutableDiscoveryOptions,
  ) => Promise<string | null>;
  runProcess: (argv: CommandArgv, options: RunProcessOptions) => Promise<ProcessResult>;
  loadConfiguredTranscriber: (
    options: LoadConfiguredTranscriberOptions,
  ) => Promise<LoadConfiguredTranscriberResult>;
}>;

type ToolDefinition = Readonly<{
  name: DoctorExecutableName;
  required: boolean;
  probeArguments: readonly string[] | null;
  versionFrom: (output: string) => string | null;
  freshness: (version: string | null) => string | null;
}>;

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "yt-dlp",
    required: true,
    probeArguments: ["--version"],
    versionFrom: parseYtDlpVersion,
    freshness: ytDlpFreshnessWarning,
  },
  {
    name: "ffmpeg",
    required: true,
    probeArguments: ["-version"],
    versionFrom: parseFfmpegVersion,
    freshness: ffmpegFreshnessWarning,
  },
  {
    name: "ffprobe",
    required: true,
    probeArguments: ["-version"],
    versionFrom: parseFfmpegVersion,
    freshness: ffmpegFreshnessWarning,
  },
  {
    name: "deno",
    required: false,
    probeArguments: ["--version"],
    versionFrom: parseDenoVersion,
    freshness: noFreshnessWarning,
  },
] as const;

const defaultDoctorDependencies: DoctorDependencies = {
  findExecutable: (name, options) => findExecutable(name, options),
  runProcess: (argv, options) => runProcess(argv, options),
  loadConfiguredTranscriber: (options) => loadConfiguredTranscriber(options),
};

/** Inspects Wrench media's required tools and optional local-transcription helpers. */
export async function runDoctor(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = defaultDoctorDependencies,
): Promise<DoctorReport> {
  const includeOptional = options.includeOptional ?? true;
  const definitions = TOOL_DEFINITIONS.filter(
    (definition) => definition.required || includeOptional,
  );
  const executableChecks = await Promise.all(
    definitions.map((definition) => inspectTool(definition, options, dependencies)),
  );
  const checks = includeOptional
    ? [...executableChecks, await inspectConfiguredTranscriber(options, dependencies)]
    : executableChecks;
  const warnings = checks
    .filter((check) => check.status === "warning")
    .map((check) => `${check.name}: ${check.message}`);
  const errors = checks
    .filter((check) => check.status === "missing" || check.status === "error")
    .map((check) => `${check.name}: ${check.message}`);
  const statusByName = new Map(checks.map((check) => [check.name, check.status]));
  const available = (name: DoctorToolName): boolean => {
    const status = statusByName.get(name);
    return status === "ok" || status === "warning";
  };

  return {
    ok: errors.length === 0,
    checks,
    warnings,
    errors,
    capabilities: {
      directHttp: true,
      acquisition: available("yt-dlp"),
      mediaSeparation: available("ffmpeg") && available("ffprobe"),
      javascriptRuntime: available("deno"),
      localTranscription: statusByName.get("transcriber") === "ok",
    },
  };
}

/** A compact human rendering; JSON callers should serialize DoctorReport directly. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((check) => {
    const marker = markerFor(check.status);
    const version = check.version === null ? "" : ` ${check.version}`;
    const location = check.executable === null ? "" : ` (${check.executable})`;
    return `${marker} ${check.name}${version}${location} — ${check.message}`;
  });
  lines.push(report.ok ? "Wrench media is ready." : "Wrench media needs the required tools listed above.");
  return `${lines.join("\n")}\n`;
}

/** Parses the release-date form emitted by yt-dlp, including nightly suffixes. */
export function parseYtDlpVersion(output: string): string | null {
  const match = /(?:^|\s)(\d{4})\.(\d{1,2})\.(\d{1,2})(?=$|[.\s+-])/u.exec(output.trim());
  if (match === null) return null;
  const year = parseDecimal(match[1]);
  const month = parseDecimal(match[2]);
  const day = parseDecimal(match[3]);
  if (year === null || month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${String(year).padStart(4, "0")}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

/** Parses standard release and distro-suffixed FFmpeg/ffprobe version banners. */
export function parseFfmpegVersion(output: string): string | null {
  const match = /\bff(?:mpeg|probe)\s+version\s+(?:n)?(\d+(?:\.\d+){0,3})/iu.exec(output);
  return match?.[1] ?? null;
}

export function parseDenoVersion(output: string): string | null {
  const match = /(?:^|\n)deno\s+(\d+(?:\.\d+){1,3})\b/iu.exec(output);
  return match?.[1] ?? null;
}

export function isYtDlpVersionStale(version: string): boolean {
  const parsed = parseDateVersion(version);
  const minimum = parseDateVersion(MINIMUM_RECOMMENDED_YT_DLP_VERSION);
  if (parsed === null || minimum === null) return true;
  return compareNumberTuples(parsed, minimum) < 0;
}

export function isFfmpegVersionStale(version: string): boolean {
  const parsed = parseSemanticVersion(version);
  const minimum = parseSemanticVersion(MINIMUM_RECOMMENDED_FFMPEG_VERSION);
  if (parsed === null || minimum === null) return true;
  return compareNumberTuples(parsed, minimum) < 0;
}

async function inspectTool(
  definition: ToolDefinition,
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  const discoveryOptions: ExecutableDiscoveryOptions = {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.extraExecutableDirectories === undefined
      ? {}
      : { extraDirectories: options.extraExecutableDirectories }),
  };
  let executable: string | null;
  try {
    executable = await dependencies.findExecutable(definition.name, discoveryOptions);
  } catch (error) {
    const message = redactDiagnostic(errorMessage(error), {
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    });
    return {
      name: definition.name,
      required: definition.required,
      status: definition.required ? "error" : "warning",
      executable: null,
      version: null,
      message: `discovery failed: ${message}`,
    };
  }

  if (executable === null) {
    return {
      name: definition.name,
      required: definition.required,
      status: definition.required ? "missing" : "optional-missing",
      executable: null,
      version: null,
      message: definition.required
        ? installMessage(definition.name)
        : optionalMissingMessage(definition.name),
    };
  }

  if (definition.probeArguments === null) {
    return {
      name: definition.name,
      required: definition.required,
      status: "ok",
      executable,
      version: null,
      message: "available",
    };
  }

  const argv: CommandArgv = [executable, ...definition.probeArguments];
  let result: ProcessResult;
  try {
    result = await dependencies.runProcess(argv, {
      ...(options.env === undefined ? {} : { env: options.env }),
      timeoutMs: normalizeProbeTimeout(options.probeTimeoutMs),
      maxStdoutBytes: VERSION_OUTPUT_LIMIT_BYTES,
      maxStderrBytes: VERSION_OUTPUT_LIMIT_BYTES,
    });
  } catch (error) {
    const message = redactDiagnostic(errorMessage(error), {
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    });
    return {
      name: definition.name,
      required: definition.required,
      status: definition.required ? "error" : "warning",
      executable,
      version: null,
      message: `version probe failed: ${message}`,
    };
  }

  if (!result.ok) {
    return {
      name: definition.name,
      required: definition.required,
      status: definition.required ? "error" : "warning",
      executable,
      version: null,
      message: `version probe failed: ${result.diagnostic}`,
    };
  }

  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const version = definition.versionFrom(combinedOutput);
  const freshnessWarning = definition.freshness(version);
  if (freshnessWarning !== null) {
    return {
      name: definition.name,
      required: definition.required,
      status: "warning",
      executable,
      version,
      message: freshnessWarning,
    };
  }

  return {
    name: definition.name,
    required: definition.required,
    status: "ok",
    executable,
    version,
    message: version === null ? "available" : "ready",
  };
}

function ytDlpFreshnessWarning(version: string | null): string | null {
  if (version === null) {
    return `could not parse its version; ${MINIMUM_RECOMMENDED_YT_DLP_VERSION} or newer is recommended`;
  }
  return isYtDlpVersionStale(version)
    ? `version ${version} is stale; update to ${MINIMUM_RECOMMENDED_YT_DLP_VERSION} or newer`
    : null;
}

function ffmpegFreshnessWarning(version: string | null): string | null {
  if (version === null) {
    return `could not parse its version; FFmpeg ${MINIMUM_RECOMMENDED_FFMPEG_VERSION} or newer is recommended`;
  }
  return isFfmpegVersionStale(version)
    ? `version ${version} is stale; update to FFmpeg ${MINIMUM_RECOMMENDED_FFMPEG_VERSION} or newer`
    : null;
}

function noFreshnessWarning(): null {
  return null;
}

function installMessage(name: DoctorToolName): string {
  switch (name) {
    case "yt-dlp":
      return "required executable not found; install or update yt-dlp and ensure it is on PATH";
    case "ffmpeg":
    case "ffprobe":
      return "required executable not found; install FFmpeg and ensure its bin directory is on PATH";
    case "deno":
    case "transcriber":
      return "optional executable not found";
  }
}

function optionalMissingMessage(name: DoctorToolName): string {
  switch (name) {
    case "deno":
      return "not installed; this optional yt-dlp JavaScript runtime is not required";
    case "transcriber":
      return "not configured; run wrench transcriber setup with an existing whisper.cpp model";
    case "yt-dlp":
    case "ffmpeg":
    case "ffprobe":
      return "optional executable not found";
  }
}

async function inspectConfiguredTranscriber(
  options: DoctorOptions,
  dependencies: DoctorDependencies,
): Promise<DoctorCheck> {
  let result: LoadConfiguredTranscriberResult;
  try {
    result = await dependencies.loadConfiguredTranscriber({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
    });
  } catch {
    return {
      name: "transcriber",
      required: false,
      status: "warning",
      executable: null,
      version: null,
      message: "configuration verification failed unexpectedly",
    };
  }
  if (result.kind === "not-configured") {
    return {
      name: "transcriber",
      required: false,
      status: "optional-missing",
      executable: null,
      version: null,
      message: optionalMissingMessage("transcriber"),
    };
  }
  if (result.kind === "invalid") {
    return {
      name: "transcriber",
      required: false,
      status: "warning",
      executable: null,
      version: null,
      message: `configuration is invalid (${result.reason}); rerun transcriber setup with --replace`,
    };
  }
  return {
    name: "transcriber",
    required: false,
    status: "ok",
    executable: null,
    version: result.transcriber.descriptor.profile,
    message: `configured whisper.cpp matches recorded model and native runtime hashes (${String(result.transcriber.descriptor.modelBytes)} model bytes; ${String(result.transcriber.descriptor.runtimeDependencyCount)} runtime ${result.transcriber.descriptor.runtimeDependencyCount === 1 ? "dependency" : "dependencies"})`,
  };
}

function markerFor(status: DoctorCheckStatus): string {
  switch (status) {
    case "ok":
      return "✓";
    case "warning":
      return "!";
    case "missing":
    case "error":
      return "✗";
    case "optional-missing":
      return "·";
  }
}

function normalizeProbeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 0), 2 * 60_000);
}

function parseDateVersion(version: string): readonly [number, number, number] | null {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/u.exec(version);
  if (match === null) return null;
  const year = parseDecimal(match[1]);
  const month = parseDecimal(match[2]);
  const day = parseDecimal(match[3]);
  return year === null || month === null || day === null ? null : [year, month, day];
}

function parseSemanticVersion(version: string): readonly [number, number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(version);
  if (match === null) return null;
  const major = parseDecimal(match[1]);
  const minor = match[2] === undefined ? 0 : parseDecimal(match[2]);
  const patch = match[3] === undefined ? 0 : parseDecimal(match[3]);
  return major === null || minor === null || patch === null ? null : [major, minor, patch];
}

function compareNumberTuples(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseDecimal(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/u.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown diagnostic error";
}
