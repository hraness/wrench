import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  canonicalJson,
  isReviewedTemplateProtectedHostname,
  sha256,
  WRENCH_MANIFEST_SCHEMA_VERSION,
  WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION,
  WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION,
  type WrenchManifest,
} from "./model";
import {
  platformSurfaceIds,
  socialPlatformCatalog,
  type PlatformSurfaceId,
} from "./platform-catalog";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { readRegularFile, writePrivateJson, type PrivateDirectoryIdentity } from "./storage";

export const MAX_HAR_BYTES = 128 * 1024 * 1024;
export const MAX_HAR_ENTRIES = 20_000;
const MAX_SCAFFOLD_ENTRIES = 10_000;
const MAX_SCAFFOLD_BYTES = 256 * 1024 * 1024;
const MAX_SCAFFOLD_DEPTH = 32;
const MAX_TRANSACTION_ARTIFACTS = 1_000;

export type JsonShape =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | { readonly array: JsonShape | "empty" }
  | { readonly object: Readonly<Record<string, JsonShape>>; readonly truncated?: boolean };

export type HarCandidate = {
  readonly method: string;
  readonly origin: string;
  readonly pathTemplate: string;
  readonly firstParty: boolean;
  readonly reviewRequired: true;
  readonly sampleCount: number;
  readonly statuses: readonly number[];
  readonly mimeTypes: readonly string[];
  readonly queryKeys: readonly string[];
  readonly requestHeaderNames: readonly string[];
  readonly requestBodyKind: "none" | "json" | "form" | "text";
  readonly requestShape: JsonShape | null;
  readonly responseShape: JsonShape | null;
};

export type HarAnalysis = {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly targetOrigin: string;
  readonly browserDomains: readonly string[];
  readonly analyzedAt: string;
  readonly observedEntries: number;
  readonly ignoredEntries: number;
  readonly candidates: readonly HarCandidate[];
  readonly warnings: readonly string[];
};

export type ReviewedTemplateReservation = {
  readonly schemaVersion: 1;
  readonly state: "capture-required";
  readonly targetOrigin: string;
  readonly targetManifestSchemaVersion: 4 | 5;
  readonly evidence: {
    readonly path: "derivation.candidates.json";
    readonly sha256: string;
  };
  readonly instructions: readonly string[];
  readonly prohibited: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Browser derivation is allowed for exact public HTTPS targets, including
 * LinkedIn and X. Execution remains separately gated by reviewed manifests;
 * recording traffic alone never authorizes or exposes a request capability.
 */
export function assertBrowserDerivationTargetAllowed(target: URL): void {
  if (target.protocol !== "https:" || target.username !== "" || target.password !== "") {
    throw new Error("browser derivation requires an exact public HTTPS target");
  }
}

const staticRouteSegments = new Set([
  "api", "graphql", "rest", "rpc", "voyager", "messaging", "messages", "conversation", "conversations",
  "inbox", "feed", "posts", "comments", "reactions", "search", "query", "mutation", "realtime", "presence",
  "status", "statuses", "notifications", "profile", "profiles", "users", "member", "members", "dash", "internal",
  "public", "private", "content", "read", "write", "send", "create", "update", "delete", "list", "detail",
  "details", "home", "in",
]);

function safeStaticSegment(value: string): boolean {
  const lower = value.toLowerCase();
  return staticRouteSegments.has(lower)
    || /^v\d{1,3}$/u.test(lower);
}

export function safePathTemplate(pathname: string): string {
  if (pathname.length > 4_096 || pathname.split("/").length > 128) return "/:oversized-path";
  let parameter = 0;
  const rendered = pathname.split("/").map((segment) => {
    if (segment === "" || safeStaticSegment(segment)) return segment;
    parameter += 1;
    return `:segment${parameter}`;
  }).join("/");
  return rendered.startsWith("/") ? rendered : `/${rendered}`;
}

function mergeShapes(left: JsonShape | null, right: JsonShape | null): JsonShape | null {
  if (left === null) return right;
  if (right === null) return left;
  if (typeof left === "string" || typeof right === "string") return left === right ? left : "string";
  if ("array" in left && "array" in right) {
    if (left.array === "empty") return right;
    if (right.array === "empty") return left;
    return { array: mergeShapes(left.array, right.array) ?? "empty" };
  }
  if ("object" in left && "object" in right) {
    const keys = [...new Set([...Object.keys(left.object), ...Object.keys(right.object)])].sort().slice(0, 200);
    const object: Record<string, JsonShape> = {};
    for (const key of keys) {
      object[key] = mergeShapes(left.object[key] ?? null, right.object[key] ?? null) ?? "null";
    }
    return { object, ...((left.truncated === true || right.truncated === true || keys.length >= 200) ? { truncated: true } : {}) };
  }
  return "string";
}

export function jsonShape(value: unknown, depth = 0): JsonShape {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (depth >= 8) return "string";
  if (Array.isArray(value)) {
    let item: JsonShape | null = null;
    for (const candidate of value.slice(0, 20)) item = mergeShapes(item, jsonShape(candidate, depth + 1));
    return { array: item ?? "empty" };
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const object: Record<string, JsonShape> = {};
    for (const [index, key] of keys.slice(0, 200).entries()) {
      // Object keys are data too: GraphQL aliases, form fields, and custom
      // payloads routinely contain account IDs, emails, or message text.
      object[`field${index + 1}`] = jsonShape(value[key], depth + 1);
    }
    return { object, ...(keys.length > 200 ? { truncated: true } : {}) };
  }
  return "string";
}

function parsedJson(text: unknown, maximumBytes = 2 * 1024 * 1024): unknown {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > maximumBytes) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const stableHeaderNames = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control", "content-length", "content-type",
  "if-match", "if-modified-since", "if-none-match", "origin", "pragma", "range", "referer", "user-agent",
]);

