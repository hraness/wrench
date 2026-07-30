#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isProviderPluginId,
  isProviderPluginOperationName,
  isProviderPluginSurfaceId,
} from "../provider-plugin-identifiers";

type Risk = "R1" | "R2" | "R3";

export type ScaffoldOptions = {
  readonly site: string;
  readonly displayName: string;
  readonly origin: string;
  readonly operation: string;
  readonly risk: Risk;
  readonly evidencePath: string;
  readonly candidateIndex: number;
  readonly outputDirectory: string;
};

export const SOURCE_PROVIDER_PLUGIN_FILES = Object.freeze([
  "plugin.ts",
  "runtime.ts",
  "plugin.test.ts",
  "runtime.internal.test.ts",
  "wrench-adapter.json",
  "promotion-checklist.json",
] as const);

export type SourceProviderPluginCheck = {
  readonly status: "capture-required";
  readonly executable: false;
  readonly pluginId: string;
  readonly directory: string;
  readonly files: typeof SOURCE_PROVIDER_PLUGIN_FILES;
};

type EvidenceSummary = {
  readonly sha256: string;
  readonly candidateIndex: number;
};

const templateDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "code-owned-provider-template",
);

const templateFiles = Object.freeze([
  ["plugin.ts.template", () => "plugin.ts"],
  ["runtime.ts.template", () => "runtime.ts"],
  ["plugin.test.ts.template", () => "plugin.test.ts"],
  ["runtime.internal.test.ts.template", () => "runtime.internal.test.ts"],
  ["wrench-adapter.json.template", () => "wrench-adapter.json"],
] as const);

const webPluginIdSuffix = "-web";
const webAdapterDisplayNameSuffix = " (Authenticated Web API)";
// These are the runtime manifest bounds enforced by model.ts. The focused
// round-trip test below keeps this pre-write validation synchronized with the
// shared parser until those schema bounds have a shared exported home.
const runtimeManifestIdMaxLength = 48;
const runtimeManifestDisplayNameMaxLength = 100;
const scaffoldSiteMaxLength =
  runtimeManifestIdMaxLength - webPluginIdSuffix.length;
const scaffoldDisplayNameMaxLength =
  runtimeManifestDisplayNameMaxLength - webAdapterDisplayNameSuffix.length;

function webPluginId(site: string): string {
  return `${site}${webPluginIdSuffix}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function boundedStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} exceeded its reviewed array bound`);
  }
  return value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, maximumItemLength));
}

