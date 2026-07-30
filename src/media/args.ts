import { resolve } from "node:path";

export const USAGE = `usage: wrench media [archive|audio|video|transcript] URL [options]
       wrench doctor [--json]
       wrench transcriber setup --engine whisper-cpp --model FILE [options]
       wrench verify ITEM_DIRECTORY [--json]

commands:
  wrench media URL                 save media, separate audio/video, and get a transcript
  wrench archive URL               explicit form of the default command
  wrench audio URL                 save the source and an audio-only stream-copy derivative
  wrench video URL                 save the source and a video-only stream-copy derivative
  wrench transcript URL            save a provider transcript, or make one locally when configured
  wrench transcriber setup         register an existing local whisper.cpp executable and model
  wrench doctor                    inspect built-in HTTP and external media capabilities
  wrench verify PATH               recompute and verify every artifact recorded in wrench-media.json

capture options:
  --output DIRECTORY       library root (default: WRENCH_MEDIA_HOME or ~/.local/share/wrench/media)
  --lang LANGUAGE          preferred transcript language (default: en)
  --browser SPEC           explicit yt-dlp browser-cookie source
  --auth-context NAME      stable private-access realm (required with browser/config)
  --inherit-yt-dlp-config  opt into ambient yt-dlp configuration and plugins
  --refresh                re-acquire and append only when retained content changes
  --json                   emit a stable JSON record

transcriber setup options:
  --engine whisper-cpp     explicit local engine (currently whisper-cpp)
  --model FILE             existing local whisper.cpp model; never downloaded by setup
  --executable FILE        existing whisper-cli (default: discover it on PATH)
  --replace                replace a different existing transcriber configuration
  --json                   emit a stable JSON record

Wrench media archives material you are authorized to access. It does not bypass DRM or access controls.`;

export type CaptureMode = "archive" | "audio" | "video" | "transcript";

interface CommandBase {
  readonly json: boolean;
}

export type CliCommand =
  | ({ readonly kind: "help" } & CommandBase)
  | ({ readonly kind: "version" } & CommandBase)
  | ({ readonly kind: "doctor" } & CommandBase)
  | ({ readonly kind: "verify"; readonly itemDirectory: string } & CommandBase)
  | ({
      readonly kind: "transcriber-setup";
      readonly engine: "whisper-cpp";
      readonly modelPath: string;
      readonly executablePath?: string;
      readonly replace: boolean;
    } & CommandBase)
  | ({
      readonly kind: "capture";
      readonly mode: CaptureMode;
      readonly url: string;
      readonly outputDirectory?: string;
      readonly language: string;
      readonly browser?: string;
      readonly authContext?: string;
      readonly inheritYtDlpConfig: boolean;
      readonly refresh: boolean;
    } & CommandBase);

export type ParseArgsResult =
  | { readonly ok: true; readonly command: CliCommand }
  | { readonly ok: false; readonly json: boolean; readonly message: string };

const captureModes = new Set<CaptureMode>(["archive", "audio", "video", "transcript"]);
const valueOptions = new Set([
  "--output",
  "--lang",
  "--browser",
  "--auth-context",
  "--engine",
  "--model",
  "--executable",
]);
const booleanOptions = new Set(["--json", "--inherit-yt-dlp-config", "--refresh", "--replace"]);
const transcriberSetupOptions = new Set([
  "--engine",
  "--model",
  "--executable",
  "--replace",
  "--json",
]);

interface ParsedTokens {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, string | true>;
}

function failure(json: boolean, message: string): ParseArgsResult {
  return { ok: false, json, message };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function parseTokens(argv: readonly string[]): ParsedTokens | null {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) return null;
    if (optionsEnded) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "-h" || token === "--help" || token === "-V" || token === "--version") {
      if (options.has(token)) return null;
      options.set(token, true);
      continue;
    }
    if (booleanOptions.has(token)) {
      if (options.has(token)) return null;
      options.set(token, true);
      continue;
    }
    if (!valueOptions.has(token) || options.has(token)) return null;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-") || value.includes("\0")) return null;
    options.set(token, value);
    index += 1;
  }
  return { positionals, options };
}

function hasFlag(tokens: ParsedTokens, name: string): boolean {
  return tokens.options.get(name) === true;
}

