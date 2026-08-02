import { acquireCookieRecords, type CookieSelection } from "@hraness/kb/clip/acquire";
import { filterCookies, renderCookieHeader } from "@hraness/kb/clip/cookies";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WrenchAuth } from "./auth";
import type { BrowserFileResolver } from "./browser";
import {
  type FileInputValue,
  type WrenchManifest,
  type OperationInput,
  canonicalJson,
} from "./model";
import { OperationDeadline } from "./operation-deadline";
import {
  createPinnedHttpsFetchScope,
  type PinnedHttpsFetch,
  type PinnedHttpsFetchScope,
} from "./pinned-https";
import {
  type ProviderPluginBindingDefinitionV1,
  type ProviderPluginOperationDefinitionV1,
  type ProviderApiPluginOperationDefinitionV1,
  type WebSessionPluginOperationDefinitionV1,
  type ProviderPluginSubjectDefinitionV1,
  type ProviderPluginSubjectProbeOptionsV1,
} from "./provider-plugin";
import {
  runPortableProviderPluginHost,
  type PortableProviderPluginCapabilityHost,
  type PortableProviderPluginHostResult,
} from "./provider-plugin-host";
import {
  registerPortableProviderPluginCleanupBarrier,
  settlePortableProviderPluginCleanup,
  trackPortableProviderPluginHostCompletion,
  type PortableProviderPluginCleanupBarrier,
} from "./provider-plugin-cleanup-barrier";
import {
  acquirePortableProviderPluginInvocationLease,
  createPortableProviderPluginInvocationLeaseContainmentController,
  releasePortableProviderPluginInvocationLease,
} from "./provider-plugin-invocation-lease";
import type {
  PortableProviderPluginBindingV1,
  PortableProviderPluginOperationV1,
  VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  createPortableOperationIdentityV1,
} from "./provider-plugin-portable-identity";
import type {
  PortablePluginCapabilityRequest,
  PortablePluginCapabilityResult,
  PortablePluginHttpBody,
  PortablePluginInvocationFile,
  PortablePluginJsonObject,
  PortablePluginJsonValue,
  PortablePluginVersionedStateResult,
} from "./provider-plugin-protocol";
import {
  normalizePortablePluginJsonObject,
  normalizePortablePluginJsonValue,
} from "./provider-plugin-protocol";
import {
  loadOAuthToken,
} from "./provider-http";
import { summarizePlanFile } from "./plan-assets";
import {
  createPrivateJsonIfAbsent,
  wrenchStateHome,
  readPrivateStateFileIfPresent,
  removePrivateStateFile,
  removePrivateStateFileIfUnchanged,
  writePrivateJson,
  writePrivateJsonIfUnchanged,
} from "./storage";
import type {
  ProviderActionContext,
} from "./provider";
import type {
  WebSessionDispatchEvent,
  WebSessionExecution,
  WebSessionOperationDeadline,
  WebSessionOperationExecutor,
} from "./web-session-execution";

type Environment = Readonly<Record<string, string | undefined>>;

const PORTABLE_HOST_VERSION = "io-portable-host-v1";
const WEB_SESSION_OPERATION_LABEL = "authenticated web operation deadline";
const MAX_PORTABLE_STATE_BYTES = 512 * 1024;
const MAX_PORTABLE_RESPONSE_HEADERS = 64;
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "cache-control",
  "content-language",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "location",
  "retry-after",
  "vary",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

export type PortableProviderRuntimeDependencies = {
  readonly runHost: typeof runPortableProviderPluginHost;
  readonly createFetchScope: typeof createPinnedHttpsFetchScope;
  readonly acquireCookies: typeof acquireCookieRecords;
  readonly loadToken: typeof loadOAuthToken;
  readonly closeBoundFile: (descriptor: number) => void;
  /** Internal deterministic seam for pre-transfer descriptor cleanup. */
  readonly closePlanFileBindingDescriptor: (descriptor: number) => void;
  /** Internal deterministic seam for the private snapshot staging directory. */
  readonly removePlanFileBindingDirectory: (
    path: string,
    force: boolean,
  ) => void;
};

const defaultDependencies: PortableProviderRuntimeDependencies = {
  runHost: runPortableProviderPluginHost,
  createFetchScope: createPinnedHttpsFetchScope,
  acquireCookies: acquireCookieRecords,
  loadToken: loadOAuthToken,
  closeBoundFile: closeSync,
  closePlanFileBindingDescriptor: closeSync,
  removePlanFileBindingDirectory: (path, force) =>
    rmSync(path, { recursive: true, force }),
};

const resolvedPortableProviderRuntimeDependencies = new WeakSet<object>();
const portableRuntimeDependencyKeys = Object.freeze([
  "runHost",
  "createFetchScope",
  "acquireCookies",
  "loadToken",
  "closeBoundFile",
  "closePlanFileBindingDescriptor",
  "removePlanFileBindingDirectory",
] as const);

export function resolvePortableProviderRuntimeDependencies(
  overrides: Partial<PortableProviderRuntimeDependencies>,
): PortableProviderRuntimeDependencies {
  if (
    typeof overrides !== "object"
    || overrides === null
    || Array.isArray(overrides)
  ) {
    throw new Error(
      "portable provider runtime dependency overrides must be a plain data object",
    );
  }
  const actualKeys = Reflect.ownKeys(overrides);
  const allowedKeys = new Set<PropertyKey>(portableRuntimeDependencyKeys);
  if (actualKeys.some((key) => !allowedKeys.has(key))) {
    throw new Error(
      "portable provider runtime dependency overrides contain unsupported keys",
    );
  }
  if (
    actualKeys.length > 0
    && process.env.NODE_ENV !== "test"
  ) {
    throw new Error(
      "portable provider runtime dependency overrides are available only in tests",
    );
  }
  const snapshot: Partial<PortableProviderRuntimeDependencies> = {};
  for (const key of actualKeys) {
    if (typeof key !== "string") {
      throw new Error(
        "portable provider runtime dependency overrides contain unsupported keys",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
      || typeof descriptor.value !== "function"
    ) {
      throw new Error(
        `portable provider runtime dependency override ${key} must be an enumerable function data property`,
      );
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  const dependencies = Object.freeze({
    ...defaultDependencies,
    ...snapshot,
  });
  resolvedPortableProviderRuntimeDependencies.add(dependencies);
  return dependencies;
}

export function isResolvedPortableProviderRuntimeDependencies(
  value: unknown,
): value is PortableProviderRuntimeDependencies {
  return (
    typeof value === "object"
    && value !== null
    && resolvedPortableProviderRuntimeDependencies.has(value)
  );
}

export type KernelPortableProviderPluginBindingProjection = {
  readonly adapterId: string;
  readonly manifest: WrenchManifest;
  readonly portableBinding: PortableProviderPluginBindingV1;
  readonly binding: ProviderPluginBindingDefinitionV1;
};

type BoundInvocationFile = {
  readonly descriptor: number;
  readonly dispose: () => void;
  readonly protocol: PortablePluginInvocationFile;
};

class UnverifiedPlanFileBindingCleanupError extends Error {
  constructor(resource: string, cause: unknown) {
    super(
      `portable plugin plan-file ${resource} cleanup could not be verified`,
      { cause },
    );
    this.name = "UnverifiedPlanFileBindingCleanupError";
  }
}

function disposePortableRuntimeResources(
  cleanupBarrier: PortableProviderPluginCleanupBarrier,
  fetchScope: PinnedHttpsFetchScope | undefined,
  files: readonly BoundInvocationFile[],
): void {
  let cleanupError: unknown = null;
  try {
    fetchScope?.close();
  } catch (error) {
    cleanupError = error;
  }
  for (const file of files) {
    try {
      file.dispose();
    } catch (error) {
      if (cleanupError === null) cleanupError = error;
    }
  }
  if (cleanupError === null) {
    cleanupBarrier.verified();
    return;
  }
  cleanupBarrier.unsafe(cleanupError);
  throw new Error(
    "portable provider plugin runtime resource cleanup failed",
    { cause: cleanupError },
  );
}

type DispatchBoundary = {
  readonly verify: () => Promise<void>;
};

type PortableCapabilityActivity = {
  readonly begin: () => () => void;
  readonly whenIdle: () => Promise<void>;
};

const PORTABLE_CAPABILITY_ABORT_JOIN_MS = 500;

async function settlesWithin<T>(
  operation: Promise<T>,
  maximumMs: number,
): Promise<PromiseSettledResult<T> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        (value): PromiseFulfilledResult<T> => ({
          status: "fulfilled",
          value,
        }),
        (reason: unknown): PromiseRejectedResult => ({
          status: "rejected",
          reason,
        }),
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), maximumMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createPortableCapabilityActivity(): PortableCapabilityActivity {
  let active = 0;
  const waiters = new Set<() => void>();
  return Object.freeze({
    begin: () => {
      active += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        active -= 1;
        if (active !== 0) return;
        for (const resolve of waiters) resolve();
        waiters.clear();
      };
    },
    whenIdle: () => active === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.add(resolve);
        }),
  });
}

