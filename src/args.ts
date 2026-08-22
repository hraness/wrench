import { cookieSources, type CookieSource } from "@hraness/kb/clip/args";
import { isAbsolute, resolve } from "node:path";
import {
  normalizeAuthSubject,
  normalizeOAuthScopes,
  type LinkedDeviceProvider,
  type OAuthProvider,
} from "./auth";
import type { HarContentMode } from "./derive";
import { platformSurfaceIds, type PlatformSurfaceId } from "./platform-catalog";
import {
  isProviderPluginId,
  isProviderPluginOperationName,
  isProviderPluginSurfaceId,
  type ProviderPluginSurfaceId,
} from "./provider-plugin-identifiers";

export type WrenchArguments =
  | { readonly command: "help" }
  | { readonly command: "clip"; readonly arguments: readonly string[] }
  | { readonly command: "read"; readonly arguments: readonly string[] }
  | { readonly command: "media"; readonly arguments: readonly string[] }
  | {
      readonly command: "beeper-export-message-like-me";
      readonly authId: string;
      readonly output: string;
      readonly limitChats?: number;
      readonly limitMessages?: number;
      readonly maxParticipants?: number;
      readonly json: boolean;
    }
  | { readonly command: "doctor"; readonly json: boolean }
  | { readonly command: "capabilities"; readonly adapterId?: string; readonly json: boolean }
  | { readonly command: "plugin-list"; readonly json: boolean }
  | { readonly command: "plugin-show"; readonly id: string; readonly json: boolean }
  | { readonly command: "platforms"; readonly surfaceId?: PlatformSurfaceId; readonly json: boolean }
  | { readonly command: "thread-split"; readonly surfaceId: PlatformSurfaceId; readonly textSource: string; readonly json: boolean }
  | {
      readonly command: "thread-publish";
      readonly surfaceId: PlatformSurfaceId;
      readonly adapterId: string;
      readonly textSource: string;
      readonly authId: string;
      readonly preview: boolean;
      readonly headed: boolean;
      readonly json: boolean;
    }
  | { readonly command: "auth-list"; readonly json: boolean }
  | {
      readonly command: "auth-login";
      readonly id: string;
      readonly provider: "gmail";
      readonly clientFile: string;
      readonly openBrowser: boolean;
      readonly force: boolean;
      readonly json: boolean;
    }
  | { readonly command: "auth-bind"; readonly id: string; readonly site: ProviderPluginSurfaceId; readonly force: boolean; readonly json: boolean }
  | { readonly command: "auth-pair"; readonly id: string; readonly phone?: string }
  | { readonly command: "auth-sync"; readonly id: string; readonly once: true; readonly json: boolean }
  | {
      readonly command: "auth-add";
      readonly id: string;
      readonly cookieSource?: CookieSource;
      readonly cookieProfile?: string;
      readonly cookiesFile?: string;
      readonly browserProfile?: string;
      readonly browserExecutable?: string;
      readonly oauthProvider?: OAuthProvider;
      readonly tokenFile?: string;
      readonly scopes?: readonly string[];
      readonly linkedDeviceProvider?: LinkedDeviceProvider;
      readonly deviceStore?: string;
      readonly subject?: string;
      readonly trustProfileEgress: boolean;
      readonly force: boolean;
    }
  | { readonly command: "auth-remove"; readonly id: string; readonly yes: boolean }
  | {
      readonly command: "adapter-init";
      readonly id: string;
      readonly target:
        | { readonly kind: "origin"; readonly origin: string }
        | { readonly kind: "platform"; readonly surfaceId: PlatformSurfaceId };
      readonly output: string;
      readonly force: boolean;
    }
  | {
      readonly command: "plugin-scaffold";
      readonly site: string;
      readonly displayName: string;
      readonly origin: string;
      readonly operation: string;
      readonly risk: "R1" | "R2" | "R3";
      readonly evidence: string;
      readonly candidate: number;
      readonly output: string;
      readonly json: boolean;
    }
  | {
      readonly command: "plugin-init";
      readonly id: string;
      readonly displayName: string;
      readonly surfaceId: string;
      readonly origin: string;
      readonly operation: string;
      readonly transport:
        | "provider-api"
        | "web-session-api"
        | "linked-device";
      readonly requiredScopeSets?: readonly (readonly string[])[];
      readonly coverage?: readonly string[];
      readonly output: string;
      readonly json: boolean;
    }
  | { readonly command: "plugin-check"; readonly path: string; readonly json: boolean }
  | {
      readonly command: "plugin-test";
      readonly path: string;
      readonly trustCode: boolean;
      readonly json: boolean;
    }
  | {
      readonly command: "plugin-pack";
      readonly path: string;
      readonly output: string;
      readonly json: boolean;
    }
  | {
      readonly command: "plugin-install";
      readonly path: string;
      readonly trustCode: boolean;
      readonly expectedCurrent?: string;
      readonly json: boolean;
    }
  | { readonly command: "plugin-doctor"; readonly json: boolean }
  | {
      readonly command: "plugin-disable";
      readonly id: string;
      readonly expectedCurrent?: string;
      readonly json: boolean;
    }
  | {
      readonly command: "plugin-remove";
      readonly id: string;
      readonly expectedCurrent?: string;
      readonly yes: boolean;
      readonly json: boolean;
    }
  | { readonly command: "adapter-validate"; readonly path: string; readonly json: boolean }
  | { readonly command: "adapter-sync-bundled"; readonly json: boolean }
  | {
      readonly command: "adapter-install";
      readonly path: string;
      readonly upgradeFrom?: readonly string[];
      readonly force: boolean;
    }
  | { readonly command: "adapter-remove"; readonly id: string; readonly yes: boolean }
  | {
      readonly command: "derive-start";
      readonly adapterId: string;
      readonly url: string;
      readonly authId: string;
      readonly allowRemoteActions: boolean;
      readonly contentMode: HarContentMode;
      readonly browserDomains: readonly string[];
      readonly fixtureSources: readonly string[];
      readonly headed: boolean;
    }
  | { readonly command: "derive-browser"; readonly id: string; readonly browserArguments: readonly string[]; readonly json: boolean }
  | { readonly command: "derive-list"; readonly json: boolean }
  | {
      readonly command: "derive-review";
      readonly id: string;
      readonly selection:
        | { readonly kind: "list"; readonly offset: number; readonly limit: number }
        | { readonly kind: "entry"; readonly entryIndex: number; readonly fixtures: boolean };
      readonly json: boolean;
    }
  | {
      readonly command: "derive-finish";
      readonly id: string;
      readonly output: string;
      readonly surfaceId?: PlatformSurfaceId;
      readonly force: boolean;
      readonly json: boolean;
    }
  | { readonly command: "derive-discard"; readonly id: string; readonly yes: boolean }
  | {
      readonly command: "derive-analyze";
      readonly har: string;
      readonly adapterId: string;
      readonly origin: string;
      readonly output: string;
      readonly surfaceId?: PlatformSurfaceId;
      readonly force: boolean;
      readonly json: boolean;
    }
  | {
      readonly command: "invoke";
      readonly adapterId: string;
      readonly operationId: string;
      readonly inputSource: string;
      readonly authId?: string;
      readonly duplicateRiskOf: readonly string[];
      readonly preview: boolean;
      readonly cacheOnly: boolean;
      readonly projectionIdentityOnly: boolean;
      readonly headed: boolean;
      readonly json: boolean;
    }
  | {
      readonly command: "omni-read";
      readonly inputSource: string;
      readonly cacheOnly: boolean;
      readonly identityOnly: boolean;
      readonly fromExactCache: boolean;
      readonly headed: boolean;
      readonly json: boolean;
    }
  | {
      readonly command: "confirm";
      readonly digest: string;
      readonly headed: boolean;
      readonly json: boolean;
    }
  | { readonly command: "runs-show"; readonly runId: string; readonly json: boolean }
  | { readonly command: "runs-list"; readonly json: boolean }
  | { readonly command: "runs-reconcile"; readonly runId: string; readonly inputSource?: string; readonly json: boolean }
  | { readonly command: "plans-list"; readonly json: boolean }
  | { readonly command: "plans-cancel"; readonly digest: string; readonly yes: boolean };