function headerCategory(name: string): string {
  const lower = name.toLowerCase();
  if (lower === "authorization" || lower === "proxy-authorization") return "authorization";
  if (lower === "cookie" || lower === "set-cookie") return "cookie";
  if (lower.includes("csrf") || lower.includes("xsrf")) return "csrf-token";
  return stableHeaderNames.has(lower) ? lower : "custom-header";
}

function headerNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string") return [];
    return /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/iu.test(entry.name) ? [headerCategory(entry.name)] : [];
  }))].sort().slice(0, 200);
}

function mimeCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if ([
    "application/json", "application/graphql-response+json", "application/xml", "application/octet-stream",
    "text/html", "text/plain", "text/event-stream", "text/css", "text/xml",
  ].includes(base)) return base;
  if (/^(?:image|audio|video|font)\/[a-z0-9.+-]{1,64}$/u.test(base)) return `${base.split("/", 1)[0]}/*`;
  return base === "" ? null : "other";
}

function postData(value: unknown): {
  readonly kind: HarCandidate["requestBodyKind"];
  readonly shape: JsonShape | null;
} {
  if (!isRecord(value)) return { kind: "none", shape: null };
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.toLowerCase() : "";
  const text = typeof value.text === "string" ? value.text : null;
  if (mimeType.includes("json")) {
    const parsed = parsedJson(text);
    return { kind: "json", shape: parsed === null ? null : jsonShape(parsed) };
  }
  if (mimeType.includes("x-www-form-urlencoded") || Array.isArray(value.params)) {
    const count = Array.isArray(value.params)
      ? Math.min(200, new Set(value.params.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" ? [entry.name] : [])).size)
      : 0;
    return {
      kind: "form",
      shape: { object: Object.fromEntries(Array.from({ length: count }, (_unused, index) => [`field${index + 1}`, "string" as const])) },
    };
  }
  return { kind: text === null ? "none" : "text", shape: null };
}

function responseDetails(value: unknown): { readonly status: number | null; readonly mimeType: string | null; readonly shape: JsonShape | null } {
  if (!isRecord(value)) return { status: null, mimeType: null, shape: null };
  const status = typeof value.status === "number" && Number.isSafeInteger(value.status) ? value.status : null;
  const content = isRecord(value.content) ? value.content : null;
  const rawMimeType = content !== null && typeof content.mimeType === "string" ? content.mimeType : null;
  const mimeType = mimeCategory(rawMimeType);
  const parsed = content === null || rawMimeType?.toLowerCase().includes("json") !== true ? null : parsedJson(content.text);
  return { status, mimeType, shape: parsed === null ? null : jsonShape(parsed) };
}

type CandidateAccumulator = {
  method: string;
  origin: string;
  pathTemplate: string;
  firstParty: boolean;
  sampleCount: number;
  statuses: Set<number>;
  mimeTypes: Set<string>;
  queryKeys: Set<string>;
  requestHeaderNames: Set<string>;
  requestBodyKind: HarCandidate["requestBodyKind"];
  requestShape: JsonShape | null;
  responseShape: JsonShape | null;
};

function parseHarRoot(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !isRecord(value.log) || !Array.isArray(value.log.entries)) throw new Error("HAR must contain log.entries[]");
  if (value.log.entries.length > MAX_HAR_ENTRIES) throw new Error(`HAR contains more than ${MAX_HAR_ENTRIES} entries`);
  return value.log.entries;
}

function normalizedBrowserDomains(values: readonly string[] | undefined, hostname: string): readonly string[] {
  const domains = values ?? [hostname];
  if (
    domains.length < 1
    || domains.length > 100
    || domains.some((domain) => !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(domain) || domain.includes(".."))
  ) throw new Error("browser domains must contain 1-100 exact or wildcard hostnames");
  const normalized = [...new Set(domains.map((domain) => domain.toLowerCase()))];
  if (!normalized.some((domain) => domain === hostname || (domain.startsWith("*.") && (hostname === domain.slice(2) || hostname.endsWith(`.${domain.slice(2)}`))))) {
    throw new Error("browser domains must cover the target hostname");
  }
  return normalized;
}

/** Analyze a bounded HAR without retaining headers, cookies, body values, URLs, or private response content. */
export function analyzeHarValue(
  value: unknown,
  adapterId: string,
  targetOrigin: string,
  now = new Date(),
  browserDomains?: readonly string[],
): HarAnalysis {
  const target = new URL(targetOrigin);
  if (target.protocol !== "https:" || target.origin !== targetOrigin) throw new Error("target origin must be an exact HTTPS origin");
  assertBrowserDerivationTargetAllowed(target);
  const entries = parseHarRoot(value);
  const domains = normalizedBrowserDomains(browserDomains, target.hostname.toLowerCase());
  const candidates = new Map<string, CandidateAccumulator>();
  let ignoredEntries = 0;
  for (const rawEntry of entries) {
    if (!isRecord(rawEntry) || !isRecord(rawEntry.request)) {
      ignoredEntries += 1;
      continue;
    }
    const rawMethod = typeof rawEntry.request.method === "string" ? rawEntry.request.method.toUpperCase() : "";
    const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"].includes(rawMethod)
      ? rawMethod
      : "OTHER";
    const rawUrl = rawEntry.request.url;
    if (!/^[A-Z]{3,12}$/u.test(rawMethod) || typeof rawUrl !== "string" || rawUrl.length > 64 * 1024) {
      ignoredEntries += 1;
      continue;
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      ignoredEntries += 1;
      continue;
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
      ignoredEntries += 1;
      continue;
    }
    const pathTemplate = safePathTemplate(url.pathname);
    const key = `${method}\0${url.origin}\0${pathTemplate}`;
    const requestBody = postData(rawEntry.request.postData);
    const response = responseDetails(rawEntry.response);
    if (url.origin !== target.origin) {
      ignoredEntries += 1;
      continue;
    }
    if (!candidates.has(key) && candidates.size >= 5_000) {
      ignoredEntries += 1;
      continue;
    }
    const current = candidates.get(key) ?? {
      method,
      origin: url.origin,
      pathTemplate,
      firstParty: url.origin === target.origin,
      sampleCount: 0,
      statuses: new Set<number>(),
      mimeTypes: new Set<string>(),
      queryKeys: new Set<string>(),
      requestHeaderNames: new Set<string>(),
      requestBodyKind: requestBody.kind,
      requestShape: null,
      responseShape: null,
    };
    current.sampleCount += 1;
    if (response.status !== null && current.statuses.size < 50) current.statuses.add(response.status);
    if (response.mimeType !== null && current.mimeTypes.size < 100) current.mimeTypes.add(response.mimeType);
    const queryCount = Math.min(200, new Set(url.searchParams.keys()).size);
    for (let index = 0; index < queryCount; index += 1) {
      current.queryKeys.add(`query${index + 1}`);
    }
    for (const name of headerNames(rawEntry.request.headers)) {
      if (current.requestHeaderNames.size >= 200) break;
      current.requestHeaderNames.add(name);
    }
    if (current.requestBodyKind !== requestBody.kind) current.requestBodyKind = "text";
    current.requestShape = mergeShapes(current.requestShape, requestBody.shape);
    current.responseShape = mergeShapes(current.responseShape, response.shape);
    candidates.set(key, current);
  }
  const output = [...candidates.values()]
    .filter((candidate) => !/\.(?:css|js|png|jpe?g|gif|svg|woff2?|ico|map)$/iu.test(candidate.pathTemplate))
    .sort((left, right) => Number(right.firstParty) - Number(left.firstParty) || right.sampleCount - left.sampleCount || left.pathTemplate.localeCompare(right.pathTemplate))
    .slice(0, 2_000)
    .map((candidate): HarCandidate => ({
      method: candidate.method,
      origin: candidate.origin,
      pathTemplate: candidate.pathTemplate,
      firstParty: candidate.firstParty,
      reviewRequired: true,
      sampleCount: candidate.sampleCount,
      statuses: [...candidate.statuses].sort((left, right) => left - right),
      mimeTypes: [...candidate.mimeTypes].sort(),
      queryKeys: [...candidate.queryKeys].sort(),
      requestHeaderNames: [...candidate.requestHeaderNames].sort(),
      requestBodyKind: candidate.requestBodyKind,
      requestShape: candidate.requestShape,
      responseShape: candidate.responseShape,
    }));
  return {
    schemaVersion: 1,
    adapterId,
    targetOrigin,
    browserDomains: domains,
    analyzedAt: now.toISOString(),
    observedEntries: entries.length,
    ignoredEntries,
    candidates: output,
    warnings: [
      "Every candidate is disabled until a human or agent reviews its semantics; HTTP method does not establish whether an endpoint mutates state.",
      "This report keeps only exact-target-origin structural route tokens and abstract field/header/query categories; it omits cross-origin paths, URLs, path values, field names, query names and values, custom header names and values, cookies, request values, response values, and raw bodies.",
    ],
  };
}

export function analyzeHarFile(
  path: string,
  adapterId: string,
  targetOrigin: string,
  browserDomains?: readonly string[],
  expectedParent?: Readonly<PrivateDirectoryIdentity>,
): HarAnalysis {
  const target = new URL(targetOrigin);
  if (target.protocol !== "https:" || target.origin !== targetOrigin) throw new Error("target origin must be an exact HTTPS origin");
  assertBrowserDerivationTargetAllowed(target);
  return analyzeHarValue(
    JSON.parse(readRegularFile(path, MAX_HAR_BYTES, "HAR input", expectedParent)) as unknown,
    adapterId,
    targetOrigin,
    new Date(),
    browserDomains,
  );
}

export function emptyManifest(
  adapterId: string,
  targetOrigin: string,
  browserDomains?: readonly string[],
  surfaceId?: PlatformSurfaceId,
): WrenchManifest {
  if (!/^[a-z][a-z0-9-]{0,47}$/u.test(adapterId)) throw new Error("adapter ID must be lowercase kebab-case");
  const origin = new URL(targetOrigin);
  if (origin.protocol !== "https:" || origin.origin !== targetOrigin) throw new Error("target origin must be an exact HTTPS origin");
  const inferredSurfaces = platformSurfaceIds.filter((candidate) =>
    socialPlatformCatalog[candidate].originPolicy.exactOrigins.includes(targetOrigin as `https://${string}`));
  if (surfaceId === undefined && inferredSurfaces.length > 1) {
    throw new Error(
      `target origin matches multiple reviewed surfaces (${inferredSurfaces.join(", ")}); select one with --platform`,
    );
  }
  if (surfaceId !== undefined && inferredSurfaces.length > 0 && !inferredSurfaces.includes(surfaceId)) {
    throw new Error(`target origin belongs to ${inferredSurfaces.join(", ")}, not the selected ${surfaceId} surface`);
  }
  const effectiveSurfaceId = surfaceId ?? (inferredSurfaces.length === 1 ? inferredSurfaces[0] : undefined);
  let origins = [targetOrigin];
  let domains = normalizedBrowserDomains(browserDomains, origin.hostname.toLowerCase());
  if (effectiveSurfaceId !== undefined) {
    const surface = socialPlatformCatalog[effectiveSurfaceId];
    const exact = new Set<string>(surface.originPolicy.exactOrigins);
    if (!exact.has(targetOrigin)) {
      if (surface.originPolicy.additionalExactOrigins.state === "forbidden") {
        throw new Error(`target origin is outside the reviewed ${effectiveSurfaceId} origin policy`);
      }
      const baseOrigin = surface.originPolicy.exactOrigins[0];
      if (baseOrigin === undefined) throw new Error(`${effectiveSurfaceId} has no reviewed base origin`);
      origins = [baseOrigin, targetOrigin];
      domains = normalizedBrowserDomains([
        ...domains,
        new URL(baseOrigin).hostname.toLowerCase(),
      ], origin.hostname.toLowerCase());
    }
  }
  return {
    schemaVersion: WRENCH_MANIFEST_SCHEMA_VERSION,
    id: adapterId,
    version: "0.1.0",
    displayName: adapterId.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" "),
    ...(effectiveSurfaceId === undefined ? {} : { surfaceId: effectiveSurfaceId }),
    origins,
    browserDomains: domains,
    operations: {},
  };
}