type CapabilityMaterial =
  | { readonly kind: "oauth-access-token"; readonly value: string }
  | { readonly kind: "cookie-jar"; readonly auth: WrenchAuth };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableSubject(
  value: PortableProviderPluginBindingV1["subject"],
): ProviderPluginSubjectDefinitionV1 {
  const matches = (candidate: string): boolean => {
    if (
      typeof candidate !== "string"
      || candidate.length < 1
      || Buffer.byteLength(candidate, "utf8") > 256
      || /[\0-\x20\x7f]/u.test(candidate)
    ) return false;
    if (value.kind === "opaque-token") {
      return /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u.test(candidate);
    }
    if (value.kind === "decimal") return /^(?:0|[1-9][0-9]{0,127})$/u.test(candidate);
    if (value.kind === "did") {
      return /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,220}$/u.test(candidate);
    }
    if (value.kind === "uuid") {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate);
    }
    return /^\+[1-9][0-9]{6,14}$/u.test(candidate);
  };
  return Object.freeze({ format: value.format, matches });
}

function plannedDispatches(
  operation: PortableProviderPluginOperationV1,
): ProviderPluginOperationDefinitionV1["planDispatches"] {
  if (operation.dispatch === "none") return () => Object.freeze([]);
  const schedule = Object.freeze([Object.freeze({
    id: operation.name,
    description: operation.sideEffect,
  })]);
  return () => schedule;
}

function portableOperation(
  operation: PortableProviderPluginOperationV1,
): ProviderPluginOperationDefinitionV1 {
  const common = {
    name: operation.name,
    contractVersion: operation.contractVersion,
    risk: operation.risk,
    input: operation.input,
    sideEffect: operation.sideEffect,
    idempotency: operation.idempotency,
    dedupeWindowMs: operation.dedupeWindowMs,
    state: operation.state,
    dispatch: operation.dispatch,
    implementation: operation.implementation,
    planDispatches: plannedDispatches(operation),
    validateInput: () => Object.freeze([]),
    ...(
      operation.name === "messaging.list"
      || operation.name === "messaging.read"
        ? {
            omni: Object.freeze({
              state: "unsupported" as const,
              reason: "portable provider plugins do not yet attest a versioned output materializer",
            }),
          }
        : {}
    ),
  } as const;
  return (
    operation.requiredScopeSets !== undefined
    && operation.coverage !== undefined
  )
    ? {
        ...common,
        requiredScopeSets: operation.requiredScopeSets,
        coverage: operation.coverage,
      }
    : common;
}

function portableProviderOperation(
  operation: Extract<
    PortableProviderPluginOperationV1,
    { readonly requiredScopeSets: readonly (readonly string[])[] }
  >,
): ProviderApiPluginOperationDefinitionV1 {
  return portableOperation(operation) as ProviderApiPluginOperationDefinitionV1;
}

function portableSessionOperation(
  operation: Exclude<
    PortableProviderPluginOperationV1,
    { readonly requiredScopeSets: readonly (readonly string[])[] }
  >,
): WebSessionPluginOperationDefinitionV1 {
  return portableOperation(operation) as WebSessionPluginOperationDefinitionV1;
}

function freezePortableProjectionValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezePortableProjectionValue(entry);
  }
  return Object.freeze(value);
}

function operationManifest(
  binding: PortableProviderPluginBindingV1,
  operation: PortableProviderPluginOperationV1,
): WrenchManifest["operations"][string] {
  const common = {
    description: operation.implementation,
    risk: operation.risk,
    sideEffect: operation.sideEffect,
    idempotency: operation.idempotency,
    dedupeWindowMs: operation.dedupeWindowMs,
    input: operation.input,
  };
  return binding.transport === "provider-api"
    ? {
        ...common,
        provider: {
          provider: binding.surfaceId,
          action: operation.name,
          contractVersion: operation.contractVersion,
          timeoutMs: operation.timeoutMs,
          maxOutputBytes: operation.maxOutputBytes,
        },
      }
    : {
        ...common,
        webSession: {
          site: binding.surfaceId,
          action: operation.name,
          contractVersion: operation.contractVersion,
          timeoutMs: operation.timeoutMs,
          maxOutputBytes: operation.maxOutputBytes,
        },
      };
}

function virtualManifest(
  packageValue: VerifiedPortableProviderPluginPackage,
  binding: PortableProviderPluginBindingV1,
): WrenchManifest {
  const operations = Object.fromEntries(
    binding.operations.map((operation) => [
      operation.name,
      operationManifest(binding, operation),
    ]),
  );
  return freezePortableProjectionValue({
    schemaVersion: binding.transport === "provider-api" ? 3 : 4,
    id: binding.adapterId,
    version: packageValue.manifest.version,
    displayName: packageValue.manifest.displayName,
    surfaceId: binding.surfaceId,
    origins: Object.freeze([binding.origin]),
    browserDomains: Object.freeze([new URL(binding.origin).hostname]),
    operations,
  });
}