function boundedIntegerArray(
  value: unknown,
  label: string,
  maximumItems: number,
): readonly number[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} exceeded its reviewed array bound`);
  }
  return value.map((item, index) => {
    if (!Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 999) {
      throw new Error(`${label}[${index}] must be a bounded status integer`);
    }
    return item as number;
  });
}

function parseEvidence(
  path: string,
  origin: string,
  candidateIndex: number,
): EvidenceSummary {
  if (!isAbsolute(path)) throw new Error("evidence path must be absolute");
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error("could not inspect the private evidence file");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("evidence path must be a regular non-symlink file");
  }
  if (
    typeof process.getuid === "function"
    && stats.uid !== process.getuid()
  ) throw new Error("evidence file must be owned by the current user");
  if ((stats.mode & 0o077) !== 0) {
    throw new Error("evidence file must not be readable or writable by group or others");
  }
  if (stats.size < 2 || stats.size > 16 * 1024 * 1024) {
    throw new Error("evidence file exceeded its reviewed size bound");
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("could not read the private evidence file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("evidence file must contain valid JSON");
  }
  const evidence = record(parsed, "internal API evidence");
  if (
    !exactKeys(evidence, [
      "adapterId",
      "analyzedAt",
      "candidates",
      "observedEntries",
      "schemaVersion",
      "targetOrigin",
      "warnings",
    ])
    || evidence.schemaVersion !== 1
    || boundedString(evidence.adapterId, "evidence adapter ID", 128).length < 1
    || boundedString(evidence.targetOrigin, "evidence target origin", 2_048) !== origin
    || Number.isNaN(Date.parse(boundedString(evidence.analyzedAt, "evidence timestamp", 64)))
    || !Number.isSafeInteger(evidence.observedEntries)
    || (evidence.observedEntries as number) < 0
    || (evidence.observedEntries as number) > 10_000
    || !Array.isArray(evidence.candidates)
    || evidence.candidates.length > 2_000
  ) {
    throw new Error("evidence file does not match the reviewed internal-api-evidence schema and origin");
  }
  boundedStringArray(evidence.warnings, "evidence warnings", 2_000, 4_096);
  if (
    !Number.isSafeInteger(candidateIndex)
    || candidateIndex < 0
    || candidateIndex >= evidence.candidates.length
  ) throw new Error("candidate index is outside the sanitized evidence");

  const candidate = record(evidence.candidates[candidateIndex], "selected evidence candidate");
  if (
    !exactKeys(candidate, [
      "headerNames",
      "method",
      "operationType",
      "origin",
      "path",
      "queryNames",
      "requestFieldPaths",
      "responseFieldPaths",
      "reviewRequired",
      "revisions",
      "sampleCount",
      "statuses",
    ])
    || candidate.reviewRequired !== true
    || boundedString(candidate.origin, "candidate origin", 2_048) !== origin
    || !/^(?:DELETE|GET|HEAD|OPTIONS|PATCH|POST|PUT)$/u.test(
      boundedString(candidate.method, "candidate method", 16),
    )
    || (
      candidate.operationType !== "query"
      && candidate.operationType !== "mutation"
      && candidate.operationType !== "unknown"
    )
    || !boundedString(candidate.path, "candidate path", 4_096).startsWith("/")
    || !Number.isSafeInteger(candidate.sampleCount)
    || (candidate.sampleCount as number) < 1
    || (candidate.sampleCount as number) > 10_000
  ) {
    throw new Error("selected evidence candidate is not a review-required exact-origin exchange");
  }
  boundedIntegerArray(candidate.statuses, "candidate statuses", 100);
  boundedStringArray(candidate.queryNames, "candidate query names", 1_000, 128);
  boundedStringArray(candidate.headerNames, "candidate header names", 200, 128);
  boundedStringArray(candidate.requestFieldPaths, "candidate request paths", 1_000, 4_096);
  boundedStringArray(candidate.responseFieldPaths, "candidate response paths", 1_000, 4_096);
  boundedStringArray(candidate.revisions, "candidate revisions", 1_000, 512);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    candidateIndex,
  };
}

function exactOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("origin must be an absolute HTTPS origin");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || isIP(hostname) !== 0
    || !hostname.includes(".")
  ) throw new Error("origin must be one exact public HTTPS origin without a path");
  return url;
}

function siteId(value: string): string {
  if (
    value.length > scaffoldSiteMaxLength
    || !isProviderPluginSurfaceId(value)
    || !isProviderPluginId(webPluginId(value))
  ) {
    throw new Error(
      `site must start with a letter, use lowercase kebab-case, and be at most ${scaffoldSiteMaxLength} characters so its ${webPluginIdSuffix} manifest ID remains installable`,
    );
  }
  return value;
}

function semanticOperation(value: string): string {
  if (!isProviderPluginOperationName(value)) {
    throw new Error("operation must be a bounded dotted semantic outcome");
  }
  const transportWords = new Set([
    "browser",
    "cookie",
    "dom",
    "endpoint",
    "graphql",
    "header",
    "http",
    "api",
    "javascript",
    "raw",
    "request",
    "restli",
    "selector",
    "url",
  ]);
  const tokens = value.split(/[.-]/u);
  if (tokens.some((part) => transportWords.has(part))) {
    throw new Error("operation must describe a semantic outcome, not a transport primitive");
  }
  if (tokens.some((part) =>
    part === "admin"
    || part === "credential"
    || part === "delete"
    || part === "destroy"
    || part === "payment"
    || part === "permission"
    || part === "remove")) {
    throw new Error("R4 or destructive outcomes cannot use the provider scaffold");
  }
  return value;
}

function displayName(value: string): string {
  if (
    value.length > scaffoldDisplayNameMaxLength
    || !/^[A-Za-z0-9][A-Za-z0-9 .&'()+_-]*$/u.test(value)
  ) {
    throw new Error(
      `display name must be one bounded line of at most ${scaffoldDisplayNameMaxLength} characters so the generated manifest display name remains installable`,
    );
  }
  return value;
}

function exactRisk(value: unknown): Risk {
  if (value !== "R1" && value !== "R2" && value !== "R3") {
    throw new Error("risk must be R1, R2, or R3");
  }
  return value;
}

function assertSemanticRisk(operation: string, risk: Risk): void {
  const finalVerb = operation.split(".").at(-1);
  const r1Verbs: ReadonlySet<string> = new Set(["list", "read"]);
  const r2Verbs: ReadonlySet<string> = new Set(["save", "set"]);
  const r3Verbs: ReadonlySet<string> = new Set([
    "create",
    "edit",
    "publish",
    "quote",
    "repost",
    "schedule",
    "send",
    "share",
    "upload",
  ]);
  let expected: Risk | null = null;
  if (finalVerb !== undefined && r1Verbs.has(finalVerb)) expected = "R1";
  else if (finalVerb !== undefined && r2Verbs.has(finalVerb)) expected = "R2";
  else if (finalVerb !== undefined && r3Verbs.has(finalVerb)) expected = "R3";
  if (expected !== null && risk !== expected) {
    throw new Error(`${operation} must use ${expected}, not ${risk}`);
  }
}

function constantPrefix(value: string): string {
  return value.split("-").map((part) => part.toUpperCase()).join("_");
}

function pascalName(value: string): string {
  return value
    .split("-")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");
}

function camelName(value: string): string {
  const pascal = pascalName(value);
  return `${pascal[0]?.toLowerCase() ?? ""}${pascal.slice(1)}`;
}

function replacements(
  options: ScaffoldOptions,
  origin: URL,
): Readonly<Record<string, string>> {
  const readOnly = options.risk === "R1";
  return Object.freeze({
    "__ADAPTER_DISPLAY_NAME_JSON__": JSON.stringify(
      `${options.displayName}${webAdapterDisplayNameSuffix}`,
    ),
    "__CAMEL_NAME__": camelName(options.site),
    "__CONSTANT_PREFIX__": constantPrefix(options.site),
    "__DEDUPE_WINDOW_MS__": readOnly ? "0" : "86400000",
    "__DISPATCH_JSON__": JSON.stringify(readOnly ? "none" : "single"),
    "__DISPLAY_NAME__": options.displayName,
    "__EFFECT_JSON__": JSON.stringify(readOnly ? "read" : "write"),
    "__HOSTNAME__": origin.hostname,
    "__HOSTNAME_JSON__": JSON.stringify(origin.hostname),
    "__IDEMPOTENCY__": readOnly ? "none" : "local-at-most-once",
    "__OPERATION_JSON__": JSON.stringify(options.operation),
    "__OPERATION__": options.operation,
    "__ORIGIN_JSON__": JSON.stringify(origin.origin),
    "__ORIGIN__": origin.origin,
    "__PASCAL_NAME__": pascalName(options.site),
    "__PLUGIN_ID_JSON__": JSON.stringify(webPluginId(options.site)),
    "__PLAN_DISPATCHES__": readOnly
      ? "[]"
      : `[{ id: "execute", description: ${JSON.stringify(
        `Execute ${options.site} ${options.operation}`,
      )} }]`,
    "__RISK_JSON__": JSON.stringify(options.risk),
    "__RISK__": options.risk,
    "__SIDE_EFFECT__": readOnly
      ? "none"
      : "Replace this placeholder with the exact bounded remote effect before promotion.",
    "__SITE_ID_JSON__": JSON.stringify(options.site),
    "__SITE_ID__": options.site,
  });
}

function renderTemplate(
  source: string,
  values: Readonly<Record<string, string>>,
): string {
  let rendered = source;
  for (const [token, value] of Object.entries(values)) {
    rendered = rendered.split(token).join(value);
  }
  const unresolved = rendered.match(/__[A-Z][A-Z0-9_]*__/gu);
  if (unresolved !== null) {
    throw new Error(`provider template retained unresolved token ${unresolved[0]}`);
  }
  return rendered;
}

function prepareOutputDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("output directory must be absolute");
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("output path must not be a symlink or non-directory");
    }
    if (readdirSync(path).length > 0) {
      throw new Error("output directory must not already contain files");
    }
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
      return path;
    }
    if (error instanceof Error) throw error;
    throw new Error("could not inspect output directory");
  }
  chmodSync(path, 0o700);
  return path;
}

function readSourcePluginFile(
  directory: string,
  name: string,
): string {
  const path = join(directory, name);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`source provider plugin is missing ${name}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`source provider plugin ${name} must be a regular non-symlink file`);
  }
  if (stats.size < 1 || stats.size > 2 * 1024 * 1024) {
    throw new Error(`source provider plugin ${name} exceeded its reviewed size bound`);
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`could not read source provider plugin ${name}`);
  }
}

