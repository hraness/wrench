import { homedir } from "node:os";
import { MediaArchiveError, mediaUrl, type MediaArchiveOptions, type MediaArchiveResult } from "./archive";
import { parseArgs, USAGE } from "./args";
import { renderDoctorReport, runDoctor, type DoctorOptions, type DoctorReport } from "./doctor";
import {
  WRENCH_MEDIA_VERSION,
  verifyMediaItem,
  type MediaManifest,
  type VerifyItemResult,
} from "./manifest";
import { redactDiagnostic, sanitizeTerminalText, urlDerivedRedactions } from "./process";
import {
  setupWhisperCppTranscriber,
  WhisperCppTranscriberSetupError,
  type ReadyTranscriber,
  type SetupWhisperCppTranscriberOptions,
} from "./transcriber-config";

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export type MediaCliEnvironment = Readonly<Record<string, string | undefined>>;

export interface MediaCliDependencies {
  readonly mediaUrl: (options: MediaArchiveOptions) => Promise<MediaArchiveResult>;
  readonly runDoctor: (options: DoctorOptions) => Promise<DoctorReport>;
  readonly verifyMediaItem: (itemDirectory: string) => Promise<VerifyItemResult>;
  readonly setupWhisperCppTranscriber: (
    options: SetupWhisperCppTranscriberOptions,
  ) => Promise<ReadyTranscriber>;
}

export interface RunCliOptions {
  readonly io?: CliIo;
  readonly environment?: MediaCliEnvironment;
  readonly homeDirectory?: string;
  readonly signal?: AbortSignal;
  readonly dependencies?: MediaCliDependencies;
}

const processIo: CliIo = {
  stdout: (value) => { void process.stdout.write(value); },
  stderr: (value) => { void process.stderr.write(value); },
};

const defaultDependencies: MediaCliDependencies = {
  mediaUrl: async (options) => await mediaUrl(options),
  runDoctor: async (options) => await runDoctor(options),
  verifyMediaItem: async (itemDirectory) => await verifyMediaItem(itemDirectory),
  setupWhisperCppTranscriber: async (options) => await setupWhisperCppTranscriber(options),
};

const archiveExitCodes: Readonly<Record<MediaArchiveError["code"], number>> = {
  CANCELLED: 130,
  DEPENDENCY_MISSING: 3,
  UNSUPPORTED_SOURCE: 4,
  PROBE_FAILED: 4,
  TRANSCRIPT_UNAVAILABLE: 5,
  CAPTURE_FAILED: 6,
  DERIVATION_FAILED: 7,
  TRANSCRIPTION_FAILED: 7,
  ARCHIVE_CONFLICT: 8,
  ARCHIVE_INVALID: 8,
  BUSY: 9,
  IO_ERROR: 10,
};