function cookieSelection(auth: WrenchAuth, timeoutMs: number): CookieSelection {
  if (auth.kind === "cookie-source") {
    return {
      cookieSources: [auth.source],
      cookiesFile: undefined,
      cookieProfile: auth.profile,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "cookies-file") {
    return {
      cookieSources: [],
      cookiesFile: auth.path,
      cookieProfile: undefined,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  if (auth.kind === "browser-profile" && auth.cookieSource !== undefined) {
    return {
      cookieSources: [auth.cookieSource],
      cookiesFile: undefined,
      cookieProfile: auth.cookieProfile,
      timeoutMs,
      requireExplicitCookieScope: true,
    };
  }
  throw new Error("portable cookie material requires an explicit cookie source");
}

function bodyBytes(body: PortablePluginHttpBody): ArrayBuffer | undefined {
  if (body.kind === "none") return undefined;
  const source = body.kind === "utf8"
    ? new TextEncoder().encode(body.text)
    : Buffer.from(body.data, "base64");
  const owned = new Uint8Array(source.byteLength);
  owned.set(source);
  return owned.buffer;
}

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
  cleanupBarrier: PortableProviderPluginCleanupBarrier,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<Uint8Array> {
  if (response.body === null) {
    operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pendingRead: ReturnType<typeof reader.read> | null = null;
  let failure: unknown;
  let failed = false;
  try {
    operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
    for (;;) {
      pendingRead = reader.read();
      const next = operationDeadline === undefined
        ? await pendingRead
        : await operationDeadline.run(
            () => pendingRead as ReturnType<typeof reader.read>,
            WEB_SESSION_OPERATION_LABEL,
          );
      pendingRead = null;
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("portable plugin HTTP response returned non-byte data");
      }
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new Error("portable plugin HTTP response exceeded its declared bound");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    failed = true;
    failure = error;
    const cancellation = Promise.resolve().then(() =>
      reader.cancel("portable plugin response processing stopped")
    );
    const quiescence = Promise.allSettled([
      ...(pendingRead === null ? [] : [pendingRead]),
      cancellation,
    ]).then((results) => {
      const cancellationResult = results.at(-1);
      if (cancellationResult?.status === "rejected") {
        throw cancellationResult.reason;
      }
    });
    const settled = await settlesWithin(
      quiescence,
      PORTABLE_CAPABILITY_ABORT_JOIN_MS,
    );
    if (settled === null || settled.status === "rejected") {
      const cleanupError = new Error(
        "portable plugin HTTP response cleanup did not settle after cancellation",
        settled?.status === "rejected"
          ? { cause: settled.reason }
          : undefined,
      );
      cleanupBarrier.unsafe(cleanupError);
      failure = new AggregateError(
        [error, cleanupError],
        "portable plugin HTTP response processing and cleanup failed",
      );
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      const cleanupError = new Error(
        "portable plugin HTTP response reader lock could not be released",
        { cause: error },
      );
      cleanupBarrier.unsafe(cleanupError);
      failure = failed
        ? new AggregateError(
            [failure, cleanupError],
            "portable plugin HTTP response processing and cleanup failed",
          )
        : cleanupError;
      failed = true;
    }
  }
  if (failed) throw failure;
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responseHeaders(response: Response): readonly {
  readonly name: string;
  readonly value: string;
}[] {
  const values: { readonly name: string; readonly value: string }[] = [];
  response.headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (
      values.length < MAX_PORTABLE_RESPONSE_HEADERS
      && RESPONSE_HEADER_ALLOWLIST.has(normalized)
      && !/[\0\r\n]/u.test(value)
      && Buffer.byteLength(value, "utf8") <= 8_192
    ) {
      values.push(Object.freeze({ name: normalized, value }));
    }
  });
  return Object.freeze(values);
}

function responseBody(bytes: Uint8Array): {
  readonly kind: "utf8";
  readonly text: string;
} | {
  readonly kind: "base64";
  readonly data: string;
} {
  try {
    return Object.freeze({
      kind: "utf8" as const,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    });
  } catch {
    return Object.freeze({
      kind: "base64" as const,
      data: Buffer.from(bytes).toString("base64"),
    });
  }
}

function statePath(
  packageValue: VerifiedPortableProviderPluginPackage,
  binding: PortableProviderPluginBindingV1,
  auth: WrenchAuth,
  key: string,
  environment: Environment,
): string {
  return join(
    wrenchStateHome(environment),
    "provider-plugin-state",
    packageValue.manifest.id,
    packageValue.bundleSha256,
    binding.adapterId,
    sha256(canonicalJson(auth)),
    `${sha256(key)}.json`,
  );
}

function parseStoredState(
  content: string,
  key: string,
  includeVersion: boolean,
): PortablePluginCapabilityResult {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new Error("portable plugin namespaced state is malformed");
  }
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) {
    throw new Error("portable plugin namespaced state is malformed");
  }
  const record = value as Record<string, unknown>;
  const legacy = record.schemaVersion === 1
    && Object.keys(record).sort().join(",") === "key,schemaVersion,value";
  const current = record.schemaVersion === 2
    && Object.keys(record).sort().join(",")
      === "key,revision,schemaVersion,value"
    && typeof record.revision === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(record.revision);
  if ((!legacy && !current) || record.key !== key) {
    throw new Error("portable plugin namespaced state identity is malformed");
  }
  const result = {
    kind: "state.read",
    found: true,
    value: normalizePortablePluginJsonValue(
      record.value,
      "portable plugin namespaced state value",
    ),
  } as const;
  if (!includeVersion) return result;
  const versioned: PortablePluginVersionedStateResult = {
    ...result,
    version: sha256(content),
  };
  return versioned;
}

function portableStateRecord(
  key: string,
  value: PortablePluginJsonValue,
): Readonly<{
  readonly schemaVersion: 2;
  readonly key: string;
  readonly revision: string;
  readonly value: PortablePluginJsonValue;
}> {
  return Object.freeze({
    schemaVersion: 2 as const,
    key,
    revision: randomUUID(),
    value: normalizePortablePluginJsonValue(
      value,
      "portable plugin namespaced state value",
    ),
  });
}

function requestHeaders(
  request: Extract<PortablePluginCapabilityRequest, { readonly kind: "http.request" }>,
  materials: ReadonlyMap<string, CapabilityMaterial>,
): Headers {
  const headers = new Headers();
  for (const header of request.headers) {
    const name = header.name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(name)) {
      throw new Error("portable plugin requested a forbidden HTTP header");
    }
    headers.append(name, header.value);
  }
  for (const credential of request.credentials) {
    const material = materials.get(credential.handle);
    if (material === undefined) {
      throw new Error("portable plugin requested an unknown material handle");
    }
    if (
      material.kind === "oauth-access-token"
      && credential.sink.kind === "header"
      && credential.sink.name.toLowerCase() === "authorization"
    ) {
      if (headers.has("authorization")) {
        throw new Error("portable plugin repeated the authorization sink");
      }
      headers.set("authorization", `Bearer ${material.value}`);
      continue;
    }
    if (
      material.kind === "cookie-jar"
      && credential.sink.kind === "cookie-jar"
    ) {
      continue;
    }
    throw new Error("portable plugin requested an incompatible credential sink");
  }
  if (request.body.kind !== "none") {
    if (headers.has("content-type")) {
      throw new Error("portable plugin body media type owns content-type");
    }
    headers.set("content-type", request.body.mediaType);
  }
  return headers;
}