export type ParseWrenchResult =
  | { readonly ok: true; readonly value: WrenchArguments }
  | { readonly ok: false; readonly message: string };

type ParseWrenchFailure = Extract<ParseWrenchResult, { readonly ok: false }>;

function validId(value: string, label: string): string | null {
  return /^[a-z][a-z0-9-]{0,47}$/u.test(value) ? null : `${label} must be lowercase kebab-case`;
}

function validPluginId(value: string): string | null {
  return isProviderPluginId(value)
    ? null
    : "plugin ID must be lowercase kebab-case with at most 63 characters";
}

function validSourcePluginSiteId(value: string): string | null {
  return value.length <= 59 && isProviderPluginSurfaceId(value)
    ? null
    : "source plugin site ID must be lowercase kebab-case with at most 59 characters";
}

function validOperation(value: string): string | null {
  return isProviderPluginOperationName(value)
    ? null
    : "operation ID must be a bounded dotted semantic capability with kebab-case segments, such as direct-messaging.send";
}

function validRunId(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? null
    : "run ID must be a lowercase UUID";
}

function duplicateRiskRunIds(
  values: readonly string[],
): ParseWrenchFailure | readonly string[] {
  if (values.length > 1) {
    return {
      ok: false,
      message: "duplicate-tolerant intent v1 accepts exactly one --duplicate-risk-of source run",
    };
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (validRunId(value) !== null) {
      return { ok: false, message: "--duplicate-risk-of must name a lowercase UUID run ID" };
    }
    if (seen.has(value)) {
      return { ok: false, message: "--duplicate-risk-of must not name the same run more than once" };
    }
    seen.add(value);
  }
  return Object.freeze([...values].sort());
}

function knownPlatformSurface(value: string): PlatformSurfaceId | null {
  return platformSurfaceIds.find((surfaceId) => surfaceId === value) ?? null;
}

function optionalPlatformSurface(
  raw: readonly string[],
  label: string,
): ParseWrenchFailure | { readonly surfaceId?: PlatformSurfaceId; readonly json: boolean } {
  const positional = raw.filter((argument) => !argument.startsWith("--"));
  const options = raw.filter((argument) => argument.startsWith("--"));
  if (positional.length > 1 || options.some((argument) => argument !== "--json") || options.length > 1) {
    return { ok: false, message: `${label} accepts one optional surface ID and --json` };
  }
  const requested = positional[0];
  if (requested === undefined) return { json: options.includes("--json") };
  const surfaceId = knownPlatformSurface(requested);
  if (surfaceId === null) return { ok: false, message: `unknown platform surface: ${requested}; run 'wrench platforms' to list reviewed surfaces` };
  return { surfaceId, json: options.includes("--json") };
}

type ParsedOptions = {
  readonly values: Readonly<Record<string, string>>;
  readonly repeatedValues: Readonly<Record<string, readonly string[]>>;
  readonly booleans: ReadonlySet<string>;
};
type OptionValuesResult = ParseWrenchFailure | ParsedOptions;

function optionValues(
  raw: readonly string[],
  valueNames: readonly string[],
  booleanNames: readonly string[],
  repeatedValueNames: readonly string[] = [],
): OptionValuesResult {
  const allowedValues = new Set(valueNames);
  const allowedRepeatedValues = new Set(repeatedValueNames);
  const allowedBooleans = new Set(booleanNames);
  const values: Record<string, string> = {};
  const repeatedValues: Record<string, string[]> = {};
  const booleans = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index];
    if (argument === undefined) continue;
    if (allowedBooleans.has(argument)) {
      if (booleans.has(argument)) return { ok: false, message: `${argument} was provided more than once` };
      booleans.add(argument);
      continue;
    }
    if (!allowedValues.has(argument) && !allowedRepeatedValues.has(argument)) {
      return { ok: false, message: `unknown option: ${argument}` };
    }
    const value = raw[index + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `${argument} requires a value` };
    if (allowedRepeatedValues.has(argument)) {
      (repeatedValues[argument] ??= []).push(value);
    } else {
      if (values[argument] !== undefined) return { ok: false, message: `${argument} was provided more than once` };
      values[argument] = value;
    }
    index += 1;
  }
  return { values, repeatedValues, booleans };
}

function isFailure(value: OptionValuesResult): value is ParseWrenchFailure {
  return "ok" in value && value.ok === false;
}

function simpleJsonOptions(raw: readonly string[], label: string): ParseWrenchResult | boolean {
  if (raw.some((argument) => argument !== "--json") || raw.filter((argument) => argument === "--json").length > 1) {
    return { ok: false, message: `${label} accepts only --json` };
  }
  return raw.includes("--json");
}

function optionalPositiveInteger(
  value: string | undefined,
  label: string,
  maximum: number,
): ParseWrenchFailure | number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return { ok: false, message: `${label} must be a positive integer` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return {
      ok: false,
      message: `${label} must not exceed ${String(maximum)}`,
    };
  }
  return parsed;
}

function parsePluginScaffoldArguments(
  raw: readonly string[],
  label: "plugin scaffold" | "adapter scaffold",
): ParseWrenchResult {
  const parsed = optionValues(
    raw,
    [
      "--site",
      "--display-name",
      "--origin",
      "--operation",
      "--risk",
      "--evidence",
      "--candidate",
      "--output",
    ],
    ["--json"],
  );
  if (isFailure(parsed)) return parsed;
  const site = parsed.values["--site"];
  const displayName = parsed.values["--display-name"];
  const origin = parsed.values["--origin"];
  const operation = parsed.values["--operation"];
  const risk = parsed.values["--risk"];
  const evidence = parsed.values["--evidence"];
  const candidateText = parsed.values["--candidate"];
  const output = parsed.values["--output"];
  if (
    site === undefined
    || displayName === undefined
    || origin === undefined
    || operation === undefined
    || risk === undefined
    || evidence === undefined
    || candidateText === undefined
    || output === undefined
  ) {
    return {
      ok: false,
      message:
        `${label} requires --site, --display-name, --origin, --operation, --risk, --evidence, --candidate, and --output`,
    };
  }
  const siteIssue = validSourcePluginSiteId(site);
  if (siteIssue !== null) return { ok: false, message: siteIssue };
  const operationIssue = validOperation(operation);
  if (operationIssue !== null) return { ok: false, message: operationIssue };
  if (risk !== "R1" && risk !== "R2" && risk !== "R3") {
    return { ok: false, message: `${label} --risk must be R1, R2, or R3` };
  }
  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(candidateText)) {
    return { ok: false, message: `${label} --candidate must be a zero-based integer` };
  }
  return {
    ok: true,
    value: {
      command: "plugin-scaffold",
      site,
      displayName,
      origin,
      operation,
      risk,
      evidence,
      candidate: Number.parseInt(candidateText, 10),
      output,
      json: parsed.booleans.has("--json"),
    },
  };
}