function derivedManifest(
  adapterId: string,
  targetOrigin: string,
  browserDomains: readonly string[],
  registry: ProviderPluginRegistry,
  surfaceId?: PlatformSurfaceId,
): WrenchManifest {
  const base = emptyManifest(adapterId, targetOrigin, browserDomains, surfaceId);
  const protectedHostname = isReviewedTemplateProtectedHostname(
    new URL(targetOrigin).hostname,
    registry,
  );
  return {
    ...base,
    schemaVersion: base.surfaceId === "linkedin" || base.surfaceId === "x" || protectedHostname
      ? WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION
      : WRENCH_REVIEWED_TEMPLATE_MANIFEST_SCHEMA_VERSION,
  };
}

export function reviewedTemplateReservation(analysis: HarAnalysis, manifest: WrenchManifest): ReviewedTemplateReservation {
  const codeOwned = manifest.schemaVersion === WRENCH_WEB_SESSION_MANIFEST_SCHEMA_VERSION;
  return {
    schemaVersion: 1,
    state: "capture-required",
    targetOrigin: analysis.targetOrigin,
    targetManifestSchemaVersion: codeOwned ? 4 : 5,
    evidence: {
      path: "derivation.candidates.json",
      sha256: sha256(canonicalJson(analysis)),
    },
    instructions: codeOwned
      ? [
          "This origin requires a code-owned schemaVersion 4 contract; do not convert captured traffic into a generic executable template.",
          "Use the capture only as review evidence when updating the provider plugin that owns this protected hostname family.",
        ]
      : [
          "Choose one semantic operation and classify its R1, R2, or R3 risk from behavior, never from its HTTP method.",
          "Review exact request method, path segments, typed input sinks, non-secret fixed headers, cookie/CSRF sources, response variants, projections, and target bindings.",
          "Keep every schemaVersion 5 operation at reviewedTemplate.state capture-required; version 1 is an inert reservation and cannot plan or execute even an R1 read.",
          "Implement a code-owned contract for executable operations today; a future reviewed-template contractVersion 2 must add a reviewed current-account identity preflight and response-scope binding.",
          "Install only after an explicit review; this capture-required reservation is intentionally non-executable.",
        ],
    prohibited: [
      "Do not copy cookies, authorization values, CSRF values, request values, response values, or raw HAR bodies into the manifest.",
      "Do not infer an executable template or promote a candidate automatically from this structural report.",
      "Do not use wildcard origins, arbitrary URLs, arbitrary headers, scripts, eval, or DOM automation.",
    ],
  };
}