async function injectCookieMaterials(
  request: Extract<PortablePluginCapabilityRequest, { readonly kind: "http.request" }>,
  materials: ReadonlyMap<string, CapabilityMaterial>,
  headers: Headers,
  dependencies: PortableProviderRuntimeDependencies,
  signal: AbortSignal,
  cleanupBarrier: PortableProviderPluginCleanupBarrier,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<void> {
  for (const credential of request.credentials) {
    const material = materials.get(credential.handle);
    if (
      material?.kind !== "cookie-jar"
      || credential.sink.kind !== "cookie-jar"
    ) continue;
    if (headers.has("cookie")) {
      throw new Error("portable plugin repeated the cookie sink");
    }
    operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
    if (signal.aborted) throw new Error("portable plugin invocation was cancelled");
    const target = new URL(request.url);
    const timeoutMs = operationDeadline === undefined
      ? request.timeoutMs
      : Math.min(request.timeoutMs, operationDeadline.remainingTimeMs());
    if (timeoutMs < 1) {
      throw new Error("portable plugin operation deadline was exhausted");
    }
    const acquire = () => dependencies.acquireCookies(
      cookieSelection(material.auth, timeoutMs),
      target,
    );
    const acquisition = acquire();
    let acquired: Awaited<ReturnType<typeof acquire>>;
    try {
      acquired = operationDeadline === undefined
        ? await acquisition
        : await operationDeadline.run(
            () => acquisition,
            WEB_SESSION_OPERATION_LABEL,
          );
    } catch (error) {
      if (operationDeadline?.signal.aborted === true) {
        await settlesWithin(
          acquisition,
          PORTABLE_CAPABILITY_ABORT_JOIN_MS,
        );
        // The pinned sweet-cookie dependency resolves its timeout before its
        // spawned keyring helper emits close. Its Promise therefore cannot
        // prove process quiescence after a deadline wins the race.
        cleanupBarrier.unsafe(new Error(
          "portable plugin cookie acquisition outlived its request deadline",
        ));
      }
      throw error;
    }
    const filtered = filterCookies(acquired.cookies, target);
    if (
      filtered.rejected !== 0
      || filtered.cookies.length !== acquired.cookies.length
    ) {
      throw new Error("portable plugin cookie source escaped its exact request scope");
    }
    headers.set("cookie", renderCookieHeader(filtered.cookies));
  }
}

function capabilityHost(options: {
  readonly package: VerifiedPortableProviderPluginPackage;
  readonly binding: PortableProviderPluginBindingV1;
  readonly auth: WrenchAuth;
  readonly environment: Environment;
  readonly files: ReadonlyMap<string, BoundInvocationFile>;
  readonly beginDispatch: (dispatchId: string) => Promise<DispatchBoundary>;
  readonly dependencies: PortableProviderRuntimeDependencies;
  readonly fetch: PinnedHttpsFetch;
  readonly activity: PortableCapabilityActivity;
  readonly cleanupBarrier: PortableProviderPluginCleanupBarrier;
  readonly operationDeadline?: WebSessionOperationDeadline;
}): PortableProviderPluginCapabilityHost {
  const materials = new Map<string, CapabilityMaterial>();
  const dispatches = new Map<string, DispatchBoundary>();
  return Object.freeze({
    handle: async (
      request,
      context,
    ): Promise<PortablePluginCapabilityResult> => {
      const endActivity = options.activity.begin();
      try {
        options.operationDeadline?.throwIfUnavailable(
          WEB_SESSION_OPERATION_LABEL,
        );
        if (request.kind === "dispatch.begin") {
        const boundary = await options.beginDispatch(request.dispatchId);
        const dispatchHandle = `dispatch-${randomUUID()}`;
        dispatches.set(dispatchHandle, boundary);
        return { kind: "dispatch.begin", dispatchHandle };
      }
      if (request.kind === "dispatch.verify") {
        const boundary = dispatches.get(request.dispatchHandle);
        if (boundary === undefined) {
          throw new Error("portable plugin requested an unknown dispatch boundary");
        }
        await boundary.verify();
        dispatches.delete(request.dispatchHandle);
        return { kind: "dispatch.verify", verified: true };
      }
      if (request.kind === "session.acquire") {
        let material: CapabilityMaterial;
        if (
          request.name === "oauth-access-token"
          && options.binding.transport === "provider-api"
          && options.auth.kind === "oauth-token-file"
        ) {
          const token = options.dependencies.loadToken(
            options.auth,
            new Date(),
            30_000,
          );
          material = { kind: "oauth-access-token", value: token.accessToken };
        } else if (
          request.name === "cookie-jar"
          && options.binding.transport === "web-session-api"
          && (
            options.auth.kind === "cookie-source"
            || options.auth.kind === "cookies-file"
            || options.auth.kind === "browser-profile"
          )
        ) {
          material = { kind: "cookie-jar", auth: options.auth };
        } else {
          throw new Error("portable plugin requested unsupported session material");
        }
        const materialHandle = `material-${randomUUID()}`;
        materials.set(materialHandle, material);
        return { kind: "session.acquire", materialHandle };
      }
      if (request.kind === "http.request") {
        if (new URL(request.url).origin !== options.binding.origin) {
          throw new Error(
            "portable plugin HTTP request escaped its binding's exact origin",
          );
        }
        const headers = requestHeaders(request, materials);
        const timeoutMs = Math.min(
          request.timeoutMs,
          options.operationDeadline?.remainingTimeMs() ?? request.timeoutMs,
        );
        if (timeoutMs < 1) {
          throw new Error("portable plugin operation deadline was exhausted");
        }
        const requestDeadline = new OperationDeadline(timeoutMs, {
          signal: options.operationDeadline?.signal ?? context.signal,
        });
        let response: Response | undefined;
        try {
          await injectCookieMaterials(
            request,
            materials,
            headers,
            options.dependencies,
            requestDeadline.signal,
            options.cleanupBarrier,
            requestDeadline,
          );
          const fetchOperation = Promise.resolve().then(() =>
            options.fetch(
              new URL(request.url),
              {
                method: request.method,
                headers,
                ...(request.body.kind === "none"
                  ? {}
                  : { body: bodyBytes(request.body) }),
                redirect: "error",
                signal: requestDeadline.signal,
              },
              timeoutMs,
            )
          );
          try {
            response = await requestDeadline.run(
              () => fetchOperation,
              WEB_SESSION_OPERATION_LABEL,
            );
          } catch (error) {
            if (requestDeadline.signal.aborted) {
              const quiescence = fetchOperation.then(
                async (lateResponse) => {
                  await lateResponse.body?.cancel(
                    "portable plugin request deadline expired",
                  );
                },
                () => undefined,
              );
              const settled = await settlesWithin(
                quiescence,
                PORTABLE_CAPABILITY_ABORT_JOIN_MS,
              );
              if (settled === null || settled.status === "rejected") {
                options.cleanupBarrier.unsafe(new Error(
                  "portable plugin HTTP request cleanup did not settle after cancellation",
                  settled?.status === "rejected"
                    ? { cause: settled.reason }
                    : undefined,
                ));
              }
            }
            throw error;
          }
          const bytes = await boundedResponseBytes(
            response,
            request.maxOutputBytes,
            options.cleanupBarrier,
            requestDeadline,
          );
          return {
            kind: "http.request",
            status: response.status,
            headers: responseHeaders(response),
            body: responseBody(bytes),
            finalUrl: request.url,
          };
        } finally {
          const requestAborted = requestDeadline.signal.aborted;
          requestDeadline.dispose();
          if (
            requestAborted
            && response?.body !== null
            && response?.body !== undefined
            && !response.bodyUsed
          ) {
            const settled = await settlesWithin(
              response.body.cancel(
                "portable plugin request deadline expired",
              ),
              PORTABLE_CAPABILITY_ABORT_JOIN_MS,
            );
            if (settled === null || settled.status === "rejected") {
              options.cleanupBarrier.unsafe(new Error(
                "portable plugin HTTP response cleanup did not settle after cancellation",
                settled?.status === "rejected"
                  ? { cause: settled.reason }
                  : undefined,
              ));
            }
          }
        }
      }
      if (request.kind === "file.read") {
        const file = options.files.get(request.handle);
        if (file === undefined) {
          throw new Error("portable plugin requested an unknown file handle");
        }
        const buffer = Buffer.alloc(request.length);
        const read = readSync(
          file.descriptor,
          buffer,
          0,
          request.length,
          request.offset,
        );
        return {
          kind: "file.read",
          data: buffer.subarray(0, read).toString("base64"),
          eof: request.offset + read >= file.protocol.bytes,
        };
      }
      if (request.kind === "state.read") {
        const content = readPrivateStateFileIfPresent(
          statePath(
            options.package,
            options.binding,
            options.auth,
            request.key,
            options.environment,
          ),
          MAX_PORTABLE_STATE_BYTES,
          "portable plugin namespaced state",
          options.environment,
        );
        if (content !== null) {
          return parseStoredState(
            content,
            request.key,
            request.includeVersion === true,
          );
        }
        if (request.includeVersion !== true) {
          return { kind: "state.read", found: false };
        }
        const missing: PortablePluginVersionedStateResult = {
          kind: "state.read",
          found: false,
          version: null,
        };
        return missing;
      }
      if (request.kind === "state.write") {
        const path = statePath(
          options.package,
          options.binding,
          options.auth,
          request.key,
          options.environment,
        );
        const state = portableStateRecord(request.key, request.value);
        const serialized = `${canonicalJson(state)}\n`;
        if (
          Buffer.byteLength(serialized, "utf8")
          > MAX_PORTABLE_STATE_BYTES
        ) {
          throw new Error(
            "portable plugin namespaced state exceeds its persisted byte bound",
          );
        }
        let stored: boolean;
        if (request.expectedVersion === undefined) {
          writePrivateJson(path, state, { privateParent: true });
          stored = true;
        } else if (request.expectedVersion === null) {
          stored = createPrivateJsonIfAbsent(path, state, {
            environment: options.environment,
            privateParent: true,
          }).created;
        } else {
          stored = writePrivateJsonIfUnchanged(path, state, {
            expectedCurrentContentSha256: request.expectedVersion,
          });
        }
        if (!stored) {
          throw new Error("portable plugin state version conflict");
        }
        const result = {
          kind: "state.write",
          stored: true,
        } as const;
        if (request.expectedVersion === undefined) return result;
        const versioned: PortablePluginVersionedStateResult = {
          ...result,
          version: sha256(serialized),
        };
        return versioned;
      }
      if (request.kind === "state.delete") {
        const path = statePath(
          options.package,
          options.binding,
          options.auth,
          request.key,
          options.environment,
        );
        if (request.expectedVersion === undefined) {
          return {
            kind: "state.delete",
            removed: removePrivateStateFile(
              path,
              options.environment,
            ),
          };
        }
        return {
          kind: "state.delete",
          removed: removePrivateStateFileIfUnchanged(
            path,
            { expectedCurrentContentSha256: request.expectedVersion },
            options.environment,
          ),
        };
      }
        return { kind: "log.write", accepted: true };
      } finally {
        endActivity();
      }
    },
  });
}

function fileValues(
  input: OperationInput,
): readonly { readonly input: string; readonly value: FileInputValue }[] {
  const isFile = (candidate: unknown): candidate is FileInputValue =>
    typeof candidate === "object"
    && candidate !== null
    && !Array.isArray(candidate)
    && "kind" in candidate
    && candidate.kind === "file"
    && "reference" in candidate
    && typeof candidate.reference === "string";
  return Object.entries(input).flatMap(([name, value]) => {
    const values = Array.isArray(value) ? value : [value];
    return values.flatMap((candidate) =>
      isFile(candidate)
        ? [{ input: name, value: candidate }]
        : []);
  });
}

function bindFile(
  input: string,
  value: FileInputValue,
  path: string,
  cleanupBarrier: PortableProviderPluginCleanupBarrier,
  closeBoundFile: (descriptor: number) => void,
  closeBindingDescriptor: (descriptor: number) => void,
  removeBindingDirectory: (path: string, force: boolean) => void,
): BoundInvocationFile {
  const summary = summarizePlanFile(value);
  let sourceDescriptor: number | null = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let snapshotDirectory: string | null = null;
  let writer: number | null = null;
  let reader: number | null = null;
  const closeForTransfer = (
    descriptor: number,
    resource: string,
  ): void => {
    try {
      closeBindingDescriptor(descriptor);
    } catch (error) {
      throw new UnverifiedPlanFileBindingCleanupError(resource, error);
    }
  };
  const removeForTransfer = (
    directory: string,
    force: boolean,
  ): void => {
    try {
      removeBindingDirectory(directory, force);
    } catch (error) {
      throw new UnverifiedPlanFileBindingCleanupError(
        "snapshot-directory",
        error,
      );
    }
  };
  try {
    snapshotDirectory = mkdtempSync(
      join(tmpdir(), "wrench-portable-plan-file-"),
    );
    chmodSync(snapshotDirectory, 0o700);
    const snapshotPath = join(snapshotDirectory, "verified");
    const before = fstatSync(sourceDescriptor, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(summary.bytes)) {
      throw new Error("portable plugin plan file changed before invocation");
    }
    writer = openSync(
      snapshotPath,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.byteLength,
        total,
      );
      if (count === 0) break;
      total += count;
      if (total > summary.bytes) {
        throw new Error("portable plugin plan file grew before invocation");
      }
      hash.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const countWritten = writeSync(
          writer,
          buffer,
          written,
          count - written,
          total - count + written,
        );
        if (countWritten < 1) {
          throw new Error("portable plugin plan-file snapshot write stalled");
        }
        written += countWritten;
      }
    }
    const after = fstatSync(sourceDescriptor, { bigint: true });
    if (
      total !== summary.bytes
      || hash.digest("hex") !== summary.sha256
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("portable plugin plan file failed its content hash");
    }
    fsyncSync(writer);
    const verifiedWriter = writer;
    writer = null;
    closeForTransfer(verifiedWriter, "snapshot-writer");
    chmodSync(snapshotPath, 0o400);
    reader = openSync(
      snapshotPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const snapshot = fstatSync(reader, { bigint: true });
    if (!snapshot.isFile() || snapshot.size !== BigInt(summary.bytes)) {
      throw new Error("portable plugin plan-file snapshot is invalid");
    }
    // An unlinked, read-only descriptor is an immutable invocation snapshot:
    // later source rewrites and pathname replacement cannot affect reads.
    unlinkSync(snapshotPath);
    const verifiedDirectory = snapshotDirectory;
    snapshotDirectory = null;
    removeForTransfer(verifiedDirectory, false);
    const verifiedSource = sourceDescriptor;
    sourceDescriptor = null;
    closeForTransfer(verifiedSource, "source-descriptor");
    const handle = `file-${randomUUID()}`;
    const descriptor = reader;
    reader = null;
    let disposed = false;
    return {
      descriptor,
      dispose: () => {
        if (disposed) return;
        closeBoundFile(descriptor);
        disposed = true;
      },
      protocol: Object.freeze({
        input,
        handle,
        bytes: summary.bytes,
        mediaType: summary.mediaType,
        sha256: summary.sha256,
      }),
    };
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (error instanceof UnverifiedPlanFileBindingCleanupError) {
      cleanupFailures.push(error);
    }
    const cleanupDescriptor = (
      descriptor: number,
      resource: string,
    ): void => {
      try {
        closeBindingDescriptor(descriptor);
      } catch (cleanupError) {
        cleanupFailures.push(
          new UnverifiedPlanFileBindingCleanupError(
            resource,
            cleanupError,
          ),
        );
      }
    };
    if (writer !== null) {
      const pendingWriter = writer;
      writer = null;
      cleanupDescriptor(pendingWriter, "snapshot-writer");
    }
    if (reader !== null) {
      const pendingReader = reader;
      reader = null;
      cleanupDescriptor(pendingReader, "snapshot-reader");
    }
    if (snapshotDirectory !== null) {
      const pendingDirectory = snapshotDirectory;
      snapshotDirectory = null;
      try {
        removeBindingDirectory(pendingDirectory, true);
      } catch (cleanupError) {
        cleanupFailures.push(
          new UnverifiedPlanFileBindingCleanupError(
            "snapshot-directory",
            cleanupError,
          ),
        );
      }
    }
    if (sourceDescriptor !== null) {
      const pendingSource = sourceDescriptor;
      sourceDescriptor = null;
      cleanupDescriptor(pendingSource, "source-descriptor");
    }
    if (cleanupFailures.length > 0) {
      const cause = new AggregateError(
        [
          error,
          ...cleanupFailures.filter((failure) => failure !== error),
        ],
        "portable plugin plan-file binding cleanup failed",
      );
      cleanupBarrier.unsafe(cause);
      throw new Error(
        "portable provider plugin plan-file cleanup failed",
        { cause },
      );
    }
    throw error;
  }
}