function commaList(
  value: string,
  label: string,
): ParseWrenchFailure | readonly string[] {
  const values = value.split(",").map((item) => item.trim());
  if (
    values.length < 1
    || values.length > 64
    || values.some((item) =>
      item.length < 1
      || item.length > 256
      || /[\0\r\n]/u.test(item))
    || new Set(values).size !== values.length
  ) {
    return {
      ok: false,
      message: `${label} must be a comma-separated list of unique bounded values`,
    };
  }
  return Object.freeze(values);
}

function parsePluginInitArguments(
  raw: readonly string[],
): ParseWrenchResult {
  const id = raw[0];
  if (id === undefined || id.startsWith("--")) {
    return { ok: false, message: "plugin init requires a plugin ID" };
  }
  const idIssue = validPluginId(id);
  if (idIssue !== null) return { ok: false, message: idIssue };
  const parsed = optionValues(
    raw.slice(1),
    [
      "--display-name",
      "--surface",
      "--origin",
      "--operation",
      "--transport",
      "--coverage",
      "--output",
    ],
    ["--json"],
    ["--scope-set"],
  );
  if (isFailure(parsed)) return parsed;
  const displayName = parsed.values["--display-name"];
  const surfaceId = parsed.values["--surface"];
  const origin = parsed.values["--origin"];
  const operation = parsed.values["--operation"];
  const output = parsed.values["--output"];
  if (
    displayName === undefined
    || surfaceId === undefined
    || origin === undefined
    || operation === undefined
    || output === undefined
  ) {
    return {
      ok: false,
      message:
        "plugin init requires --display-name, --surface, --origin, --operation, and --output",
    };
  }
  if (!isProviderPluginSurfaceId(surfaceId)) {
    return {
      ok: false,
      message: "plugin surface ID must be bounded lowercase kebab-case",
    };
  }
  const operationIssue = validOperation(operation);
  if (operationIssue !== null) return { ok: false, message: operationIssue };
  const transportValue = parsed.values["--transport"]
    ?? "web-session-api";
  if (
    transportValue !== "provider-api"
    && transportValue !== "web-session-api"
    && transportValue !== "linked-device"
  ) {
    return {
      ok: false,
      message:
        "plugin init --transport must be provider-api, web-session-api, or linked-device",
    };
  }
  const rawScopeSets = parsed.repeatedValues["--scope-set"] ?? [];
  const coverageValue = parsed.values["--coverage"];
  if (transportValue !== "provider-api") {
    if (rawScopeSets.length > 0 || coverageValue !== undefined) {
      return {
        ok: false,
        message:
          "plugin init accepts --scope-set and --coverage only for provider-api",
      };
    }
    return {
      ok: true,
      value: {
        command: "plugin-init",
        id,
        displayName,
        surfaceId,
        origin,
        operation,
        transport: transportValue,
        output,
        json: parsed.booleans.has("--json"),
      },
    };
  }
  if (rawScopeSets.length < 1 || coverageValue === undefined) {
    return {
      ok: false,
      message:
        "provider-api plugin init requires --scope-set and --coverage",
    };
  }
  const requiredScopeSets: (readonly string[])[] = [];
  for (const [index, rawScopeSet] of rawScopeSets.entries()) {
    const scopeSet = commaList(
      rawScopeSet,
      `plugin init --scope-set ${index + 1}`,
    );
    if ("ok" in scopeSet) return scopeSet;
    requiredScopeSets.push(scopeSet);
  }
  const coverage = commaList(coverageValue, "plugin init --coverage");
  if ("ok" in coverage) return coverage;
  return {
    ok: true,
    value: {
      command: "plugin-init",
      id,
      displayName,
      surfaceId,
      origin,
      operation,
      transport: transportValue,
      requiredScopeSets: Object.freeze(requiredScopeSets),
      coverage,
      output,
      json: parsed.booleans.has("--json"),
    },
  };
}

function validExpectedPluginDigest(
  value: string | undefined,
): ParseWrenchFailure | string | undefined {
  if (value === undefined || /^[a-f0-9]{64}$/u.test(value)) return value;
  return {
    ok: false,
    message: "--expected-current must be a 64-character lowercase SHA-256 digest",
  };
}