function sourceAdapterManifestName(directory: string): string {
  const names = ["wrench-adapter.json", "oh-adapter.json"].filter((name) => {
    try {
      return lstatSync(join(directory, name)).isFile();
    } catch {
      return false;
    }
  });
  if (names.length === 0) {
    throw new Error("source provider plugin is missing wrench-adapter.json");
  }
  if (names.length > 1) {
    throw new Error(
      "source provider plugin must contain exactly one of wrench-adapter.json or oh-adapter.json",
    );
  }
  const name = names[0];
  if (name === undefined) throw new Error("source adapter manifest selection failed");
  return name;
}

function parseSourcePluginJson(source: string, name: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`source provider plugin ${name} must contain valid JSON`);
  }
  return record(value, `source provider plugin ${name}`);
}

function assertCanonicalSourcePluginLocation(
  directory: string,
  pluginId: string,
): void {
  const cliSourceRoot = resolve(directory, "..", "..");
  let providerPluginStats: ReturnType<typeof lstatSync>;
  let authStats: ReturnType<typeof lstatSync>;
  let webSessionStats: ReturnType<typeof lstatSync>;
  try {
    providerPluginStats = lstatSync(join(cliSourceRoot, "provider-plugin.ts"));
    authStats = lstatSync(join(cliSourceRoot, "auth.ts"));
    webSessionStats = lstatSync(join(cliSourceRoot, "web-session.ts"));
  } catch {
    throw new Error(
      "source provider plugin must be checked at src/plugins/<plugin-id> so its ../../provider-plugin, ../../auth, and ../../web-session imports resolve",
    );
  }
  if (
    basename(directory) !== pluginId
    || basename(dirname(directory)) !== "plugins"
    || providerPluginStats.isSymbolicLink()
    || !providerPluginStats.isFile()
    || authStats.isSymbolicLink()
    || !authStats.isFile()
    || webSessionStats.isSymbolicLink()
    || !webSessionStats.isFile()
  ) {
    throw new Error(
      `source provider plugin ${pluginId} must live at src/plugins/${pluginId}`,
    );
  }
}