function portableInput(
  input: OperationInput,
  files: readonly BoundInvocationFile[],
): PortablePluginJsonObject {
  const handles = new Map<string, string[]>();
  for (const file of files) {
    const values = handles.get(file.protocol.input) ?? [];
    values.push(file.protocol.handle);
    handles.set(file.protocol.input, values);
  }
  const output: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    const fileHandles = handles.get(name);
    if (fileHandles === undefined) {
      output[name] = value;
      continue;
    }
    output[name] = Array.isArray(value) ? fileHandles : fileHandles[0];
  }
  return normalizePortablePluginJsonObject(output, "portable plugin input");
}

async function resolveWebFiles(
  input: OperationInput,
  resolver: BrowserFileResolver | undefined,
  cleanupBarrier: PortableProviderPluginCleanupBarrier,
  closeBoundFile: (descriptor: number) => void,
  closeBindingDescriptor: (descriptor: number) => void,
  removeBindingDirectory: (path: string, force: boolean) => void,
  operationDeadline?: WebSessionOperationDeadline,
): Promise<readonly BoundInvocationFile[]> {
  const values = fileValues(input);
  if (values.length === 0) return Object.freeze([]);
  if (resolver === undefined) {
    throw new Error("portable plugin plan-file resolver is unavailable");
  }
  const paths = await resolver(values.map((entry) => entry.value));
  operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
  if (paths.length !== values.length) {
    throw new Error("portable plugin plan-file resolver returned the wrong count");
  }
  const files: BoundInvocationFile[] = [];
  try {
    for (const [index, entry] of values.entries()) {
      operationDeadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
      const path = paths[index];
      if (path === undefined) {
        throw new Error("portable plugin plan-file resolver omitted a path");
      }
      files.push(bindFile(
        entry.input,
        entry.value,
        path,
        cleanupBarrier,
        closeBoundFile,
        closeBindingDescriptor,
        removeBindingDirectory,
      ));
    }
    return Object.freeze(files);
  } catch (error) {
    disposePortableRuntimeResources(cleanupBarrier, undefined, files);
    throw error;
  }
}