export function parseWrenchArguments(raw: readonly string[]): ParseWrenchResult {
  if (raw.length === 0) {
    return { ok: true, value: { command: "help" } };
  }
  if (raw[0] === "help" || raw[0] === "--help" || raw[0] === "-h") {
    if (raw.length > 1) return { ok: false, message: "help accepts no arguments" };
    return { ok: true, value: { command: "help" } };
  }
  const first = raw[0] ?? "";
  if (/^https?:\/\//iu.test(first)) return { ok: true, value: { command: "clip", arguments: raw } };
  if (first === "clip" || first === "capture") return { ok: true, value: { command: "clip", arguments: raw.slice(1) } };
  if (first === "read" || first === "inspect") return { ok: true, value: { command: "read", arguments: raw.slice(1) } };
  if (first === "media") {
    const mediaArguments = raw.slice(1);
    const mediaMode = mediaArguments[0];
    return {
      ok: true,
      value: {
        command: "media",
        arguments: mediaMode === "archive" || mediaMode === "audio" || mediaMode === "video" || mediaMode === "transcript"
          ? mediaArguments
          : ["archive", ...mediaArguments],
      },
    };
  }
  if (
    first === "archive"
    || first === "audio"
    || first === "video"
    || first === "transcript"
    || first === "verify"
    || first === "transcriber"
  ) {
    return { ok: true, value: { command: "media", arguments: raw } };
  }
  if (first === "beeper") {
    if (raw[1] !== "export-message-like-me") {
      return {
        ok: false,
        message: "beeper requires export-message-like-me",
      };
    }
    const parsed = optionValues(
      raw.slice(2),
      [
        "--auth",
        "--output",
        "--limit-chats",
        "--limit-messages",
        "--max-participants",
      ],
      ["--json"],
    );
    if (isFailure(parsed)) return parsed;
    const authId = parsed.values["--auth"];
    const output = parsed.values["--output"];
    if (authId === undefined || validId(authId, "auth ID") !== null) {
      return {
        ok: false,
        message: "beeper export-message-like-me requires --auth <lowercase-kebab-id>",
      };
    }
    if (
      output === undefined
      || !isAbsolute(output)
      || resolve(output) !== output
      || Buffer.byteLength(output, "utf8") > 4_096
      || /[\0\r\n]/u.test(output)
    ) {
      return {
        ok: false,
        message: "beeper export-message-like-me requires --output <normalized-absolute-directory>",
      };
    }
    const limitChats = optionalPositiveInteger(
      parsed.values["--limit-chats"],
      "--limit-chats",
      100_000,
    );
    if (typeof limitChats === "object") return limitChats;
    const limitMessages = optionalPositiveInteger(
      parsed.values["--limit-messages"],
      "--limit-messages",
      1_000_000,
    );
    if (typeof limitMessages === "object") return limitMessages;
    const maxParticipants = optionalPositiveInteger(
      parsed.values["--max-participants"],
      "--max-participants",
      2_000,
    );
    if (typeof maxParticipants === "object") return maxParticipants;
    return {
      ok: true,
      value: {
        command: "beeper-export-message-like-me",
        authId,
        output,
        ...(limitChats === undefined ? {} : { limitChats }),
        ...(limitMessages === undefined ? {} : { limitMessages }),
        ...(maxParticipants === undefined ? {} : { maxParticipants }),
        json: parsed.booleans.has("--json"),
      },
    };
  }
  if (first === "run") return parseWrenchArguments(["invoke", ...raw.slice(1)]);
  if (first === "doctor") {
    const json = simpleJsonOptions(raw.slice(1), "doctor");
    return typeof json === "boolean" ? { ok: true, value: { command: "doctor", json } } : json;
  }
  if (first === "capabilities") {
    const positional = raw.slice(1).filter((argument) => !argument.startsWith("--"));
    const options = raw.slice(1).filter((argument) => argument.startsWith("--"));
    if (
      positional.length > 1
      || options.some((argument) => argument !== "--json")
      || options.length > 1
    ) {
      return { ok: false, message: "capabilities accepts one optional adapter ID and --json" };
    }
    return { ok: true, value: { command: "capabilities", ...(positional[0] === undefined ? {} : { adapterId: positional[0] }), json: options.includes("--json") } };
  }
  if (first === "plugin" || first === "plugins") {
    const subcommand = raw[1];
    if (subcommand === "list") {
      const json = simpleJsonOptions(raw.slice(2), "plugin list");
      return typeof json === "boolean"
        ? { ok: true, value: { command: "plugin-list", json } }
        : json;
    }
    if (subcommand === "show") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "plugin show requires a plugin ID" };
      const issue = validPluginId(id);
      if (issue !== null) return { ok: false, message: issue };
      const json = simpleJsonOptions(raw.slice(3), "plugin show");
      return typeof json === "boolean"
        ? { ok: true, value: { command: "plugin-show", id, json } }
        : json;
    }
    if (subcommand === "scaffold") {
      return parsePluginScaffoldArguments(raw.slice(2), "plugin scaffold");
    }
    if (subcommand === "init") {
      return parsePluginInitArguments(raw.slice(2));
    }
    if (subcommand === "check") {
      const path = raw[2];
      if (path === undefined || path.startsWith("--")) {
        return { ok: false, message: "plugin check requires a plugin directory" };
      }
      const json = simpleJsonOptions(raw.slice(3), "plugin check");
      return typeof json === "boolean"
        ? { ok: true, value: { command: "plugin-check", path, json } }
        : json;
    }
    if (subcommand === "test") {
      const path = raw[2];
      if (path === undefined || path.startsWith("--")) {
        return { ok: false, message: "plugin test requires a portable plugin directory" };
      }
      const parsed = optionValues(
        raw.slice(3),
        [],
        ["--trust-code", "--json"],
      );
      if (isFailure(parsed)) return parsed;
      return {
        ok: true,
        value: {
          command: "plugin-test",
          path,
          trustCode: parsed.booleans.has("--trust-code"),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    if (subcommand === "pack") {
      const path = raw[2];
      if (path === undefined || path.startsWith("--")) {
        return { ok: false, message: "plugin pack requires a portable plugin source directory" };
      }
      const parsed = optionValues(
        raw.slice(3),
        ["--output"],
        ["--json"],
      );
      if (isFailure(parsed)) return parsed;
      const output = parsed.values["--output"];
      return output === undefined
        ? { ok: false, message: "plugin pack requires --output" }
        : {
            ok: true,
            value: {
              command: "plugin-pack",
              path,
              output,
              json: parsed.booleans.has("--json"),
            },
          };
    }
    if (subcommand === "install") {
      const path = raw[2];
      if (path === undefined || path.startsWith("--")) {
        return { ok: false, message: "plugin install requires a portable plugin package directory" };
      }
      const parsed = optionValues(
        raw.slice(3),
        ["--expected-current"],
        ["--trust-code", "--json"],
      );
      if (isFailure(parsed)) return parsed;
      const expectedCurrent = validExpectedPluginDigest(
        parsed.values["--expected-current"],
      );
      if (typeof expectedCurrent === "object") return expectedCurrent;
      return {
        ok: true,
        value: {
          command: "plugin-install",
          path,
          trustCode: parsed.booleans.has("--trust-code"),
          ...(expectedCurrent === undefined ? {} : { expectedCurrent }),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    if (subcommand === "doctor") {
      const json = simpleJsonOptions(raw.slice(2), "plugin doctor");
      return typeof json === "boolean"
        ? { ok: true, value: { command: "plugin-doctor", json } }
        : json;
    }
    if (subcommand === "disable" || subcommand === "remove") {
      const id = raw[2];
      if (id === undefined || id.startsWith("--")) {
        return {
          ok: false,
          message: `plugin ${subcommand} requires a plugin ID`,
        };
      }
      const issue = validPluginId(id);
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(
        raw.slice(3),
        ["--expected-current"],
        subcommand === "remove" ? ["--yes", "--json"] : ["--json"],
      );
      if (isFailure(parsed)) return parsed;
      const expectedCurrent = validExpectedPluginDigest(
        parsed.values["--expected-current"],
      );
      if (typeof expectedCurrent === "object") return expectedCurrent;
      return subcommand === "disable"
        ? {
            ok: true,
            value: {
              command: "plugin-disable",
              id,
              ...(expectedCurrent === undefined ? {} : { expectedCurrent }),
              json: parsed.booleans.has("--json"),
            },
          }
        : {
            ok: true,
            value: {
              command: "plugin-remove",
              id,
              ...(expectedCurrent === undefined ? {} : { expectedCurrent }),
              yes: parsed.booleans.has("--yes"),
              json: parsed.booleans.has("--json"),
            },
          };
    }
    return {
      ok: false,
      message:
        "plugin requires list, show, scaffold, init, check, test, pack, install, doctor, disable, or remove",
    };
  }
  if (first === "platforms") {
    const selected = optionalPlatformSurface(raw.slice(1), "platforms");
    return "ok" in selected
      ? selected
      : {
          ok: true,
          value: {
            command: "platforms",
            ...(selected.surfaceId === undefined ? {} : { surfaceId: selected.surfaceId }),
            json: selected.json,
          },
        };
  }
  if (first === "thread") {
    if (raw[1] !== "split" && raw[1] !== "publish") return { ok: false, message: "thread requires split or publish" };
    const requested = raw[2];
    if (requested === undefined) return { ok: false, message: `thread ${raw[1]} requires a platform surface ID` };
    const surfaceId = knownPlatformSurface(requested);
    if (surfaceId === null) return { ok: false, message: `unknown platform surface: ${requested}; run 'wrench platforms' to list reviewed surfaces` };
    const publishing = raw[1] === "publish";
    const parsed = optionValues(
      raw.slice(3),
      publishing ? ["--adapter", "--text", "--auth"] : ["--text"],
      publishing ? ["--preview", "--headed", "--json"] : ["--json"],
    );
    if (isFailure(parsed)) return parsed;
    const textSource = parsed.values["--text"];
    if (textSource === undefined) return { ok: false, message: `thread ${raw[1]} requires --text <inline|@file|->` };
    if (publishing) {
      const adapterId = parsed.values["--adapter"];
      const authId = parsed.values["--auth"];
      if (adapterId === undefined || validId(adapterId, "adapter ID") !== null) {
        return { ok: false, message: "thread publish requires --adapter <lowercase-kebab-id>" };
      }
      if (authId === undefined || validId(authId, "auth ID") !== null) {
        return { ok: false, message: "thread publish requires --auth <lowercase-kebab-id>" };
      }
      return {
        ok: true,
        value: {
          command: "thread-publish",
          surfaceId,
          adapterId,
          textSource,
          authId,
          preview: parsed.booleans.has("--preview"),
          headed: parsed.booleans.has("--headed"),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    return {
      ok: true,
      value: {
        command: "thread-split",
        surfaceId,
        textSource,
        json: parsed.booleans.has("--json"),
      },
    };
  }
  if (first === "auth") {
    const subcommand = raw[1];
    if (subcommand === "list") {
      const json = simpleJsonOptions(raw.slice(2), "auth list");
      return typeof json === "boolean" ? { ok: true, value: { command: "auth-list", json } } : json;
    }
    if (subcommand === "login") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "auth login requires an ID" };
      const issue = validId(id, "auth ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(
        raw.slice(3),
        ["--provider", "--client-file"],
        ["--no-open", "--force", "--json"],
      );
      if (isFailure(parsed)) return parsed;
      if (
        parsed.values["--provider"] !== undefined
        && parsed.values["--provider"] !== "gmail"
      ) {
        return { ok: false, message: "auth login supports only --provider gmail" };
      }
      const clientFile = parsed.values["--client-file"];
      if (clientFile === undefined || clientFile.length > 4_096) {
        return { ok: false, message: "auth login requires --client-file <downloaded-desktop-client.json>" };
      }
      return {
        ok: true,
        value: {
          command: "auth-login",
          id,
          provider: "gmail",
          clientFile,
          openBrowser: !parsed.booleans.has("--no-open"),
          force: parsed.booleans.has("--force"),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    if (subcommand === "add") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "auth add requires an ID" };
      const issue = validId(id, "auth ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(
        raw.slice(3),
        [
          "--cookie-source",
          "--cookie-profile",
          "--cookies-file",
          "--browser-profile",
          "--browser-executable",
          "--oauth-provider",
          "--token-file",
          "--scopes",
          "--linked-device",
          "--device-store",
          "--subject",
        ],
        ["--trust-profile-egress", "--force"],
      );
      if (isFailure(parsed)) return parsed;
      const source = parsed.values["--cookie-source"];
      if (source !== undefined && !cookieSources.includes(source as CookieSource)) return { ok: false, message: `--cookie-source must be one of ${cookieSources.join(", ")}` };
      const cookiesFile = parsed.values["--cookies-file"];
      const browserProfile = parsed.values["--browser-profile"];
      const browserExecutable = parsed.values["--browser-executable"];
      const oauthProvider = parsed.values["--oauth-provider"];
      const tokenFile = parsed.values["--token-file"];
      const rawScopes = parsed.values["--scopes"];
      const linkedDeviceProvider = parsed.values["--linked-device"];
      const deviceStore = parsed.values["--device-store"];
      const subject = parsed.values["--subject"];
      if (subject !== undefined) {
        try {
          normalizeAuthSubject(subject);
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : "auth locator subject is invalid" };
        }
      }
      const hasOAuthOption = oauthProvider !== undefined || tokenFile !== undefined || rawScopes !== undefined;
      const hasLinkedDeviceOption = linkedDeviceProvider !== undefined || deviceStore !== undefined;
      if (hasOAuthOption && hasLinkedDeviceOption) {
        return { ok: false, message: "linked-device and OAuth auth options cannot be combined" };
      }
      if (hasLinkedDeviceOption) {
        if (
          source !== undefined
          || parsed.values["--cookie-profile"] !== undefined
          || cookiesFile !== undefined
          || browserProfile !== undefined
          || browserExecutable !== undefined
          || parsed.booleans.has("--trust-profile-egress")
        ) {
          return {
            ok: false,
            message: "linked-device options cannot be combined with cookie or browser-profile options",
          };
        }
        if (
          linkedDeviceProvider === undefined
          || !isProviderPluginSurfaceId(linkedDeviceProvider)
        ) {
          return {
            ok: false,
            message: "--linked-device must be a lowercase kebab-case provider surface ID",
          };
        }
        return {
          ok: true,
          value: {
            command: "auth-add",
            id,
            linkedDeviceProvider,
            ...(deviceStore === undefined ? {} : { deviceStore }),
            ...(subject === undefined ? {} : { subject }),
            trustProfileEgress: false,
            force: parsed.booleans.has("--force"),
          },
        };
      }
      if (hasOAuthOption) {
        if (
          source !== undefined
          || parsed.values["--cookie-profile"] !== undefined
          || cookiesFile !== undefined
          || browserProfile !== undefined
          || browserExecutable !== undefined
          || parsed.booleans.has("--trust-profile-egress")
        ) return { ok: false, message: "OAuth token-file options cannot be combined with cookie or browser-profile options" };
        if (oauthProvider === undefined || tokenFile === undefined || rawScopes === undefined) {
          return { ok: false, message: "OAuth auth requires --oauth-provider, --token-file, and --scopes" };
        }
        if (!isProviderPluginSurfaceId(oauthProvider)) {
          return {
            ok: false,
            message: "--oauth-provider must be a lowercase kebab-case provider surface ID",
          };
        }
        let scopes: readonly string[];
        try {
          scopes = normalizeOAuthScopes(rawScopes.split(",").map((scope) => scope.trim()));
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : "OAuth locator fields are invalid" };
        }
        return {
          ok: true,
          value: {
            command: "auth-add",
            id,
            oauthProvider,
            tokenFile,
            scopes,
            ...(subject === undefined ? {} : { subject }),
            trustProfileEgress: false,
            force: parsed.booleans.has("--force"),
          },
        };
      }
      if (
        (cookiesFile !== undefined && (source !== undefined || browserProfile !== undefined))
        || (cookiesFile === undefined && source === undefined && browserProfile === undefined)
      ) return { ok: false, message: "auth add requires exactly one cookie file or browser profile, or a cookie source; browser profiles may add one cookie source" };
      if (parsed.values["--cookie-profile"] !== undefined && source === undefined) return { ok: false, message: "--cookie-profile requires --cookie-source" };
      if (browserProfile !== undefined && !parsed.booleans.has("--trust-profile-egress")) {
        return { ok: false, message: "--browser-profile requires --trust-profile-egress" };
      }
      if (browserProfile === undefined && parsed.booleans.has("--trust-profile-egress")) {
        return { ok: false, message: "--trust-profile-egress requires --browser-profile" };
      }
      if (browserExecutable !== undefined && browserProfile === undefined) {
        return { ok: false, message: "--browser-executable requires --browser-profile" };
      }
      return {
        ok: true,
        value: {
          command: "auth-add",
          id,
          ...(source === undefined ? {} : { cookieSource: source as CookieSource }),
          ...(parsed.values["--cookie-profile"] === undefined ? {} : { cookieProfile: parsed.values["--cookie-profile"] }),
          ...(cookiesFile === undefined ? {} : { cookiesFile }),
          ...(browserProfile === undefined ? {} : { browserProfile }),
          ...(browserExecutable === undefined ? {} : { browserExecutable }),
          ...(subject === undefined ? {} : { subject }),
          trustProfileEgress: parsed.booleans.has("--trust-profile-egress"),
          force: parsed.booleans.has("--force"),
        },
      };
    }
    if (subcommand === "pair") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "auth pair requires an ID" };
      const issue = validId(id, "auth ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(raw.slice(3), ["--phone"], []);
      if (isFailure(parsed)) return parsed;
      const phone = parsed.values["--phone"];
      if (phone !== undefined && !/^\+?[0-9]{5,20}$/u.test(phone)) {
        return { ok: false, message: "--phone must be one international phone number" };
      }
      return {
        ok: true,
        value: {
          command: "auth-pair",
          id,
          ...(phone === undefined ? {} : { phone }),
        },
      };
    }
    if (subcommand === "sync") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "auth sync requires an ID" };
      const issue = validId(id, "auth ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(raw.slice(3), [], ["--once", "--json"]);
      if (isFailure(parsed)) return parsed;
      if (!parsed.booleans.has("--once")) {
        return { ok: false, message: "auth sync requires --once; unbounded background sync is not exposed" };
      }
      return {
        ok: true,
        value: {
          command: "auth-sync",
          id,
          once: true,
          json: parsed.booleans.has("--json"),
        },
      };
    }
    if (subcommand === "bind") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "auth bind requires an ID" };
      const issue = validId(id, "auth ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(raw.slice(3), ["--site"], ["--force", "--json"]);
      if (isFailure(parsed)) return parsed;
      const site = parsed.values["--site"];
      if (site === undefined || !isProviderPluginSurfaceId(site)) {
        return {
          ok: false,
          message: "auth bind requires --site <lowercase-kebab-case-surface-id>",
        };
      }
      return {
        ok: true,
        value: {
          command: "auth-bind",
          id,
          site,
          force: parsed.booleans.has("--force"),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    if (subcommand === "remove" || subcommand === "forget") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "auth remove requires an ID" };
      const issue = validId(id, "auth ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(raw.slice(3), [], ["--yes"]);
      return isFailure(parsed) ? parsed : { ok: true, value: { command: "auth-remove", id, yes: parsed.booleans.has("--yes") } };
    }
    return { ok: false, message: "auth requires list, login, add, pair, sync, bind, or remove" };
  }
  if (first === "adapter") {
    const subcommand = raw[1];
    if (subcommand === "sync-bundled") {
      const json = simpleJsonOptions(raw.slice(2), "adapter sync-bundled");
      return typeof json === "boolean"
        ? { ok: true, value: { command: "adapter-sync-bundled", json } }
        : json;
    }
    if (subcommand === "scaffold") {
      return parsePluginScaffoldArguments(raw.slice(2), "adapter scaffold");
    }
    if (subcommand === "init") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "adapter init requires an ID" };
      const issue = validId(id, "adapter ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(raw.slice(3), ["--origin", "--platform", "--output"], ["--force"]);
      if (isFailure(parsed)) return parsed;
      const origin = parsed.values["--origin"];
      const requestedPlatform = parsed.values["--platform"];
      const output = parsed.values["--output"];
      if ((origin === undefined) === (requestedPlatform === undefined)) {
        return { ok: false, message: "adapter init requires exactly one of --origin or --platform" };
      }
      if (output === undefined) return { ok: false, message: "adapter init requires --output" };
      if (origin !== undefined) {
        return {
          ok: true,
          value: {
            command: "adapter-init",
            id,
            target: { kind: "origin", origin },
            output,
            force: parsed.booleans.has("--force"),
          },
        };
      }
      const surfaceId = knownPlatformSurface(requestedPlatform ?? "");
      if (surfaceId === null) {
        return { ok: false, message: `unknown platform surface: ${requestedPlatform ?? ""}; run 'wrench platforms' to list reviewed surfaces` };
      }
      return {
        ok: true,
        value: {
          command: "adapter-init",
          id,
          target: { kind: "platform", surfaceId },
          output,
          force: parsed.booleans.has("--force"),
        },
      };
    }
    if (subcommand === "validate") {
      const path = raw[2];
      if (path === undefined) return { ok: false, message: "adapter validate requires a manifest path" };
      const json = simpleJsonOptions(raw.slice(3), "adapter validate");
      return typeof json === "boolean" ? { ok: true, value: { command: "adapter-validate", path, json } } : json;
    }
    if (subcommand === "install") {
      const path = raw[2];
      if (path === undefined) return { ok: false, message: "adapter install requires a manifest path" };
      const parsed = optionValues(raw.slice(3), [], ["--force"], ["--upgrade-from"]);
      if (isFailure(parsed)) return parsed;
      const upgradeFrom = parsed.repeatedValues["--upgrade-from"] ?? [];
      if (parsed.booleans.has("--force") && upgradeFrom.length > 0) {
        return { ok: false, message: "adapter install accepts --force or --upgrade-from, not both" };
      }
      return {
        ok: true,
        value: {
          command: "adapter-install",
          path,
          ...(upgradeFrom.length === 0 ? {} : { upgradeFrom }),
          force: parsed.booleans.has("--force"),
        },
      };
    }
    if (subcommand === "remove" || subcommand === "uninstall") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "adapter remove requires an ID" };
      const issue = validId(id, "adapter ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(raw.slice(3), [], ["--yes"]);
      return isFailure(parsed) ? parsed : { ok: true, value: { command: "adapter-remove", id, yes: parsed.booleans.has("--yes") } };
    }
    return { ok: false, message: "adapter requires sync-bundled, init, validate, install, remove, or the scaffold compatibility alias" };
  }
  if (first === "derive") {
    const subcommand = raw[1];
    if (subcommand === "list" || subcommand === "status") {
      const json = simpleJsonOptions(raw.slice(2), "derive list");
      return typeof json === "boolean" ? { ok: true, value: { command: "derive-list", json } } : json;
    }
    if (subcommand === "start" || subcommand === "begin") {
      const adapterId = raw[2];
      const url = raw[3];
      if (adapterId === undefined || url === undefined) return { ok: false, message: "derive start requires an adapter ID and URL" };
      const issue = validId(adapterId, "adapter ID");
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(
        raw.slice(4),
        ["--auth", "--content", "--domains"],
        ["--allow-remote-actions", "--headed", "--json"],
        ["--fixture"],
      );
      if (isFailure(parsed)) return parsed;
      const content = parsed.values["--content"] ?? "none";
      if (content !== "none" && content !== "text") return { ok: false, message: "--content must be none or text" };
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        return { ok: false, message: "derive start URL is invalid" };
      }
      const browserDomains = (parsed.values["--domains"] ?? hostname).split(",").map((value) => value.trim()).filter((value) => value !== "");
      if (browserDomains.length < 1 || browserDomains.length > 100 || browserDomains.some((value) => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value))) {
        return { ok: false, message: "--domains must be a comma-separated list of exact or wildcard hostnames" };
      }
      const fixtureSources = parsed.repeatedValues["--fixture"] ?? [];
      if (fixtureSources.length > 20 || fixtureSources.some((value) => value.length > 4_096 || value.includes("\u0000"))) {
        return { ok: false, message: "derive start accepts at most 20 bounded --fixture media paths" };
      }
      if (fixtureSources.length > 0 && !parsed.booleans.has("--allow-remote-actions")) {
        return { ok: false, message: "derive start --fixture requires --allow-remote-actions" };
      }
      return {
        ok: true,
        value: {
          command: "derive-start",
          adapterId,
          url,
          authId: parsed.values["--auth"] ?? adapterId,
          allowRemoteActions: parsed.booleans.has("--allow-remote-actions"),
          contentMode: content,
          browserDomains,
          fixtureSources,
          headed: parsed.booleans.has("--headed"),
        },
      };
    }
    if (subcommand === "browser") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "derive browser requires a derivation ID" };
      let browserArguments = raw.slice(3);
      let json = false;
      if (browserArguments[0] === "--json") {
        json = true;
        browserArguments = browserArguments.slice(1);
      }
      if (browserArguments[0] === "--") browserArguments = browserArguments.slice(1);
      if (browserArguments.length === 0) return { ok: false, message: "derive browser requires an agent-browser command after --" };
      return { ok: true, value: { command: "derive-browser", id, browserArguments, json } };
    }
    if (subcommand === "review") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "derive review requires a derivation ID" };
      const parsed = optionValues(raw.slice(3), ["--entry", "--offset", "--limit", "--fixtures"], ["--json"]);
      if (isFailure(parsed)) return parsed;
      const entryValue = parsed.values["--entry"];
      const offsetValue = parsed.values["--offset"];
      const limitValue = parsed.values["--limit"];
      const fixtureSource = parsed.values["--fixtures"];
      const boundedInteger = (value: string | undefined, fallback: number, maximum: number): number | null => {
        if (value === undefined) return fallback;
        if (!/^\d{1,5}$/u.test(value)) return null;
        const parsedValue = Number(value);
        return parsedValue <= maximum ? parsedValue : null;
      };
      if (entryValue !== undefined) {
        if (offsetValue !== undefined || limitValue !== undefined) {
          return { ok: false, message: "derive review --entry cannot be combined with --offset or --limit" };
        }
        const entryIndex = boundedInteger(entryValue, 0, 19_999);
        if (entryIndex === null) return { ok: false, message: "derive review --entry must be an integer from 0 to 19999" };
        if (fixtureSource !== undefined && fixtureSource !== "-") {
          return { ok: false, message: "derive review fixtures must be supplied on stdin with --fixtures -" };
        }
        return {
          ok: true,
          value: {
            command: "derive-review",
            id,
            selection: { kind: "entry", entryIndex, fixtures: fixtureSource === "-" },
            json: parsed.booleans.has("--json"),
          },
        };
      }
      if (fixtureSource !== undefined) return { ok: false, message: "derive review --fixtures requires --entry" };
      const offset = boundedInteger(offsetValue, 0, 20_000);
      const limit = boundedInteger(limitValue, 50, 100);
      if (offset === null) return { ok: false, message: "derive review --offset must be an integer from 0 to 20000" };
      if (limit === null || limit < 1) return { ok: false, message: "derive review --limit must be an integer from 1 to 100" };
      return {
        ok: true,
        value: {
          command: "derive-review",
          id,
          selection: { kind: "list", offset, limit },
          json: parsed.booleans.has("--json"),
        },
      };
    }
    if (subcommand === "finish") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "derive finish requires a derivation ID" };
      const parsed = optionValues(raw.slice(3), ["--output", "--platform"], ["--force", "--json"]);
      if (isFailure(parsed)) return parsed;
      const output = parsed.values["--output"];
      if (output === undefined) return { ok: false, message: "derive finish requires --output" };
      const requestedPlatform = parsed.values["--platform"];
      const surfaceId = requestedPlatform === undefined ? undefined : knownPlatformSurface(requestedPlatform);
      if (surfaceId === null) {
        return { ok: false, message: `unknown platform surface: ${requestedPlatform}; run 'wrench platforms' to list reviewed surfaces` };
      }
      return {
        ok: true,
        value: {
          command: "derive-finish",
          id,
          output,
          ...(surfaceId === undefined ? {} : { surfaceId }),
          force: parsed.booleans.has("--force"),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    if (subcommand === "discard") {
      const id = raw[2];
      if (id === undefined) return { ok: false, message: "derive discard requires a derivation ID" };
      const parsed = optionValues(raw.slice(3), [], ["--yes"]);
      return isFailure(parsed) ? parsed : { ok: true, value: { command: "derive-discard", id, yes: parsed.booleans.has("--yes") } };
    }
    if (subcommand === "analyze") {
      const har = raw[2];
      if (har === undefined) return { ok: false, message: "derive analyze requires a HAR path" };
      const parsed = optionValues(raw.slice(3), ["--adapter", "--origin", "--output", "--platform"], ["--force", "--json"]);
      if (isFailure(parsed)) return parsed;
      const adapterId = parsed.values["--adapter"];
      const origin = parsed.values["--origin"];
      const output = parsed.values["--output"];
      if (adapterId === undefined || origin === undefined || output === undefined) {
        return { ok: false, message: "derive analyze requires --adapter, --origin, and --output" };
      }
      const issue = validId(adapterId, "adapter ID");
      if (issue !== null) return { ok: false, message: issue };
      const requestedPlatform = parsed.values["--platform"];
      const surfaceId = requestedPlatform === undefined ? undefined : knownPlatformSurface(requestedPlatform);
      if (surfaceId === null) {
        return { ok: false, message: `unknown platform surface: ${requestedPlatform}; run 'wrench platforms' to list reviewed surfaces` };
      }
      return {
        ok: true,
        value: {
          command: "derive-analyze",
          har,
          adapterId,
          origin,
          output,
          ...(surfaceId === undefined ? {} : { surfaceId }),
          force: parsed.booleans.has("--force"),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    return { ok: false, message: "derive requires list, start, browser, review, finish, analyze, or discard" };
  }
  if (first === "invoke") {
    const adapterId = raw[1];
    const operationId = raw[2];
    if (adapterId === undefined || operationId === undefined) return { ok: false, message: "invoke requires an adapter ID and operation ID" };
    const adapterIssue = validId(adapterId, "adapter ID");
    if (adapterIssue !== null) return { ok: false, message: adapterIssue };
    const operationIssue = validOperation(operationId);
    if (operationIssue !== null) return { ok: false, message: operationIssue };
    const parsed = optionValues(
      raw.slice(3),
      ["--input", "--auth"],
      ["--preview", "--cache-only", "--projection-identity-only", "--headed", "--json"],
      ["--duplicate-risk-of"],
    );
    if (isFailure(parsed)) return parsed;
    const duplicateRiskOf = duplicateRiskRunIds(
      parsed.repeatedValues["--duplicate-risk-of"] ?? [],
    );
    if ("ok" in duplicateRiskOf) return duplicateRiskOf;
    if (
      parsed.booleans.has("--cache-only")
      && parsed.booleans.has("--preview")
    ) {
      return { ok: false, message: "invoke --cache-only cannot be combined with --preview" };
    }
    if (
      parsed.booleans.has("--cache-only")
      && parsed.booleans.has("--headed")
    ) {
      return { ok: false, message: "invoke --cache-only never opens a browser and cannot be combined with --headed" };
    }
    if (
      parsed.booleans.has("--projection-identity-only")
      && (
        parsed.booleans.has("--preview")
        || parsed.booleans.has("--cache-only")
      )
    ) {
      return { ok: false, message: "invoke --projection-identity-only cannot be combined with --preview or --cache-only" };
    }
    if (
      parsed.booleans.has("--projection-identity-only")
      && parsed.booleans.has("--headed")
    ) {
      return { ok: false, message: "invoke --projection-identity-only never opens a browser and cannot be combined with --headed" };
    }
    return {
      ok: true,
      value: {
        command: "invoke",
        adapterId,
        operationId,
        inputSource: parsed.values["--input"] ?? "{}",
        ...(parsed.values["--auth"] === undefined
          ? {}
          : { authId: parsed.values["--auth"] }),
        duplicateRiskOf,
        preview: parsed.booleans.has("--preview"),
        cacheOnly: parsed.booleans.has("--cache-only"),
        projectionIdentityOnly:
          parsed.booleans.has("--projection-identity-only"),
        headed: parsed.booleans.has("--headed"),
        json: parsed.booleans.has("--json"),
      },
    };
  }
  if (first === "omni") {
    if (raw[1] !== "read") {
      return { ok: false, message: "omni requires read" };
    }
    const parsed = optionValues(
      raw.slice(2),
      ["--input"],
      ["--cache-only", "--identity-only", "--from-exact-cache", "--headed", "--json"],
    );
    if (isFailure(parsed)) return parsed;
    const inputSource = parsed.values["--input"];
    if (inputSource === undefined) {
      return { ok: false, message: "omni read requires --input <json|@file|->" };
    }
    const modes = [
      parsed.booleans.has("--cache-only"),
      parsed.booleans.has("--identity-only"),
      parsed.booleans.has("--from-exact-cache"),
    ].filter(Boolean).length;
    if (modes > 1) {
      return {
        ok: false,
        message: "omni read accepts only one of --cache-only, --identity-only, or --from-exact-cache",
      };
    }
    if (parsed.booleans.has("--headed") && modes > 0) {
      return {
        ok: false,
        message: "omni read cache, identity, and exact-cache rebuild modes never open a browser and cannot use --headed",
      };
    }
    return {
      ok: true,
      value: {
        command: "omni-read",
        inputSource,
        cacheOnly: parsed.booleans.has("--cache-only"),
        identityOnly: parsed.booleans.has("--identity-only"),
        fromExactCache: parsed.booleans.has("--from-exact-cache"),
        headed: parsed.booleans.has("--headed"),
        json: parsed.booleans.has("--json"),
      },
    };
  }
  if (first === "confirm") {
    const digest = raw[1];
    if (digest === undefined) return { ok: false, message: "confirm requires a plan digest" };
    const parsed = optionValues(raw.slice(2), [], ["--headed", "--json"]);
    if (isFailure(parsed)) return parsed;
    return {
      ok: true,
      value: {
        command: "confirm",
        digest,
        headed: parsed.booleans.has("--headed"),
        json: parsed.booleans.has("--json"),
      },
    };
  }
  if (first === "runs") {
    if (raw[1] === "list") {
      const json = simpleJsonOptions(raw.slice(2), "runs list");
      return typeof json === "boolean" ? { ok: true, value: { command: "runs-list", json } } : json;
    }
    if (raw[1] === "show") {
      const runId = raw[2];
      if (runId === undefined) return { ok: false, message: "runs show requires a run ID" };
      const issue = validRunId(runId);
      if (issue !== null) return { ok: false, message: issue };
      const json = simpleJsonOptions(raw.slice(3), "runs show");
      return typeof json === "boolean" ? { ok: true, value: { command: "runs-show", runId, json } } : json;
    }
    if (raw[1] === "reconcile") {
      const runId = raw[2];
      if (runId === undefined) return { ok: false, message: "runs reconcile requires a run ID" };
      const issue = validRunId(runId);
      if (issue !== null) return { ok: false, message: issue };
      const parsed = optionValues(raw.slice(3), ["--input"], ["--json"]);
      if (isFailure(parsed)) return parsed;
      const inputSource = parsed.values["--input"];
      return {
        ok: true,
        value: {
          command: "runs-reconcile",
          runId,
          ...(inputSource === undefined ? {} : { inputSource }),
          json: parsed.booleans.has("--json"),
        },
      };
    }
    return { ok: false, message: "runs requires list, show, or reconcile" };
  }
  if (first === "plans") {
    if (raw[1] === "list") {
      const json = simpleJsonOptions(raw.slice(2), "plans list");
      return typeof json === "boolean" ? { ok: true, value: { command: "plans-list", json } } : json;
    }
    if (raw[1] === "cancel") {
      const digest = raw[2];
      if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) return { ok: false, message: "plans cancel requires a 64-character lowercase hex digest" };
      const parsed = optionValues(raw.slice(3), [], ["--yes"]);
      return isFailure(parsed) ? parsed : { ok: true, value: { command: "plans-cancel", digest, yes: parsed.booleans.has("--yes") } };
    }
    return { ok: false, message: "plans requires list or cancel" };
  }
  if (validId(first, "adapter ID") === null && raw[1] !== undefined && validOperation(raw[1]) === null) {
    return parseWrenchArguments(["invoke", ...raw]);
  }
  return { ok: false, message: `unknown command: ${first}` };
}

export { wrenchUsage } from "./usage";