function writeJson(io: CliIo, channel: "stdout" | "stderr", value: unknown): void {
  const source = JSON.stringify(value).replace(/[\u007f-\u009f]/gu, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  io[channel](`${source}\n`);
}

function safeDetails(
  details: Readonly<Record<string, unknown>>,
  homeDirectory: string,
  secrets: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const redacted = redactDiagnostic(JSON.stringify(details), { homeDirectory, secrets });
  try {
    const value: unknown = JSON.parse(redacted);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
  } catch {
    return {};
  }
}

function captureSummary(result: MediaArchiveResult): Readonly<Record<string, unknown>> {
  const revision = "revision" in result.manifest
    ? {
        sequence: result.manifest.revision.sequence,
        subjectAssetKey: result.manifest.revision.subjectAssetKey,
        previousAssetKey: result.manifest.revision.previousAssetKey ?? null,
        contentSha256: result.manifest.revision.content.sha256,
      }
    : null;
  return {
    ok: true,
    status: result.status,
    itemDirectory: result.itemDirectory,
    assetKey: result.manifest.assetKey,
    title: result.manifest.source.title ?? null,
    artifactCount: result.manifest.artifacts.length,
    transcript: result.manifest.transcript,
    revision,
    warnings: result.warnings,
  };
}

function humanCaptureSummary(result: MediaArchiveResult): string {
  const titleCandidate = sanitizeTerminalText(
    result.manifest.source.title ?? result.manifest.assetKey,
  );
  const title = titleCandidate.length === 0 ? result.manifest.assetKey : titleCandidate;
  const action = result.status === "created" ? "Saved" : "Already archived";
  const revision = "revision" in result.manifest
    ? ` · revision ${String(result.manifest.revision.sequence)}`
    : "";
  const transcript = humanTranscriptSummary(result.manifest.transcript);
  const warningLines = result.warnings
    .map((warning) => sanitizeTerminalText(warning))
    .filter((warning) => warning.length > 0)
    .map((warning) => `warning: ${warning}\n`)
    .join("");
  return `${action} ${title}${revision}\n${sanitizeTerminalText(result.itemDirectory)}\n${String(result.manifest.artifacts.length)} artifacts · ${transcript}\n${warningLines}`;
}

function humanTranscriptSummary(transcript: MediaManifest["transcript"]): string {
  if (transcript.status === "available") {
    const language = sanitizeTerminalText(transcript.language) || "unknown-language";
    return `${transcript.source} ${language} transcript`;
  }
  switch (transcript.reason) {
    case "provider_has_no_captions":
      return "no provider transcript";
    case "not_requested":
      return "transcript not requested";
    case "transcriber_not_configured":
      return "no transcript · local transcriber not configured";
    case "audio_not_present":
      return "no transcript · audio not present";
    case "no_speech":
      return "no speech detected";
  }
}

function sanitizeHumanReport(value: string): string {
  return value
    .split("\n")
    .map((line) => sanitizeTerminalText(line))
    .join("\n");
}

function sourceLabel(url: string): string {
  try { return new URL(url).hostname; } catch { return "source"; }
}

export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? processIo;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const dependencies = options.dependencies ?? defaultDependencies;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.json) writeJson(io, "stderr", { ok: false, error: { code: "USAGE", message: parsed.message } });
    else io.stderr(`wrench media: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { command } = parsed;
  if (command.kind === "help") {
    if (command.json) writeJson(io, "stdout", { ok: true, usage: USAGE });
    else io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (command.kind === "version") {
    if (command.json) writeJson(io, "stdout", { ok: true, version: WRENCH_MEDIA_VERSION });
    else io.stdout(`wrench media ${WRENCH_MEDIA_VERSION}\n`);
    return 0;
  }
  if (command.kind === "doctor") {
    const report = await dependencies.runDoctor({ env: environment, homeDirectory });
    if (command.json) writeJson(io, report.ok ? "stdout" : "stderr", { ok: report.ok, report });
    else io[report.ok ? "stdout" : "stderr"](sanitizeHumanReport(renderDoctorReport(report)));
    return report.ok ? 0 : 3;
  }
  if (command.kind === "verify") {
    const result = await dependencies.verifyMediaItem(command.itemDirectory);
    if (command.json) writeJson(io, result.ok ? "stdout" : "stderr", { ok: result.ok, verification: result });
    else if (result.ok) io.stdout(`Verified ${sanitizeTerminalText(result.assetKey ?? command.itemDirectory)}: ${String(result.checkedArtifacts)} artifacts\n`);
    else io.stderr(`wrench media: verification failed\n${result.failures.map((failure) => `- ${redactDiagnostic(failure, { homeDirectory })}`).join("\n")}\n`);
    return result.ok ? 0 : 8;
  }
  if (command.kind === "transcriber-setup") {
    try {
      const transcriber = await dependencies.setupWhisperCppTranscriber({
        modelPath: command.modelPath,
        ...(command.executablePath === undefined
          ? {}
          : { executablePath: command.executablePath }),
        replace: command.replace,
        env: environment,
        homeDirectory,
      });
      const configured = {
        adapter: transcriber.descriptor.adapter,
        profile: transcriber.descriptor.profile,
        executableSha256: transcriber.descriptor.executableSha256,
        modelSha256: transcriber.descriptor.modelSha256,
        modelBytes: transcriber.descriptor.modelBytes,
        runtimeProfile: transcriber.descriptor.runtimeProfile,
        runtimeSha256: transcriber.descriptor.runtimeSha256,
        runtimeDependencyCount: transcriber.descriptor.runtimeDependencyCount,
      };
      if (command.json) writeJson(io, "stdout", { ok: true, transcriber: configured });
      else {
        io.stdout(
          `Configured offline whisper.cpp transcription.\n${String(configured.modelBytes)} model bytes · ${String(configured.runtimeDependencyCount)} runtime ${configured.runtimeDependencyCount === 1 ? "dependency" : "dependencies"} · ${configured.profile}\n`,
        );
      }
      return 0;
    } catch (error) {
      const code = error instanceof WhisperCppTranscriberSetupError
        ? error.code
        : "CONFIG_WRITE_FAILED";
      const message = redactDiagnostic(
        error instanceof Error ? error.message : "local transcriber setup failed",
        { homeDirectory },
      );
      if (command.json) {
        writeJson(io, "stderr", {
          ok: false,
          error: { code: `TRANSCRIBER_${code}`, message },
        });
      } else {
        io.stderr(`wrench media: TRANSCRIBER_${code}: ${message}\n`);
      }
      return 3;
    }
  }

  try {
    if (!command.json) io.stderr(`Archiving media from ${sourceLabel(command.url)}…\n`);
    const result = await dependencies.mediaUrl({
      url: command.url,
      mode: command.mode,
      language: command.language,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(command.outputDirectory === undefined ? {} : { libraryDirectory: command.outputDirectory }),
      ...(command.browser === undefined ? {} : { browser: command.browser }),
      ...(command.authContext === undefined ? {} : { authContext: command.authContext }),
      inheritYtDlpConfig: command.inheritYtDlpConfig,
      refresh: command.refresh,
      environment,
      homeDirectory,
    });
    if (command.json) writeJson(io, "stdout", captureSummary(result));
    else io.stdout(humanCaptureSummary(result));
    return 0;
  } catch (error) {
    const secrets = [
      command.url,
      ...urlDerivedRedactions(command.url),
      ...(command.browser === undefined ? [] : [command.browser]),
      ...(command.authContext === undefined ? [] : [command.authContext]),
    ];
    if (error instanceof MediaArchiveError) {
      const message = redactDiagnostic(error.message, { homeDirectory, secrets });
      if (command.json) {
        writeJson(io, "stderr", { ok: false, error: { code: error.code, message, details: safeDetails(error.details, homeDirectory, secrets) } });
      } else {
        io.stderr(`wrench media: ${error.code}: ${message}\n`);
        const staging = error.details["stagingDirectory"];
        if (typeof staging === "string") {
          io.stderr(`diagnostic staging: ${redactDiagnostic(staging, { homeDirectory, secrets })}\n`);
        }
      }
      return archiveExitCodes[error.code];
    }
    const message = redactDiagnostic(error instanceof Error ? error.message : "unexpected failure", { homeDirectory, secrets });
    if (command.json) writeJson(io, "stderr", { ok: false, error: { code: "INTERNAL", message } });
    else io.stderr(`wrench media: INTERNAL: ${message}\n`);
    return 1;
  }
}