async function runWebPortableHost(options: {
  readonly package: VerifiedPortableProviderPluginPackage;
  readonly binding: PortableProviderPluginBindingV1;
  readonly operation: PortableProviderPluginOperationV1;
  readonly input: OperationInput;
  readonly auth: WrenchAuth;
  readonly environment: Environment;
  readonly fileResolver?: BrowserFileResolver;
  readonly signal?: AbortSignal;
  readonly operationDeadline?: WebSessionOperationDeadline;
  readonly beforeDispatch?: (event: WebSessionDispatchEvent) => Promise<void>;
  readonly afterDispatchVerified?: (event: WebSessionDispatchEvent) => Promise<void>;
  readonly dependencies: PortableProviderRuntimeDependencies;
}): Promise<PortableProviderPluginHostResult> {
  const cleanupBarrier = registerPortableProviderPluginCleanupBarrier();
  const deadline = options.operationDeadline;
  const plannedIds = options.operation.dispatch === "single"
    ? [options.operation.name]
    : [];
  let started = 0;
  let verified = 0;
  let files: readonly BoundInvocationFile[] = Object.freeze([]);
  let fetchScope: PinnedHttpsFetchScope | undefined;
  let hostCompletion: Promise<void> | undefined;
  const capabilityActivity = createPortableCapabilityActivity();
  try {
    const resolveFiles = () =>
      resolveWebFiles(
        options.input,
        options.fileResolver,
        cleanupBarrier,
        options.dependencies.closeBoundFile,
        options.dependencies.closePlanFileBindingDescriptor,
        options.dependencies.removePlanFileBindingDirectory,
        options.operationDeadline,
      );
    deadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
    const fileResolution = resolveFiles();
    if (deadline === undefined) {
      files = await fileResolution;
    } else {
      try {
        files = await deadline.run(
          () => fileResolution,
          WEB_SESSION_OPERATION_LABEL,
        );
      } catch (error) {
        if (deadline.signal.aborted) {
          const settled = await settlesWithin(
            fileResolution,
            PORTABLE_CAPABILITY_ABORT_JOIN_MS,
          );
          if (settled?.status === "fulfilled") {
            // OperationDeadline performs a post-work check. Retain ownership
            // when binding completed just after the deadline, so the outer
            // resource boundary still closes every descriptor.
            files = settled.value;
          } else if (settled === null) {
            cleanupBarrier.unsafe(new Error(
              "portable plugin plan-file resolution outlived its operation deadline",
            ));
            // The unsafe durable lease remains the fail-closed proof, but keep
            // a handler attached so a very late successful bind is still
            // disposed rather than orphaned in this process.
            void fileResolution.then(
              (lateFiles) => {
                try {
                  disposePortableRuntimeResources(
                    cleanupBarrier,
                    undefined,
                    lateFiles,
                  );
                } catch {
                  // The already-unsafe barrier and retained lease own recovery.
                }
              },
              () => undefined,
            );
          }
        }
        throw error;
      }
    }
    deadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
    const byHandle = new Map(files.map((file) => [
      file.protocol.handle,
      file,
    ]));
    const scope = options.dependencies.createFetchScope(
      options.binding.origin,
    );
    fetchScope = scope;
    const timeoutMs = Math.min(
      options.operation.timeoutMs,
      deadline?.remainingTimeMs() ?? options.operation.timeoutMs,
    );
    if (timeoutMs < 100) {
      throw new Error("portable plugin operation deadline was exhausted");
    }
    const invokeHost = () => {
      const host = trackPortableProviderPluginHostCompletion(
        options.dependencies.runHost({
        package: options.package,
        route: {
          transport: options.binding.transport,
          surfaceId: options.binding.surfaceId,
          operation: options.operation.name,
          contractVersion: options.operation.contractVersion,
        },
        input: portableInput(options.input, files),
        auth: {
          kind: options.auth.kind,
          handle: `auth-${randomUUID()}`,
          ...(options.auth.subject === undefined
            ? {}
            : { subject: options.auth.subject }),
        },
        files: files.map((file) => file.protocol),
        timeoutMs,
        hostVersion: PORTABLE_HOST_VERSION,
        plannedDispatchIds: plannedIds,
        capabilityHost: capabilityHost({
          package: options.package,
          binding: options.binding,
          auth: options.auth,
          environment: options.environment,
          files: byHandle,
          dependencies: options.dependencies,
          fetch: scope.fetch,
          activity: capabilityActivity,
          cleanupBarrier,
          ...(deadline === undefined
            ? {}
            : { operationDeadline: deadline }),
          beginDispatch: async (dispatchId) => {
            deadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
            const expected = plannedIds[started];
            if (expected !== dispatchId) {
              throw new Error("portable plugin changed its confirmed dispatch");
            }
            const index = started + 1;
            await options.beforeDispatch?.({
              id: dispatchId,
              index,
              progress: {
                planned: plannedIds.length,
                started,
                verified,
              },
            });
            started += 1;
            deadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
            let completed = false;
            return Object.freeze({
              verify: async () => {
                deadline?.throwIfUnavailable(WEB_SESSION_OPERATION_LABEL);
                if (completed || verified + 1 !== index) {
                  throw new Error("portable plugin verified dispatch out of order");
                }
                await options.afterDispatchVerified?.({
                  id: dispatchId,
                  index,
                  progress: {
                    planned: plannedIds.length,
                    started,
                    verified: verified + 1,
                  },
                });
                verified += 1;
                completed = true;
              },
            });
          },
        }),
        ...(deadline === undefined
          ? (options.signal === undefined ? {} : { signal: options.signal })
          : { signal: deadline.signal }),
        }),
      );
      hostCompletion = host.then(
        () => undefined,
        () => undefined,
      );
      return host;
    };
    return deadline === undefined
      ? await invokeHost()
      : await deadline.run(invokeHost, WEB_SESSION_OPERATION_LABEL);
  } finally {
    // An operation deadline may win its race while the host is still using
    // file descriptors or the pinned fetch scope. Keep those resources alive
    // until the actual host boundary settles, then prove their disposal to the
    // lease scope.
    await hostCompletion;
    await capabilityActivity.whenIdle();
    disposePortableRuntimeResources(cleanupBarrier, fetchScope, files);
  }
}