function option(tokens: ParsedTokens, name: string): string | undefined {
  const value = tokens.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function parseSourceUrl(value: string): string | null {
  if (value.length === 0 || value.length > 8_192 || hasControlCharacter(value)) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function isLiteralLanguageTag(value: string): boolean {
  const lower = value.toLowerCase();
  return lower !== "all"
    && lower !== "live_chat"
    && /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/u.test(value);
}

export function isValidBrowserSpec(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !hasControlCharacter(value);
}

/** Canonical, non-secret label for one user-declared authorization realm. */
export function normalizeAuthContextName(value: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)
    ? value.toLowerCase()
    : null;
}

function validFilesystemOption(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.includes("\0") && !hasControlCharacter(value);
}

function transcriberSetupCommand(tokens: ParsedTokens): ParseArgsResult {
  const json = hasFlag(tokens, "--json");
  if ([...tokens.options.keys()].some((name) => !transcriberSetupOptions.has(name))) {
    return failure(json, "transcriber setup accepts only --engine, --model, --executable, --replace, and --json");
  }
  const engine = option(tokens, "--engine");
  if (engine !== "whisper-cpp") {
    return failure(json, "transcriber setup requires --engine whisper-cpp");
  }
  const model = option(tokens, "--model");
  if (model === undefined || !validFilesystemOption(model)) {
    return failure(json, "transcriber setup requires a valid --model filesystem path");
  }
  const executable = option(tokens, "--executable");
  if (executable !== undefined && !validFilesystemOption(executable)) {
    return failure(json, "--executable must be a valid filesystem path");
  }
  return {
    ok: true,
    command: {
      kind: "transcriber-setup",
      engine,
      modelPath: resolve(model),
      ...(executable === undefined ? {} : { executablePath: resolve(executable) }),
      replace: hasFlag(tokens, "--replace"),
      json,
    },
  };
}

function captureCommand(tokens: ParsedTokens, mode: CaptureMode, urlValue: string): ParseArgsResult {
  const json = hasFlag(tokens, "--json");
  const url = parseSourceUrl(urlValue);
  if (url === null) return failure(json, "source URL must be HTTP(S) and must not contain credentials");
  const language = option(tokens, "--lang") ?? "en";
  if (!isLiteralLanguageTag(language)) return failure(json, "--lang must be a short literal BCP-47-style language tag");
  const browser = option(tokens, "--browser");
  if (browser !== undefined && !isValidBrowserSpec(browser)) return failure(json, "--browser must be nonempty, control-free, and at most 512 characters");
  const inheritYtDlpConfig = hasFlag(tokens, "--inherit-yt-dlp-config");
  if (browser !== undefined && inheritYtDlpConfig) {
    return failure(json, "choose either --browser or --inherit-yt-dlp-config, not both");
  }
  const rawAuthContext = option(tokens, "--auth-context");
  const authContext = rawAuthContext === undefined ? undefined : normalizeAuthContextName(rawAuthContext);
  if (authContext === null) {
    return failure(json, "--auth-context must be a 1-64 character ASCII name");
  }
  const hasPrivateAccess = browser !== undefined || inheritYtDlpConfig;
  if (hasPrivateAccess && authContext === undefined) {
    return failure(json, "--browser and --inherit-yt-dlp-config require --auth-context");
  }
  if (!hasPrivateAccess && authContext !== undefined) {
    return failure(json, "--auth-context requires --browser or --inherit-yt-dlp-config");
  }
  const output = option(tokens, "--output");
  if (output !== undefined && (output.length === 0 || output.length > 4_096 || output.includes("\0"))) {
    return failure(json, "--output must be a nonempty filesystem path");
  }
  return {
    ok: true,
    command: {
      kind: "capture",
      mode,
      url,
      language,
      ...(output === undefined ? {} : { outputDirectory: resolve(output) }),
      ...(browser === undefined ? {} : { browser }),
      ...(authContext === undefined ? {} : { authContext }),
      inheritYtDlpConfig,
      refresh: hasFlag(tokens, "--refresh"),
      json,
    },
  };
}

export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const tokens = parseTokens(argv);
  const guessedJson = argv.includes("--json");
  if (tokens === null) return failure(guessedJson, "invalid or duplicate option");
  const json = hasFlag(tokens, "--json");
  const wantsHelp = hasFlag(tokens, "-h") || hasFlag(tokens, "--help");
  const wantsVersion = hasFlag(tokens, "-V") || hasFlag(tokens, "--version");
  if (wantsHelp || wantsVersion) {
    if (wantsHelp && wantsVersion) return failure(json, "choose either --help or --version");
    return { ok: true, command: { kind: wantsHelp ? "help" : "version", json } };
  }

  const [first, second, ...rest] = tokens.positionals;
  if (first === undefined) return { ok: true, command: { kind: "help", json } };
  if (first === "doctor") {
    if (second !== undefined || rest.length !== 0 || tokens.options.size > (json ? 1 : 0)) {
      return failure(json, "doctor accepts only --json");
    }
    return { ok: true, command: { kind: "doctor", json } };
  }
  if (first === "verify") {
    if (second === undefined || rest.length !== 0 || tokens.options.size > (json ? 1 : 0)) {
      return failure(json, "verify requires exactly one item directory and accepts only --json");
    }
    if (second.includes("\0") || second.length > 4_096) return failure(json, "invalid item directory");
    return { ok: true, command: { kind: "verify", itemDirectory: resolve(second), json } };
  }
  if (first === "transcriber") {
    if (second !== "setup" || rest.length !== 0) {
      return failure(json, "transcriber requires the setup subcommand");
    }
    return transcriberSetupCommand(tokens);
  }
  if (captureModes.has(first as CaptureMode)) {
    if (second === undefined || rest.length !== 0) return failure(json, `${first} requires exactly one URL`);
    return captureCommand(tokens, first as CaptureMode, second);
  }
  if (rest.length !== 0 || second !== undefined) return failure(json, "default capture accepts exactly one URL");
  return captureCommand(tokens, "archive", first);
}