function syncPath(path: string, directory: boolean): void {
  if (process.platform === "win32") return;
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const directoryOnly = directory && "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow | directoryOnly);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copyScaffoldTree(
  source: string,
  target: string,
  budget: { entries: number; bytes: number },
  depth = 0,
): void {
  if (depth > MAX_SCAFFOLD_DEPTH) throw new Error(`scaffold directory exceeds depth ${MAX_SCAFFOLD_DEPTH}`);
  const sourceStats = lstatSync(source);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) throw new Error(`scaffold source must be a real directory: ${source}`);
  mkdirSync(target, { mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    budget.entries += 1;
    if (budget.entries > MAX_SCAFFOLD_ENTRIES) throw new Error(`scaffold directory exceeds ${MAX_SCAFFOLD_ENTRIES} entries`);
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    const stats = lstatSync(sourcePath);
    if (stats.isSymbolicLink()) throw new Error(`scaffold directory contains a symbolic link: ${sourcePath}`);
    if (stats.isDirectory()) {
      copyScaffoldTree(sourcePath, targetPath, budget, depth + 1);
      continue;
    }
    if (!stats.isFile()) throw new Error(`scaffold directory contains a non-regular entry: ${sourcePath}`);
    budget.bytes += stats.size;
    if (budget.bytes > MAX_SCAFFOLD_BYTES) throw new Error(`scaffold directory exceeds ${MAX_SCAFFOLD_BYTES} bytes`);
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, stats.mode & 0o777);
    syncPath(targetPath, false);
  }
  chmodSync(target, 0o700);
  syncPath(target, true);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function transactionArtifacts(parent: string, outputName: string): readonly {
  readonly path: string;
  readonly kind: "stage" | "backup";
  readonly pid: number;
}[] {
  const prefixes = [
    `.${outputName}.wrench-scaffold-`,
    `.${outputName}.oh-scaffold-`,
  ] as const;
  const artifacts: { path: string; kind: "stage" | "backup"; pid: number }[] = [];
  let overflow = false;
  const directory = opendirSync(parent);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const prefix = prefixes.find((candidate) => entry.name.startsWith(candidate));
      if (prefix === undefined) continue;
      const suffix = entry.name.slice(prefix.length);
      const match = /^(stage|backup)-(\d+)-[0-9a-f-]{36}$/u.exec(suffix);
      if (match === null) continue;
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid < 1) continue;
      if (artifacts.length >= MAX_TRANSACTION_ARTIFACTS) {
        overflow = true;
        continue;
      }
      artifacts.push({ path: join(parent, entry.name), kind: match[1] as "stage" | "backup", pid });
    }
  } finally {
    directory.closeSync();
  }
  if (overflow) throw new Error(`scaffold output parent contains more than ${MAX_TRANSACTION_ARTIFACTS} transaction artifacts`);
  return artifacts;
}