function webExecutor(
  packageValue: VerifiedPortableProviderPluginPackage,
  binding: PortableProviderPluginBindingV1,
  operations: ReadonlyMap<string, PortableProviderPluginOperationV1>,
  environment: Environment,
  dependencies: PortableProviderRuntimeDependencies,
): WebSessionOperationExecutor {
  return async (_manifest, recipe, input, auth, options): Promise<WebSessionExecution> => {
    const operation = operations.get(
      `${recipe.action}@${recipe.contractVersion}`,
    );
    if (operation === undefined) {
      throw new Error("portable plugin operation disappeared");
    }
    try {
      const result = await runWebPortableHost({
        package: packageValue,
        binding,
        operation,
        input,
        auth,
        environment: options.environment ?? environment,
        ...(options.fileResolver === undefined
          ? {}
          : { fileResolver: options.fileResolver }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.operationDeadline === undefined
          ? {}
          : { operationDeadline: options.operationDeadline }),
        ...(options.beforeDispatch === undefined
          ? {}
          : { beforeDispatch: options.beforeDispatch }),
        ...(options.afterDispatchVerified === undefined
          ? {}
          : { afterDispatchVerified: options.afterDispatchVerified }),
        dependencies,
      });
      return {
        status: "succeeded",
        output: result.output,
        finalUrl: result.finalUrl,
        dispatchStarted: result.dispatch.started > 0,
        dispatch: result.dispatch,
      };
    } catch (error) {
      const dispatch = typeof error === "object"
        && error !== null
        && "dispatch" in error
        ? (error as { readonly dispatch: WebSessionExecution["dispatch"] }).dispatch
        : {
            planned: operation.dispatch === "single" ? 1 : 0,
            started: 0,
            verified: 0,
          };
      return {
        status: dispatch.started > dispatch.verified
          ? "indeterminate"
          : dispatch.verified > 0
            ? "partial"
            : "failed",
        output: null,
        finalUrl: null,
        dispatchStarted: dispatch.started > 0,
        dispatch,
        error: "portable provider plugin execution failed",
      };
    }
  };
}