function assertCaptureRequiredRuntimeIsInert(source: string): void {
  const forbidden = [
    /\bfetch\s*\(/u,
    /\bBun\.connect\s*\(/u,
    /\b(?:http|https)\.request\s*\(/u,
    /\bnew\s+WebSocket\s*\(/u,
    /\bpage\.(?:click|fill|goto|press|type|upload)\s*\(/u,
    /\b(?:browser|context)\.newPage\s*\(/u,
  ] as const;
  if (forbidden.some((pattern) => pattern.test(source))) {
    throw new Error(
      "capture-required source provider runtime must remain network-inert and contain no browser action",
    );
  }
  if (!source.includes("capture-required")) {
    throw new Error("capture-required source provider runtime must fail closed");
  }
}

/**
 * Check the generated source unit without importing or executing plugin code.
 * This is a layout and scaffold-conformance check, not a sandbox or trust
 * boundary for executable source.
 */
export function checkSourceProviderPluginDirectory(
  path: string,
): SourceProviderPluginCheck {
  const directory = resolve(path);
  let directoryStats: ReturnType<typeof lstatSync>;
  try {
    directoryStats = lstatSync(directory);
  } catch {
    throw new Error("source provider plugin directory does not exist");
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("source provider plugin path must be a regular non-symlink directory");
  }

  const adapterManifestName = sourceAdapterManifestName(directory);
  const sources = {
    "plugin.ts": readSourcePluginFile(directory, "plugin.ts"),
    "runtime.ts": readSourcePluginFile(directory, "runtime.ts"),
    "plugin.test.ts": readSourcePluginFile(directory, "plugin.test.ts"),
    "runtime.internal.test.ts": readSourcePluginFile(
      directory,
      "runtime.internal.test.ts",
    ),
    "wrench-adapter.json": readSourcePluginFile(directory, adapterManifestName),
    "promotion-checklist.json": readSourcePluginFile(
      directory,
      "promotion-checklist.json",
    ),
  } satisfies Record<(typeof SOURCE_PROVIDER_PLUGIN_FILES)[number], string>;
  const checklist = parseSourcePluginJson(
    sources["promotion-checklist.json"],
    "promotion-checklist.json",
  );
  if (
    !exactKeys(checklist, [
      "operation",
      "origin",
      "pluginId",
      "proofs",
      "risk",
      "sanitizedEvidence",
      "schemaVersion",
      "site",
      "state",
    ])
    || checklist.schemaVersion !== 1
    || checklist.state !== "capture-required"
  ) {
    throw new Error("source provider plugin checklist must be schema-v1 capture-required state");
  }
  const site = siteId(boundedString(checklist.site, "checklist site", 63));
  const pluginId = boundedString(
    checklist.pluginId,
    "checklist plugin ID",
    runtimeManifestIdMaxLength,
  );
  if (!isProviderPluginId(pluginId) || pluginId !== webPluginId(site)) {
    throw new Error("source provider plugin checklist ID must match its web surface");
  }
  const operation = semanticOperation(
    boundedString(checklist.operation, "checklist operation", 163),
  );
  const risk = exactRisk(checklist.risk);
  assertSemanticRisk(operation, risk);
  const origin = exactOrigin(boundedString(checklist.origin, "checklist origin", 2_048));

  const sanitizedEvidence = record(
    checklist.sanitizedEvidence,
    "checklist sanitized evidence",
  );
  if (
    !exactKeys(sanitizedEvidence, ["candidateIndex", "sha256"])
    || !Number.isSafeInteger(sanitizedEvidence.candidateIndex)
    || (sanitizedEvidence.candidateIndex as number) < 0
    || !/^[a-f0-9]{64}$/u.test(
      boundedString(sanitizedEvidence.sha256, "checklist evidence hash", 64),
    )
  ) {
    throw new Error("source provider plugin checklist has invalid sanitized evidence binding");
  }
  const proofNames = [
    "accountBinding",
    "actorBinding",
    "authorizedLowStakesLiveFixture",
    "deterministicTests",
    "exactRequest",
    "exactResponse",
    "incidentalEffects",
    "secretScan",
    "targetBinding",
    "uncertaintyBehavior",
  ] as const;
  const proofs = record(checklist.proofs, "checklist proofs");
  if (
    !exactKeys(proofs, proofNames)
    || proofNames.some((name) => proofs[name] !== false)
  ) {
    throw new Error("capture-required source provider plugin proofs must all remain false");
  }

  const manifest = parseSourcePluginJson(
    sources["wrench-adapter.json"],
    adapterManifestName,
  );
  if (
    !exactKeys(manifest, [
      "browserDomains",
      "displayName",
      "id",
      "operations",
      "origins",
      "schemaVersion",
      "surfaceId",
      "version",
    ])
    || manifest.schemaVersion !== 4
    || manifest.id !== pluginId
    || manifest.surfaceId !== site
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(
      boundedString(manifest.version, "plugin manifest version", 64),
    )
    || boundedString(
      manifest.displayName,
      "plugin manifest display name",
      runtimeManifestDisplayNameMaxLength,
    ).length < 1
  ) {
    throw new Error("source provider plugin manifest identity does not match its checklist");
  }
  const origins = boundedStringArray(manifest.origins, "plugin manifest origins", 1, 2_048);
  const browserDomains = boundedStringArray(
    manifest.browserDomains,
    "plugin manifest browser domains",
    1,
    253,
  );
  if (
    origins.length !== 1
    || origins[0] !== origin.origin
    || browserDomains.length !== 1
    || browserDomains[0] !== origin.hostname
  ) {
    throw new Error("source provider plugin manifest origin does not match its checklist");
  }
  const operations = record(manifest.operations, "plugin manifest operations");
  if (!exactKeys(operations, [operation])) {
    throw new Error("source provider plugin manifest must reserve exactly its checklist operation");
  }
  const manifestOperation = record(
    operations[operation],
    "plugin manifest operation",
  );
  if (
    !exactKeys(manifestOperation, [
      "dedupeWindowMs",
      "description",
      "idempotency",
      "input",
      "risk",
      "sideEffect",
      "webSession",
    ])
    || manifestOperation.risk !== risk
    || !Number.isSafeInteger(manifestOperation.dedupeWindowMs)
    || (manifestOperation.dedupeWindowMs as number) < 0
    || (
      manifestOperation.idempotency !== "none"
      && manifestOperation.idempotency !== "local-at-most-once"
    )
  ) {
    throw new Error("source provider plugin manifest operation is not a bounded reservation");
  }
  boundedString(manifestOperation.description, "plugin manifest operation description", 4_096);
  boundedString(manifestOperation.sideEffect, "plugin manifest operation side effect", 4_096);
  const input = record(manifestOperation.input, "plugin manifest operation input");
  if (
    !exactKeys(input, ["properties", "required"])
    || Array.isArray(input.properties)
    || typeof input.properties !== "object"
    || input.properties === null
    || !Array.isArray(input.required)
  ) {
    throw new Error("source provider plugin manifest operation input is invalid");
  }
  record(input.properties, "plugin manifest operation input properties");
  boundedStringArray(input.required, "plugin manifest required inputs", 1_000, 128);
  const webSession = record(
    manifestOperation.webSession,
    "plugin manifest web-session selector",
  );
  if (
    !exactKeys(webSession, [
      "action",
      "contractVersion",
      "maxOutputBytes",
      "site",
      "timeoutMs",
    ])
    || webSession.site !== site
    || webSession.action !== operation
    || webSession.contractVersion !== 1
    || !Number.isSafeInteger(webSession.timeoutMs)
    || (webSession.timeoutMs as number) < 1
    || !Number.isSafeInteger(webSession.maxOutputBytes)
    || (webSession.maxOutputBytes as number) < 1
  ) {
    throw new Error("source provider plugin manifest selector does not match its checklist");
  }

  assertCanonicalSourcePluginLocation(directory, pluginId);
  const pluginSource = sources["plugin.ts"];
  if (
    !pluginSource.includes("defineProviderPlugin")
    || !pluginSource.includes("export default")
    || !pluginSource.includes(JSON.stringify(pluginId))
    || !pluginSource.includes(JSON.stringify(operation))
    || !pluginSource.includes('state: "capture-required"')
  ) {
    throw new Error("source provider plugin definition is not a capture-required v1 plugin");
  }
  assertCaptureRequiredRuntimeIsInert(sources["runtime.ts"]);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const name of [
    "plugin.ts",
    "runtime.ts",
    "plugin.test.ts",
    "runtime.internal.test.ts",
  ] as const) {
    try {
      transpiler.transformSync(sources[name]);
    } catch {
      throw new Error(`source provider plugin ${name} is not valid TypeScript syntax`);
    }
  }
  return Object.freeze({
    status: "capture-required",
    executable: false,
    pluginId,
    directory,
    files: SOURCE_PROVIDER_PLUGIN_FILES,
  });
}

export function scaffoldWebProvider(options: ScaffoldOptions): readonly string[] {
  const normalized: ScaffoldOptions = {
    ...options,
    site: siteId(options.site),
    displayName: displayName(options.displayName),
    operation: semanticOperation(options.operation),
    risk: exactRisk(options.risk),
  };
  assertSemanticRisk(normalized.operation, normalized.risk);
  const origin = exactOrigin(normalized.origin);
  const evidence = parseEvidence(
    normalized.evidencePath,
    origin.origin,
    normalized.candidateIndex,
  );
  const values = replacements(normalized, origin);
  const rendered: { path: string; content: string }[] = templateFiles.map(
    ([templateName, outputName]) => {
      const templatePath = join(templateDirectory, templateName);
      const source = readFileSync(templatePath, "utf8");
      return {
        path: outputName(),
        content: renderTemplate(source, values),
      };
    },
  );
  const checklist = {
    schemaVersion: 1,
    state: "capture-required",
    pluginId: webPluginId(normalized.site),
    site: normalized.site,
    operation: normalized.operation,
    origin: origin.origin,
    risk: normalized.risk,
    sanitizedEvidence: evidence,
    proofs: {
      exactRequest: false,
      exactResponse: false,
      accountBinding: false,
      actorBinding: false,
      targetBinding: false,
      incidentalEffects: false,
      uncertaintyBehavior: false,
      deterministicTests: false,
      authorizedLowStakesLiveFixture: false,
      secretScan: false,
    },
  } as const;
  rendered.push({
    path: "promotion-checklist.json",
    content: `${JSON.stringify(checklist, null, 2)}\n`,
  });

  const outputDirectory = prepareOutputDirectory(normalized.outputDirectory);
  const written: string[] = [];
  for (const file of rendered) {
    const target = join(outputDirectory, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    written.push(target);
  }
  return Object.freeze(written);
}

type ParsedArguments = ScaffoldOptions;

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      flag !== "--site"
      && flag !== "--display-name"
      && flag !== "--origin"
      && flag !== "--operation"
      && flag !== "--risk"
      && flag !== "--evidence"
      && flag !== "--candidate"
      && flag !== "--output"
    ) throw new Error(`unknown scaffold option ${flag ?? ""}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (values.has(flag)) throw new Error(`${flag} may appear only once`);
    values.set(flag, value);
    index += 1;
  }
  const required = [
    "--site",
    "--display-name",
    "--origin",
    "--operation",
    "--risk",
    "--evidence",
    "--candidate",
    "--output",
  ] as const;
  for (const flag of required) {
    if (!values.has(flag)) throw new Error(`missing required scaffold option ${flag}`);
  }
  const risk = values.get("--risk");
  if (risk !== "R1" && risk !== "R2" && risk !== "R3") {
    throw new Error("--risk must be R1, R2, or R3");
  }
  const candidateText = values.get("--candidate")!;
  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(candidateText)) {
    throw new Error("--candidate must be a zero-based integer");
  }
  return {
    site: values.get("--site")!,
    displayName: values.get("--display-name")!,
    origin: values.get("--origin")!,
    operation: values.get("--operation")!,
    risk,
    evidencePath: resolve(values.get("--evidence")!),
    candidateIndex: Number.parseInt(candidateText, 10),
    outputDirectory: resolve(values.get("--output")!),
  };
}

function usage(): string {
  return [
    "Usage:",
    "  scaffold-web-provider.ts --site <kebab-id> --display-name <name> \\",
    "    --origin <https-origin> --operation <semantic.action> --risk <R1|R2|R3> \\",
    "    --evidence </absolute/internal-api-evidence.json> --candidate <index> \\",
    "    --output </absolute/empty-directory>",
  ].join("\n");
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const files = scaffoldWebProvider(options);
    process.stdout.write(
      `${JSON.stringify({
        status: "capture-required",
        outputDirectory: options.outputDirectory,
        files: files.map((file) => file.slice(options.outputDirectory.length + 1)),
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `wrench provider scaffold: ${error instanceof Error ? error.message : "unknown failure"}\n${usage()}\n`,
    );
    process.exitCode = 1;
  }
}