function assertParentTransactionCapacity(parent: string, outputExists: boolean): void {
  let entries = 0;
  const directory = opendirSync(parent);
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      entries += 1;
      const maximumExisting = outputExists ? MAX_SCAFFOLD_ENTRIES - 1 : MAX_SCAFFOLD_ENTRIES - 2;
      if (entries > maximumExisting) {
        throw new Error(`scaffold output parent lacks bounded capacity for an atomic transaction (limit ${MAX_SCAFFOLD_ENTRIES})`);
      }
    }
  } finally {
    directory.closeSync();
  }
}

function recoverScaffoldTransactions(parent: string, output: string): void {
  const artifacts = transactionArtifacts(parent, basename(output));
  const active = artifacts.find((artifact) => processIsAlive(artifact.pid));
  if (active !== undefined) throw new Error(`another scaffold writer owns a transaction for: ${output}`);
  const backups = artifacts.filter((artifact) => artifact.kind === "backup");
  if (!existsSync(output) && backups.length > 1) {
    throw new Error(`multiple interrupted scaffold backups require manual recovery beside: ${output}`);
  }
  if (!existsSync(output) && backups[0] !== undefined) {
    renameSync(backups[0].path, output);
    syncPath(parent, true);
  }
  for (const artifact of artifacts) {
    if (artifact.path === backups[0]?.path && existsSync(output)) {
      if (!existsSync(artifact.path)) continue;
    }
    rmSync(artifact.path, { recursive: true, force: true });
  }
  if (artifacts.length > 0) syncPath(parent, true);
}