async function runProviderPortableHost(
  packageValue: VerifiedPortableProviderPluginPackage,
  binding: PortableProviderPluginBindingV1,
  operation: PortableProviderPluginOperationV1,
  context: ProviderActionContext,
  dependencies: PortableProviderRuntimeDependencies,
): Promise<void> {
  const cleanupBarrier = registerPortableProviderPluginCleanupBarrier();
  const values = fileValues(context.input);
  const files: BoundInvocationFile[] = [];
  try {
    for (const inputName of new Set(values.map((entry) => entry.input))) {
      const matching = values.filter((entry) => entry.input === inputName);
      const resolved = await context.resolveFiles(inputName);
      if (context.signal.aborted) {
        throw new Error("portable provider invocation was cancelled");
      }
      if (resolved.length !== matching.length) {
        throw new Error("portable provider file resolver returned the wrong count");
      }
      for (const [index, entry] of matching.entries()) {
        if (context.signal.aborted) {
          throw new Error("portable provider invocation was cancelled");
        }
        const file = resolved[index];
        if (file === undefined) {
          throw new Error("portable provider file resolver omitted a file");
        }
        files.push(bindFile(
          inputName,
          entry.value,
          file.path,
          cleanupBarrier,
          dependencies.closeBoundFile,
          dependencies.closePlanFileBindingDescriptor,
          dependencies.removePlanFileBindingDirectory,
        ));
      }
    }
  } catch (error) {
    disposePortableRuntimeResources(cleanupBarrier, undefined, files);
    throw error;
  }
  const byHandle = new Map(files.map((file) => [
    file.protocol.handle,
    file,
  ]));
  const plannedIds = operation.dispatch === "single" ? [operation.name] : [];
  let fetchScope: PinnedHttpsFetchScope | undefined;
  const capabilityActivity = createPortableCapabilityActivity();
  try {
    fetchScope = dependencies.createFetchScope(binding.origin);
    const timeoutMs = Math.min(
      operation.timeoutMs,
      context.remainingTimeMs(),
    );
    if (timeoutMs < 100) {
      throw new Error("portable provider operation deadline was exhausted");
    }
    const result = await trackPortableProviderPluginHostCompletion(
      dependencies.runHost({
        package: packageValue,
        route: {
          transport: binding.transport,
          surfaceId: binding.surfaceId,
          operation: operation.name,
          contractVersion: operation.contractVersion,
        },
        input: portableInput(context.input, files),
        auth: {
          kind: context.auth.kind,
          handle: `auth-${randomUUID()}`,
          ...(context.auth.subject === undefined
            ? {}
            : { subject: context.auth.subject }),
        },
        files: files.map((file) => file.protocol),
        timeoutMs,
        hostVersion: PORTABLE_HOST_VERSION,
        plannedDispatchIds: plannedIds,
        capabilityHost: capabilityHost({
          package: packageValue,
          binding,
          auth: context.auth,
          environment: context.environment,
          files: byHandle,
          dependencies,
          fetch: fetchScope.fetch,
          activity: capabilityActivity,
          cleanupBarrier,
          beginDispatch: async (dispatchId) => {
            if (dispatchId !== operation.name) {
              throw new Error("portable plugin changed its confirmed dispatch");
            }
            return context.beginDispatch();
          },
        }),
        signal: context.signal,
      }),
    );
    context.setOutput(result.output);
    if (result.finalUrl !== null) context.setFinalUrl(result.finalUrl);
  } finally {
    await capabilityActivity.whenIdle();
    disposePortableRuntimeResources(cleanupBarrier, fetchScope, files);
  }
}

/**
 * Construct the only in-process hooks portable packages may receive. The
 * caller still cannot admit these raw values into a registry: the authority
 * module brands only the exact frozen objects returned here.
 */
export function createKernelPortableProviderPluginBindingProjections(
  packageValue: VerifiedPortableProviderPluginPackage,
  environment: Environment,
  dependencies: PortableProviderRuntimeDependencies,
): readonly KernelPortableProviderPluginBindingProjection[] {
  if (!isResolvedPortableProviderRuntimeDependencies(dependencies)) {
    throw new Error(
      "portable provider plugin wrappers require resolved kernel runtime dependencies",
    );
  }
  const bindings = packageValue.manifest.bindings.map((binding) => {
    if (
      binding.transport === "linked-device"
      && binding.operations.some((operation) => operation.state === "observed")
    ) {
      throw new Error(
        `portable plugin ${packageValue.manifest.id} linked-device execution requires a future lifecycle protocol`,
      );
    }
    const operationByKey = new Map(binding.operations.map((operation) => [
      `${operation.name}@${operation.contractVersion}`,
      operation,
    ]));
    const subject = portableSubject(binding.subject);
    const manifest = virtualManifest(packageValue, binding);
    let projectedBinding: ProviderPluginBindingDefinitionV1;
    if (binding.transport === "provider-api") {
      const definitions = Object.freeze(
        binding.operations.map((operation) =>
          Object.freeze(portableProviderOperation(operation))),
      );
      projectedBinding = Object.freeze({
        transport: binding.transport,
        surfaceId: binding.surfaceId,
        origin: binding.origin,
        authKinds: binding.authKinds,
        subject,
        operations: definitions,
        runtime: Object.freeze({
          loadRuntime: () => Promise.resolve(Object.freeze({
            execute: async (context: ProviderActionContext) => {
              const operation = operationByKey.get(
                `${context.recipe.action}@${context.recipe.contractVersion}`,
              );
              if (operation === undefined) {
                throw new Error("portable provider operation disappeared");
              }
              await runProviderPortableHost(
                packageValue,
                binding,
                operation,
                context,
                dependencies,
              );
            },
          })),
        }),
      });
    } else {
      const definitions = Object.freeze(
        binding.operations.map((operation) =>
          Object.freeze(portableSessionOperation(operation))),
      );
      const execute = webExecutor(
        packageValue,
        binding,
        operationByKey,
        environment,
        dependencies,
      );
      projectedBinding = Object.freeze({
        transport: binding.transport,
        surfaceId: binding.surfaceId,
        origin: binding.origin,
        authKinds: binding.authKinds,
        subject,
        operations: definitions,
        runtime: Object.freeze({
          loadRuntime: () => Promise.resolve(Object.freeze({
            probe: async (
              auth: WrenchAuth,
              options?: ProviderPluginSubjectProbeOptionsV1,
            ) => {
              const probe = binding.subject.probe;
              if (probe === null) {
                throw new Error("portable plugin has no current-account probe");
              }
              const operation = operationByKey.get(
                `${probe.operation}@${probe.contractVersion}`,
              );
              if (operation === undefined) {
                throw new Error("portable plugin subject probe disappeared");
              }
              const identity = createPortableOperationIdentityV1({
                package: {
                  id: packageValue.manifest.id,
                  version: packageValue.manifest.version,
                  hostApiVersion: packageValue.manifest.hostApiVersion,
                  bundleSha256: packageValue.bundleSha256,
                  manifestSha256: packageValue.manifestSha256,
                  capabilities: packageValue.manifest.capabilities,
                },
                binding,
                operation,
              });
              const lease = acquirePortableProviderPluginInvocationLease(
                identity,
                randomUUID(),
                environment,
              );
              const containment =
                createPortableProviderPluginInvocationLeaseContainmentController(
                  lease,
                  environment,
                );
              const outcome = await settlePortableProviderPluginCleanup(
                async () => {
                  const result = await runWebPortableHost({
                    package: packageValue,
                    binding,
                    operation,
                    input: {},
                    auth,
                    environment,
                    dependencies,
                    ...(options?.signal === undefined
                      ? {}
                      : { signal: options.signal }),
                  });
                  if (
                    typeof result.output !== "string"
                    || !subject.matches(result.output)
                  ) {
                    throw new Error(
                      "portable plugin returned an invalid account subject",
                    );
                  }
                  return result.output;
                },
                {
                  containment,
                  cleanupComplete: containment.cleanupComplete,
                },
              );
              releasePortableProviderPluginInvocationLease(
                containment.current,
                environment,
              );
              if (outcome.status === "rejected") {
                throw outcome.reason;
              }
              return outcome.value;
            },
            execute,
          })),
        }),
      });
    }
    return Object.freeze({
      adapterId: binding.adapterId,
      manifest,
      portableBinding: binding,
      binding: projectedBinding,
    });
  });
  return Object.freeze(bindings);
}