export function writeDerivationScaffold(
  outputDirectory: string,
  analysis: HarAnalysis,
  options: {
    readonly force: boolean;
    readonly registry: ProviderPluginRegistry;
    readonly surfaceId?: PlatformSurfaceId;
    readonly extraFiles?: Readonly<Record<string, unknown>>;
  },
): {
  readonly manifestPath: string;
  readonly candidatesPath: string;
  readonly reservationPath: string;
} {
  const target = new URL(analysis.targetOrigin);
  if (target.protocol !== "https:" || target.origin !== analysis.targetOrigin) {
    throw new Error("target origin must be an exact HTTPS origin");
  }
  assertBrowserDerivationTargetAllowed(target);
  const output = resolve(outputDirectory);
  const parent = dirname(output);
  if (parent === output) throw new Error("scaffold output cannot be a filesystem root");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStats = lstatSync(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new Error(`output parent must be a real directory: ${parent}`);
  recoverScaffoldTransactions(parent, output);
  assertParentTransactionCapacity(parent, existsSync(output));
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const manifestPath = join(output, "wrench-adapter.json");
  const candidatesPath = join(output, "derivation.candidates.json");
  const reservationPath = join(output, "reviewed-template.reservation.json");
  const staging = join(parent, `.${basename(output)}.wrench-scaffold-stage-${token}`);
  let backup: string | null = null;
  try {
    assertScaffoldOutput(output, options.force);
    if (existsSync(output)) copyScaffoldTree(output, staging, { entries: 0, bytes: 0 });
    else {
      mkdirSync(staging, { mode: 0o700 });
      chmodSync(staging, 0o700);
    }
    const manifest = derivedManifest(
      analysis.adapterId,
      analysis.targetOrigin,
      analysis.browserDomains,
      options.registry,
      options.surfaceId,
    );
    writePrivateJson(join(staging, "wrench-adapter.json"), manifest);
    writePrivateJson(join(staging, "derivation.candidates.json"), analysis);
    writePrivateJson(
      join(staging, "reviewed-template.reservation.json"),
      reviewedTemplateReservation(analysis, manifest),
    );
    for (const [name, contents] of Object.entries(options.extraFiles ?? {})) {
      if (!/^[a-z][a-z0-9.-]{0,100}\.json$/u.test(name) || name.includes("..")) {
        throw new Error("scaffold extra file has an unsafe name");
      }
      writePrivateJson(join(staging, name), contents);
    }
    syncPath(staging, true);
    if (existsSync(output)) {
      backup = join(parent, `.${basename(output)}.wrench-scaffold-backup-${token}`);
      renameSync(output, backup);
      syncPath(parent, true);
    }
    try {
      renameSync(staging, output);
      syncPath(parent, true);
    } catch (error) {
      if (backup !== null && !existsSync(output) && existsSync(backup)) {
        renameSync(backup, output);
        backup = null;
        syncPath(parent, true);
      }
      throw error;
    }
    if (backup !== null) {
      rmSync(backup, { recursive: true, force: true });
      backup = null;
      syncPath(parent, true);
    }
    return { manifestPath, candidatesPath, reservationPath };
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}

export function assertScaffoldOutput(outputDirectory: string, force: boolean): void {
  const output = resolve(outputDirectory);
  if (existsSync(output) && !force) throw new Error(`output already exists: ${output}`);
  if (existsSync(output)) {
    const stats = lstatSync(output);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`output must be a real directory: ${output}`);
  }
}
