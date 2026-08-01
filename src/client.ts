import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";

import { canonicalJson } from "./canonical-json";
import type {
  CapabilityReadRequest,
  ReadCapabilityOptions,
  ReadProjectionCacheResult,
  ReadProjectionCacheOutcome,
  ReadProjectionPublication,
  RevalidateCapabilityOptions,
  RevalidatedCapability,
  RevalidatedCapabilityCurrent,
  WrenchClientInvocationResult,
  WrenchClientPortableOperationIdentity,
  WrenchClientRunReceipt,
} from "./client-types";

type JsonRecord = Record<string, unknown>;
type ReadProjectionCacheHit = Extract<
  ReadProjectionCacheResult,
  { readonly status: "hit" }
>;

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_RUN_RECEIPT_ERROR_BYTES = 12 * 1024;
const MAX_FRESH_FOR_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_NODES = 100_000;
const abortSignalAbortedGetter = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted",
  );
  const getter = descriptor === undefined
    ? undefined
    : Reflect.get(descriptor, "get") as unknown;
  return typeof getter !== "function"
    ? undefined
    : (value: unknown): unknown => Reflect.apply(getter, value, []);
})();

type JsonSnapshot =
  | null
  | boolean
  | number
  | string
  | readonly JsonSnapshot[]
  | { readonly [key: string]: JsonSnapshot };

type PreparedRequest = {
  readonly adapterId: string;
  readonly operationId: string;
  readonly authId: string;
  readonly input: string;
};

type PreparedCommand = {
  readonly arguments: readonly string[];
  readonly input: string;
};

type PreparedChildEnvironment = Readonly<Record<string, string>>;

type PreparedClientOptions = {
  readonly cwd: string;
  readonly environment: PreparedChildEnvironment;
  readonly freshForMs?: number;
  readonly now?: Date;
  readonly headed?: boolean;
  readonly signal?: AbortSignal;
};

type ProjectionIdentity =
  | {
      readonly status: "ready";
      readonly key: string;
      readonly authIdentity: string;
      readonly authHash: string;
      readonly inputHash: string;
    }
  | {
      readonly status: "unbound";
      readonly authIdentity: string;
      readonly authHash: string;
      readonly inputHash: string;
    };

type ExecutionIdentity = {
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly operation: string;
} & (
  | {
      readonly schemaVersion: 2;
      readonly transport: "browser";
    }
  | {
      readonly schemaVersion: 3;
      readonly transport: "provider-api";
      readonly providerContractHash: string;
    }
  | {
      readonly schemaVersion: 4;
      readonly transport: "web-session-api";
      readonly webSessionContractHash: string;
    }
  | {
      readonly schemaVersion: 5;
      readonly transport: "reviewed-template-api";
      readonly reviewedTemplateContractHash: string;
    }
  | {
      readonly schemaVersion: 6;
      readonly transport: "portable-provider-plugin";
      readonly portablePluginContract: WrenchClientPortableOperationIdentity;
    }
);

type PreviewExecutionIdentity = {
  readonly adapter: ExecutionIdentity["adapter"];
  readonly operation: string;
} & (
  | { readonly transport: "browser" }
  | { readonly transport: "provider-api" }
  | { readonly transport: "web-session-api" }
  | { readonly transport: "reviewed-template-api" }
  | {
      readonly transport: "portable-provider-plugin";
      readonly portablePluginContract: WrenchClientPortableOperationIdentity;
    }
);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !allowed.has(key))
  ) throw new Error(`${label} is malformed`);
}

/**
 * Clone caller-owned input from property descriptors. Accessors are rejected
 * without being invoked, and a shared object is inspected at most once.
 */
function snapshotJson(value: unknown, label: string): JsonSnapshot {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const completed = new WeakMap<object, JsonSnapshot>();
  const visit = (candidate: unknown, depth: number): JsonSnapshot => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) {
      throw new Error(`${label} exceeds its structural bound`);
    }
    if (
      candidate === null
      || typeof candidate === "boolean"
      || typeof candidate === "string"
    ) return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error(`${label} must contain only JSON data`);
      }
      return candidate;
    }
    if (typeof candidate !== "object") {
      throw new Error(`${label} must contain only JSON data`);
    }
    if (nodeTypes.isProxy(candidate)) {
      throw new Error(`${label} must not contain proxies`);
    }
    const prior = completed.get(candidate);
    if (prior !== undefined) return prior;
    if (ancestors.has(candidate)) throw new Error(`${label} must not be circular`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new Error(`${label} arrays must use the standard prototype`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(candidate) as unknown as
          Readonly<Record<string, PropertyDescriptor>>;
        const descriptorKeys = Reflect.ownKeys(descriptors);
        if (descriptorKeys.some((key) => typeof key !== "string")) {
          throw new Error(`${label} arrays have unsupported symbol fields`);
        }
        const lengthDescriptor = descriptors.length;
        if (
          lengthDescriptor === undefined
          || !("value" in lengthDescriptor)
          || typeof lengthDescriptor.value !== "number"
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
        ) throw new Error(`${label} arrays are malformed`);
        const length = lengthDescriptor.value;
        const keys = descriptorKeys.filter(
          (key): key is string => typeof key === "string" && key !== "length",
        );
        if (
          keys.length !== length
          || keys.some((key, index) => key !== String(index))
        ) throw new Error(`${label} arrays must be dense data arrays`);
        const cloned: JsonSnapshot[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined
            || !descriptor.enumerable
            || !("value" in descriptor)
          ) throw new Error(`${label} arrays must contain only data elements`);
          cloned.push(visit(descriptor.value, depth + 1));
        }
        const snapshot = Object.freeze(cloned);
        completed.set(candidate, snapshot);
        return snapshot;
      }
      const prototype = Object.getPrototypeOf(candidate) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} objects must use a plain prototype`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const descriptorKeys = Reflect.ownKeys(descriptors);
      if (descriptorKeys.some((key) => typeof key !== "string")) {
        throw new Error(`${label} objects have unsupported symbol fields`);
      }
      const cloned: JsonRecord = {};
      for (const key of (descriptorKeys as string[]).sort((left, right) =>
        left.localeCompare(right))) {
        const descriptor = descriptors[key];
        if (
          descriptor === undefined
          || !descriptor.enumerable
          || !("value" in descriptor)
        ) throw new Error(`${label} objects must contain only data properties`);
        Object.defineProperty(cloned, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      const snapshot = Object.freeze(cloned) as JsonSnapshot;
      completed.set(candidate, snapshot);
      return snapshot;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value, 0);
}

function safeString(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || [...value].some((character) => {
      const code = character.codePointAt(0) ?? -1;
      return code <= 0x1f || code === 0x7f;
    })
  ) throw new Error(`${label} is malformed`);
  return value;
}

function boundedUtf8String(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > maximumBytes
  ) throw new Error(`${label} is malformed`);
  return value;
}

function digest(value: unknown, label: string): string {
  const text = safeString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new Error(`${label} is malformed`);
  return text;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = safeString(value, label, 64);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${label} is malformed`);
  }
  return text;
}

function boundedMessage(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_ERROR_BYTES) return value.trim();
  return `${bytes.subarray(0, MAX_ERROR_BYTES).toString("utf8").trim()}…`;
}

function cliSourcePath(): string {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource)) return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource)) return packagedSource;
  throw new Error("the installed Wrench CLI source is unavailable");
}

function requireBunRuntime(): void {
  if (typeof process.versions.bun !== "string") {
    throw new Error("@hraness/wrench/client requires Bun to run the installed Wrench CLI");
  }
}

function environmentName(value: string): string {
  if (value.length < 1 || value.includes("=") || value.includes("\0")) {
    throw new Error("Wrench client environment name is malformed");
  }
  return value;
}

function defineEnvironmentValue(
  environment: Record<string, string>,
  key: string,
  value: string,
): void {
  Object.defineProperty(environment, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function snapshotChildEnvironment(
  overrides: unknown,
): PreparedChildEnvironment {
  const environment = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") defineEnvironmentValue(environment, key, value);
  }
  if (overrides === undefined) return Object.freeze(environment);
  if (
    !isRecord(overrides)
    || nodeTypes.isProxy(overrides)
    || (
      Object.getPrototypeOf(overrides) !== Object.prototype
      && Object.getPrototypeOf(overrides) !== null
    )
  ) {
    throw new Error(
      "Wrench client environment must use a plain, non-proxy object",
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error("Wrench client environment has unsupported symbol fields");
  }
  for (const key of (keys as string[]).sort((left, right) =>
    left.localeCompare(right))) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(
        "Wrench client environment must contain only data properties",
      );
    }
    if (!descriptor.enumerable) {
      throw new Error(
        "Wrench client environment properties must be enumerable",
      );
    }
    const name = environmentName(key);
    if (descriptor.value === undefined) {
      delete environment[name];
    } else if (
      typeof descriptor.value !== "string"
      || descriptor.value.includes("\0")
    ) {
      throw new Error("Wrench client environment value is malformed");
    } else {
      defineEnvironmentValue(environment, name, descriptor.value);
    }
  }
  return Object.freeze(environment);
}

function isBrandedAbortSignal(value: unknown): value is AbortSignal {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || abortSignalAbortedGetter === undefined
  ) return false;
  if (Object.getPrototypeOf(value) !== AbortSignal.prototype) return false;
  try {
    return typeof abortSignalAbortedGetter(value) === "boolean";
  } catch {
    return false;
  }
}

function snapshotClientOptions(
  optionsValue: ReadCapabilityOptions,
  revalidation: boolean,
): PreparedClientOptions {
  if (
    !isRecord(optionsValue)
    || nodeTypes.isProxy(optionsValue)
    || (
      Object.getPrototypeOf(optionsValue) !== Object.prototype
      && Object.getPrototypeOf(optionsValue) !== null
    )
  ) throw new Error("Wrench client options must use a plain, non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(optionsValue);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error("Wrench client options have unsupported symbol fields");
  }
  const allowed = new Set([
    "environment",
    "freshForMs",
    "now",
    ...(revalidation ? ["headed", "signal"] : []),
  ]);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !allowed.has(key)) {
      throw new Error("Wrench client options contain an unsupported field");
    }
    if (!("value" in descriptor)) {
      throw new Error("Wrench client options must contain only data properties");
    }
  }
  const option = (key: string): unknown => descriptors[key]?.value;
  const freshForMsValue = option("freshForMs");
  const nowValue = option("now");
  const headedValue = option("headed");
  const signalValue = option("signal");
  const freshForMs = freshForMsValue === undefined
    ? undefined
    : safeInteger(
        freshForMsValue,
        "Wrench client freshness window",
        0,
        MAX_FRESH_FOR_MS,
      );
  let now: Date | undefined;
  if (nowValue !== undefined) {
    if (
      nodeTypes.isProxy(nowValue)
      || !(nowValue instanceof Date)
      || Object.getPrototypeOf(nowValue) !== Date.prototype
    ) throw new Error("Wrench client observation time is invalid");
    let time: number;
    try {
      time = Date.prototype.getTime.call(nowValue);
    } catch {
      throw new Error("Wrench client observation time is invalid");
    }
    if (!Number.isFinite(time)) {
      throw new Error("Wrench client observation time is invalid");
    }
    now = new Date(time);
  }
  if (headedValue !== undefined && typeof headedValue !== "boolean") {
    throw new Error("Wrench client headed option is malformed");
  }
  if (
    signalValue !== undefined
    && !isBrandedAbortSignal(signalValue)
  ) throw new Error("Wrench client abort signal is malformed");
  return Object.freeze({
    cwd: process.cwd(),
    environment: snapshotChildEnvironment(option("environment")),
    ...(freshForMs === undefined ? {} : { freshForMs }),
    ...(now === undefined ? {} : { now }),
    ...(headedValue === undefined ? {} : { headed: headedValue }),
    ...(signalValue === undefined ? {} : { signal: signalValue }),
  });
}

function prepareRequest(requestValue: CapabilityReadRequest): PreparedRequest {
  const snapshot = snapshotJson(
    requestValue,
    "Wrench client request",
  );
  const request = record(snapshot, "Wrench client request");
  assertExactKeys(
    request,
    ["adapterId", "operationId"],
    ["authId", "input"],
    "Wrench client request",
  );
  const adapterId = safeString(
    request.adapterId,
    "Wrench client adapter ID",
    64,
  );
  const operationId = safeString(
    request.operationId,
    "Wrench client operation ID",
    128,
  );
  const authId = Object.hasOwn(request, "authId")
    ? safeString(request.authId, "Wrench client auth ID", 64)
    : adapterId;
  const rawInput = Object.hasOwn(request, "input") ? request.input : {};
  if (!isRecord(rawInput)) throw new Error("input must be a JSON object");
  const input = canonicalJson(rawInput);
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Wrench client input exceeds its byte bound");
  }
  return Object.freeze({
    adapterId,
    operationId,
    authId,
    input,
  });
}

function preparedCommand(
  request: PreparedRequest,
  options: {
    readonly cacheOnly: boolean;
    readonly projectionIdentityOnly: boolean;
    readonly preview?: boolean;
    readonly headed: boolean;
  },
): PreparedCommand {
  return Object.freeze({
    arguments: Object.freeze([
      cliSourcePath(),
      "invoke",
      request.adapterId,
      request.operationId,
      "--input",
      "-",
      "--auth",
      request.authId,
      ...(options.cacheOnly ? ["--cache-only"] : []),
      ...(options.projectionIdentityOnly
        ? ["--projection-identity-only"]
        : []),
      ...(options.preview === true ? ["--preview"] : []),
      ...(options.headed ? ["--headed"] : []),
      "--json",
    ]),
    input: request.input,
  });
}

function preparedCapabilitiesCommand(request: PreparedRequest): PreparedCommand {
  return Object.freeze({
    arguments: Object.freeze([
      cliSourcePath(),
      "capabilities",
      request.adapterId,
      "--json",
    ]),
    input: "",
  });
}

function parseOutput(text: string, label: string): JsonRecord {
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  try {
    return record(JSON.parse(text) as unknown, label);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be an object`) throw error;
    throw new Error(`${label} is malformed`);
  }
}

function runCacheCommand(
  command: PreparedCommand,
  options: PreparedClientOptions,
): { readonly code: number; readonly output: JsonRecord } {
  requireBunRuntime();
  const result = spawnSync(process.execPath, command.arguments, {
    cwd: options.cwd,
    env: options.environment,
    input: command.input,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error !== undefined) throw result.error;
  const code = result.status ?? 3;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (stdout.trim().length === 0) {
    throw new Error(
      boundedMessage(stderr) || `Wrench cache lookup exited ${code}`,
    );
  }
  if (code !== 0 && code !== 3) {
    throw new Error(
      boundedMessage(stderr) || `Wrench cache lookup exited ${code}`,
    );
  }
  return Object.freeze({
    code,
    output: parseOutput(stdout, "Wrench cache response"),
  });
}

function runIdentityCommand(
  command: PreparedCommand,
  options: PreparedClientOptions,
  label: string,
  responseLabel = `${label} response`,
): JsonRecord {
  requireBunRuntime();
  const result = spawnSync(process.execPath, command.arguments, {
    cwd: options.cwd,
    env: options.environment,
    input: command.input,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error !== undefined) throw result.error;
  const code = result.status ?? 3;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (stdout.trim().length === 0 || code !== 0) {
    throw new Error(
      boundedMessage(stderr)
        || `${label} exited ${code}`,
    );
  }
  return parseOutput(stdout, responseLabel);
}

function runProjectionIdentityCommand(
  command: PreparedCommand,
  options: PreparedClientOptions,
): JsonRecord {
  return runIdentityCommand(
    command,
    options,
    "Wrench projection identity preflight",
    "Wrench projection identity response",
  );
}

function observeProjectionIdentity(
  request: PreparedRequest,
  options: PreparedClientOptions,
): ProjectionIdentity {
  const value = runProjectionIdentityCommand(
    preparedCommand(request, {
      cacheOnly: false,
      projectionIdentityOnly: true,
      headed: false,
    }),
    options,
  );
  if (
    value.ok !== true
    || value.source !== "projection-identity"
  ) throw new Error("Wrench projection identity response is malformed");
  if (value.status === "ready") {
    assertExactKeys(
      value,
      [
        "ok",
        "source",
        "status",
        "authIdentity",
        "authHash",
        "inputHash",
        "projection",
      ],
      [],
      "Wrench projection identity response",
    );
    const projection = record(
      value.projection,
      "Wrench projection identity",
    );
    assertExactKeys(
      projection,
      ["key"],
      [],
      "Wrench projection identity",
    );
    return Object.freeze({
      status: "ready",
      key: digest(projection.key, "Wrench projection identity key"),
      authIdentity: digest(
        value.authIdentity,
        "Wrench projection auth identity",
      ),
      authHash: digest(value.authHash, "Wrench projection auth hash"),
      inputHash: digest(
        value.inputHash,
        "Wrench projection validated input hash",
      ),
    });
  }
  if (value.status === "unbound") {
    assertExactKeys(
      value,
      [
        "ok",
        "source",
        "status",
        "authIdentity",
        "authHash",
        "inputHash",
      ],
      [],
      "Wrench projection identity response",
    );
    return Object.freeze({
      status: "unbound",
      authIdentity: digest(
        value.authIdentity,
        "Wrench projection auth identity",
      ),
      authHash: digest(value.authHash, "Wrench projection auth hash"),
      inputHash: digest(
        value.inputHash,
        "Wrench projection validated input hash",
      ),
    });
  }
  throw new Error("Wrench projection identity response is malformed");
}

function projectionIdentitiesMatch(
  before: ProjectionIdentity,
  after: ProjectionIdentity,
): boolean {
  return before.status === "ready"
    ? after.status === "ready"
      && after.key === before.key
      && after.authIdentity === before.authIdentity
      && after.authHash === before.authHash
      && after.inputHash === before.inputHash
    : after.status === "unbound"
      && after.authIdentity === before.authIdentity
      && after.authHash === before.authHash
      && after.inputHash === before.inputHash;
}

function parseExecutionPreview(
  value: JsonRecord,
  request: PreparedRequest,
): PreviewExecutionIdentity {
  const portable = value.transport === "portable-provider-plugin";
  assertExactKeys(
    value,
    [
      "ok",
      "status",
      "requiresConfirmation",
      "adapter",
      "operation",
      "risk",
      "sideEffect",
      "input",
      "auth",
      "identityBinding",
      "transport",
      ...(portable ? ["portablePluginContract"] : []),
    ],
    [],
    "Wrench execution identity preview",
  );
  if (
    value.ok !== true
    || value.status !== "preview"
    || value.requiresConfirmation !== false
    || value.risk !== "R1"
  ) throw new Error("Wrench execution identity preview is malformed");
  const adapterValue = record(
    value.adapter,
    "Wrench execution identity preview adapter",
  );
  const auth = record(value.auth, "Wrench execution identity preview auth");
  const binding = record(
    value.identityBinding,
    "Wrench execution identity preview binding",
  );
  assertExactKeys(
    adapterValue,
    ["id", "version", "hash"],
    [],
    "Wrench execution identity preview adapter",
  );
  assertExactKeys(
    auth,
    ["id", "kind", "realmFingerprint"],
    [],
    "Wrench execution identity preview auth",
  );
  assertExactKeys(
    binding,
    ["status", "subject", "accountActor", "requestedActor"],
    [],
    "Wrench execution identity preview binding",
  );
  const adapter = Object.freeze({
    id: safeString(
      adapterValue.id,
      "Wrench execution identity preview adapter ID",
      64,
    ),
    version: safeString(
      adapterValue.version,
      "Wrench execution identity preview adapter version",
      64,
    ),
    hash: digest(
      adapterValue.hash,
      "Wrench execution identity preview adapter hash",
    ),
  });
  const operation = safeString(
    value.operation,
    "Wrench execution identity preview operation",
    128,
  );
  if (adapter.id !== request.adapterId || operation !== request.operationId) {
    throw new Error("Wrench execution identity preview route is malformed");
  }
  if (
    safeString(auth.id, "Wrench execution identity preview auth ID", 64)
      !== request.authId
  ) throw new Error("Wrench execution identity preview auth is malformed");
  const realmFingerprint = safeString(
    auth.realmFingerprint,
    "Wrench execution identity preview auth fingerprint",
    16,
  );
  if (!/^[a-f0-9]{16}$/u.test(realmFingerprint)) {
    throw new Error("Wrench execution identity preview auth fingerprint is malformed");
  }
  safeString(auth.kind, "Wrench execution identity preview auth kind", 64);
  safeString(
    value.sideEffect,
    "Wrench execution identity preview side effect",
    64,
  );
  const transport = value.transport;
  if (transport === "portable-provider-plugin") {
    const portablePluginContract = parsePortableOperationIdentity(
      value.portablePluginContract,
    );
    if (
      portablePluginContract.adapterId !== adapter.id
      || portablePluginContract.operation !== operation
    ) throw new Error("Wrench execution identity preview route is malformed");
    return Object.freeze({
      adapter,
      operation,
      transport,
      portablePluginContract,
    });
  }
  if (
    transport !== "browser"
    && transport !== "provider-api"
    && transport !== "web-session-api"
    && transport !== "reviewed-template-api"
  ) throw new Error("Wrench execution identity preview transport is malformed");
  return Object.freeze({ adapter, operation, transport });
}

function parseCatalogExecutionIdentity(
  value: JsonRecord,
  request: PreparedRequest,
  preview: Exclude<
    PreviewExecutionIdentity,
    { readonly transport: "browser" | "portable-provider-plugin" }
  >,
): ExecutionIdentity {
  assertExactKeys(
    value,
    ["ok", "adapters"],
    [],
    "Wrench execution identity catalog",
  );
  if (value.ok !== true || !isUnknownArray(value.adapters)) {
    throw new Error("Wrench execution identity catalog is malformed");
  }
  if (value.adapters.length !== 1) {
    throw new Error("Wrench execution identity catalog is ambiguous");
  }
  const adapterValue = record(
    value.adapters[0],
    "Wrench execution identity catalog adapter",
  );
  assertExactKeys(
    adapterValue,
    [
      "id",
      "version",
      "displayName",
      "surfaceId",
      "origins",
      "manifestHash",
      "operations",
    ],
    [],
    "Wrench execution identity catalog adapter",
  );
  const adapter = Object.freeze({
    id: safeString(
      adapterValue.id,
      "Wrench execution identity catalog adapter ID",
      64,
    ),
    version: safeString(
      adapterValue.version,
      "Wrench execution identity catalog adapter version",
      64,
    ),
    hash: digest(
      adapterValue.manifestHash,
      "Wrench execution identity catalog adapter hash",
    ),
  });
  if (
    adapter.id !== request.adapterId
    || adapter.id !== preview.adapter.id
    || adapter.version !== preview.adapter.version
    || adapter.hash !== preview.adapter.hash
    || !isUnknownArray(adapterValue.operations)
  ) throw new Error("Wrench execution identity preflights disagreed");
  const operations = adapterValue.operations.filter(
    (candidate): candidate is JsonRecord => (
      isRecord(candidate) && candidate.id === request.operationId
    ),
  );
  if (operations.length !== 1) {
    throw new Error("Wrench execution identity catalog operation is ambiguous");
  }
  const operation = operations[0]!;
  const commonKeys = [
    "id",
    "description",
    "risk",
    "sideEffect",
    "idempotency",
    "dedupeWindowMs",
    "transport",
    "input",
  ] as const;
  if (
    operation.risk !== "R1"
    || operation.transport !== preview.transport
  ) throw new Error("Wrench execution identity preflights disagreed");
  const common = Object.freeze({
    adapter,
    operation: preview.operation,
  });
  if (preview.transport === "provider-api") {
    assertExactKeys(
      operation,
      [
        ...commonKeys,
        "provider",
        "providerAction",
        "providerContractVersion",
        "providerContractHash",
        "requiredScopeSets",
        "coverage",
        "implementation",
      ],
      [],
      "Wrench execution identity provider capability",
    );
    safeInteger(
      operation.providerContractVersion,
      "Wrench execution identity provider contract version",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    return Object.freeze({
      ...common,
      schemaVersion: 3 as const,
      transport: "provider-api" as const,
      providerContractHash: digest(
        operation.providerContractHash,
        "Wrench execution identity provider contract hash",
      ),
    });
  }
  if (preview.transport === "web-session-api") {
    assertExactKeys(
      operation,
      [
        ...commonKeys,
        "site",
        "webSessionAction",
        "webSessionContractVersion",
        "webSessionContractHash",
        "state",
        "implementation",
      ],
      [],
      "Wrench execution identity web-session capability",
    );
    safeInteger(
      operation.webSessionContractVersion,
      "Wrench execution identity web-session contract version",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    return Object.freeze({
      ...common,
      schemaVersion: 4 as const,
      transport: "web-session-api" as const,
      webSessionContractHash: digest(
        operation.webSessionContractHash,
        "Wrench execution identity web-session contract hash",
      ),
    });
  }
  assertExactKeys(
    operation,
    [
      ...commonKeys,
      "state",
      "reviewedTemplateContractVersion",
      "reviewedTemplateContractHash",
    ],
    ["instructions", "reviewedAt", "evidenceSha256", "origin"],
    "Wrench execution identity reviewed-template capability",
  );
  safeInteger(
    operation.reviewedTemplateContractVersion,
    "Wrench execution identity reviewed-template contract version",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  return Object.freeze({
    ...common,
    schemaVersion: 5 as const,
    transport: "reviewed-template-api" as const,
    reviewedTemplateContractHash: digest(
      operation.reviewedTemplateContractHash,
      "Wrench execution identity reviewed-template contract hash",
    ),
  });
}

function observeExecutionIdentity(
  request: PreparedRequest,
  options: PreparedClientOptions,
): ExecutionIdentity {
  // Preview owns the portable wrapper identity. The targeted catalog view
  // supplies built-in contract hashes that preview intentionally omits. Keep
  // this receipt fence separate from the opaque projection-key fence because
  // a cache publication error carries no projection key to compare.
  const preview = parseExecutionPreview(
    runIdentityCommand(
      preparedCommand(request, {
        cacheOnly: false,
        projectionIdentityOnly: false,
        preview: true,
        headed: false,
      }),
      options,
      "Wrench execution identity preview",
    ),
    request,
  );
  if (preview.transport === "portable-provider-plugin") {
    return Object.freeze({
      adapter: preview.adapter,
      operation: preview.operation,
      schemaVersion: 6 as const,
      transport: preview.transport,
      portablePluginContract: preview.portablePluginContract,
    });
  }
  if (preview.transport === "browser") {
    return Object.freeze({
      adapter: preview.adapter,
      operation: preview.operation,
      schemaVersion: 2 as const,
      transport: preview.transport,
    });
  }
  return parseCatalogExecutionIdentity(
    runIdentityCommand(
      preparedCapabilitiesCommand(request),
      options,
      "Wrench execution identity catalog preflight",
    ),
    request,
    preview,
  );
}

function receiptExecutionIdentity(
  receipt: WrenchClientRunReceipt,
): ExecutionIdentity {
  const common = Object.freeze({
    adapter: receipt.adapter,
    operation: receipt.operation,
  });
  if (receipt.schemaVersion === 2) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
    });
  }
  if (receipt.schemaVersion === 3) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
      providerContractHash: receipt.providerContractHash,
    });
  }
  if (receipt.schemaVersion === 4) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
      webSessionContractHash: receipt.webSessionContractHash,
    });
  }
  if (receipt.schemaVersion === 5) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
      reviewedTemplateContractHash: receipt.reviewedTemplateContractHash,
    });
  }
  return Object.freeze({
    ...common,
    schemaVersion: receipt.schemaVersion,
    transport: receipt.transport,
    portablePluginContract: receipt.portablePluginContract,
  });
}

function executionIdentitiesMatch(
  left: ExecutionIdentity,
  right: ExecutionIdentity,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function runLiveCommand(
  command: PreparedCommand,
  options: PreparedClientOptions,
): Promise<JsonRecord> {
  requireBunRuntime();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command.arguments, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout.on("data", (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("Wrench live response exceeds its byte bound"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunkValue: Buffer | string) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_ERROR_BYTES) stderr.push(chunk);
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      const output = Buffer.concat(stdout).toString("utf8");
      const error = boundedMessage(Buffer.concat(stderr).toString("utf8"));
      if (output.trim().length === 0) {
        fail(new Error(error || `Wrench live invocation exited ${code ?? signal ?? "unknown"}`));
        return;
      }
      if (code !== 0 && code !== 3 && code !== 5) {
        fail(new Error(error || `Wrench live invocation exited ${code ?? signal ?? "unknown"}`));
        return;
      }
      let parsed: JsonRecord;
      try {
        parsed = parseOutput(output, "Wrench live response");
      } catch (parseError) {
        fail(parseError);
        return;
      }
      settled = true;
      resolve(parsed);
    });
    child.stdin.on("error", fail);
    child.stdin.end(command.input);
  });
}

function parseFreshness(
  value: unknown,
  options: PreparedClientOptions,
  ageMs: number,
): ReadProjectionCacheHit["freshness"] {
  const freshnessValue = record(value, "Wrench cache freshness");
  assertExactKeys(
    freshnessValue,
    ["state", "freshForMs"],
    [],
    "Wrench cache freshness",
  );
  const childState = freshnessValue.state;
  if (childState !== "fresh" && childState !== "stale" && childState !== "unclassified") {
    throw new Error("Wrench cache freshness state is malformed");
  }
  if (options.freshForMs === undefined) {
    if (freshnessValue.freshForMs !== null) {
      throw new Error("Wrench cache freshness window is malformed");
    }
    return Object.freeze({ state: childState, freshForMs: null });
  }
  const freshForMs = safeInteger(
    options.freshForMs,
    "Wrench client freshness window",
    0,
    MAX_FRESH_FOR_MS,
  );
  return Object.freeze({
    state: ageMs <= freshForMs ? "fresh" : "stale",
    freshForMs,
  });
}

function validateReadOptions(options: PreparedClientOptions): Date {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Wrench client observation time is invalid");
  }
  if (options.freshForMs !== undefined) {
    safeInteger(
      options.freshForMs,
      "Wrench client freshness window",
      0,
      MAX_FRESH_FOR_MS,
    );
  }
  return now;
}

function parseCacheResult(
  value: JsonRecord,
  options: PreparedClientOptions,
  now: Date,
): ReadProjectionCacheResult {
  if (value.source !== "cache") throw new Error("Wrench cache response has the wrong source");
  const projection = record(value.projection, "Wrench cache projection");
  if (value.status === "cache-miss") {
    assertExactKeys(
      value,
      ["ok", "source", "status", "projection"],
      [],
      "Wrench cache miss",
    );
    assertExactKeys(
      projection,
      ["key"],
      [],
      "Wrench cache miss projection",
    );
    if (value.ok !== false) throw new Error("Wrench cache miss has the wrong success state");
    const key = digest(projection.key, "Wrench cache key");
    return Object.freeze({ status: "miss", key });
  }
  if (value.status !== "cached" || value.ok !== true || !("output" in value)) {
    throw new Error("Wrench cache response has an unsupported outcome");
  }
  assertExactKeys(
    value,
    ["ok", "source", "status", "projection", "output"],
    [],
    "Wrench cache response",
  );
  assertExactKeys(
    projection,
    [
      "key",
      "dataRevision",
      "createdAt",
      "dataChangedAt",
      "validatedAt",
      "runId",
      "ageMs",
      "freshness",
    ],
    [],
    "Wrench cache projection",
  );
  const key = digest(projection.key, "Wrench cache key");
  const validatedAt = timestamp(projection.validatedAt, "Wrench cache validation time");
  const childAgeMs = safeInteger(projection.ageMs, "Wrench cache age", 0, Number.MAX_SAFE_INTEGER);
  const ageMs = options.now === undefined
    ? childAgeMs
    : Math.max(0, now.getTime() - new Date(validatedAt).getTime());
  return Object.freeze({
    status: "hit" as const,
    source: "cache" as const,
    key,
    output: value.output,
    dataRevision: digest(projection.dataRevision, "Wrench cache data revision"),
    createdAt: timestamp(projection.createdAt, "Wrench cache creation time"),
    dataChangedAt: timestamp(projection.dataChangedAt, "Wrench cache data-change time"),
    validatedAt,
    runId: safeString(projection.runId, "Wrench cache run ID", 64),
    ageMs,
    freshness: parseFreshness(projection.freshness, options, ageMs),
  });
}

function parsePublication(value: unknown): ReadProjectionPublication {
  const publication = record(value, "Wrench cache publication");
  assertExactKeys(
    publication,
    ["key", "dataRevision", "validatedAt", "dataChangedAt", "disposition"],
    ["currentDataRevision"],
    "Wrench cache publication",
  );
  const disposition = publication.disposition;
  if (
    disposition !== "created"
    && disposition !== "changed"
    && disposition !== "unchanged"
    && disposition !== "superseded"
  ) throw new Error("Wrench cache publication disposition is malformed");
  if (
    (disposition === "superseded")
    !== Object.hasOwn(publication, "currentDataRevision")
  ) throw new Error("Wrench cache publication current revision is malformed");
  return Object.freeze({
    key: digest(publication.key, "Wrench cache publication key"),
    dataRevision: digest(publication.dataRevision, "Wrench cache publication data revision"),
    validatedAt: timestamp(publication.validatedAt, "Wrench cache publication validation time"),
    dataChangedAt: timestamp(publication.dataChangedAt, "Wrench cache publication data-change time"),
    disposition,
    ...(publication.currentDataRevision === undefined
      ? {}
      : {
          currentDataRevision: digest(
            publication.currentDataRevision,
            "Wrench current cache data revision",
          ),
        }),
  });
}

function parseCacheOutcome(value: unknown): ReadProjectionCacheOutcome {
  const outcome = record(value, "Wrench cache outcome");
  if (outcome.status === "stored") {
    assertExactKeys(
      outcome,
      ["status", "publication"],
      [],
      "Wrench cache outcome",
    );
    return Object.freeze({ status: "stored", publication: parsePublication(outcome.publication) });
  }
  if (outcome.status === "retained" && outcome.reason === "live-read-failed") {
    assertExactKeys(outcome, ["status", "reason"], [], "Wrench cache outcome");
    return Object.freeze({ status: "retained", reason: "live-read-failed" });
  }
  if (outcome.status === "miss" && outcome.reason === "no-cached-snapshot") {
    assertExactKeys(outcome, ["status", "reason"], [], "Wrench cache outcome");
    return Object.freeze({ status: "miss", reason: "no-cached-snapshot" });
  }
  if (
    outcome.status === "skipped"
    && outcome.reason === "auth-subject-unbound"
  ) {
    assertExactKeys(outcome, ["status", "reason"], [], "Wrench cache outcome");
    return Object.freeze({ status: "skipped", reason: outcome.reason });
  }
  if (outcome.status === "error") {
    assertExactKeys(outcome, ["status", "message"], [], "Wrench cache outcome");
    return Object.freeze({ status: "error", message: safeString(outcome.message, "Wrench cache error", MAX_ERROR_BYTES) });
  }
  throw new Error("Wrench cache outcome is malformed");
}

function parseReceiptStatus(
  value: unknown,
): WrenchClientRunReceipt["status"] {
  if (value !== "succeeded" && value !== "failed") {
    throw new Error("Wrench live receipt status is malformed");
  }
  return value;
}

function parsePortableOperationIdentity(
  value: unknown,
): WrenchClientPortableOperationIdentity {
  const identity = record(value, "Wrench live portable contract");
  assertExactKeys(
    identity,
    [
      "pluginId",
      "pluginVersion",
      "hostApiVersion",
      "bundleSha256",
      "manifestSha256",
      "adapterId",
      "transport",
      "surfaceId",
      "operation",
      "contractVersion",
      "descriptorSha256",
    ],
    [],
    "Wrench live portable contract",
  );
  const transport = identity.transport;
  if (
    transport !== "linked-device"
    && transport !== "provider-api"
    && transport !== "web-session-api"
  ) throw new Error("Wrench live portable contract transport is malformed");
  if (identity.hostApiVersion !== 1) {
    throw new Error("Wrench live portable contract host API version is malformed");
  }
  return Object.freeze({
    pluginId: safeString(identity.pluginId, "Wrench live portable plugin ID", 64),
    pluginVersion: safeString(identity.pluginVersion, "Wrench live portable plugin version", 64),
    hostApiVersion: 1 as const,
    bundleSha256: digest(identity.bundleSha256, "Wrench live portable bundle hash"),
    manifestSha256: digest(identity.manifestSha256, "Wrench live portable manifest hash"),
    adapterId: safeString(identity.adapterId, "Wrench live portable adapter ID", 64),
    transport,
    surfaceId: safeString(identity.surfaceId, "Wrench live portable surface ID", 64),
    operation: safeString(identity.operation, "Wrench live portable operation", 128),
    contractVersion: safeInteger(
      identity.contractVersion,
      "Wrench live portable contract version",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    descriptorSha256: digest(
      identity.descriptorSha256,
      "Wrench live portable descriptor hash",
    ),
  });
}

function parseLiveReceipt(
  value: unknown,
  request: PreparedRequest,
  expectedInputHash: string,
): WrenchClientRunReceipt {
  const receipt = record(value, "Wrench live receipt");
  const commonKeys = [
    "schemaVersion",
    "runId",
    "planDigest",
    "adapter",
    "operation",
    "risk",
    "inputHash",
    "auth",
    "transport",
    "status",
    "dispatchStarted",
    "dispatch",
    "startedAt",
    "finishedAt",
    "finalOrigin",
    "error",
  ] as const;
  if (receipt.schemaVersion === 2 && receipt.transport === "browser") {
    assertExactKeys(receipt, commonKeys, [], "Wrench live receipt");
  } else if (
    receipt.schemaVersion === 3
    && receipt.transport === "provider-api"
  ) {
    assertExactKeys(
      receipt,
      [...commonKeys, "providerContractHash"],
      [],
      "Wrench live receipt",
    );
  } else if (
    receipt.schemaVersion === 4
    && receipt.transport === "web-session-api"
  ) {
    assertExactKeys(
      receipt,
      [...commonKeys, "webSessionContractHash"],
      [],
      "Wrench live receipt",
    );
  } else if (
    receipt.schemaVersion === 5
    && receipt.transport === "reviewed-template-api"
  ) {
    assertExactKeys(
      receipt,
      [...commonKeys, "reviewedTemplateContractHash"],
      [],
      "Wrench live receipt",
    );
  } else if (
    receipt.schemaVersion === 6
    && receipt.transport === "portable-provider-plugin"
  ) {
    assertExactKeys(
      receipt,
      [...commonKeys, "portablePluginContract"],
      [],
      "Wrench live receipt",
    );
  } else {
    throw new Error("Wrench live receipt schema and transport are malformed");
  }
  const adapter = record(receipt.adapter, "Wrench live receipt adapter");
  const auth = record(receipt.auth, "Wrench live receipt auth");
  const dispatch = record(receipt.dispatch, "Wrench live receipt dispatch");
  assertExactKeys(
    adapter,
    ["id", "version", "hash"],
    [],
    "Wrench live receipt adapter",
  );
  assertExactKeys(
    auth,
    ["id", "hash", "kind"],
    [],
    "Wrench live receipt auth",
  );
  assertExactKeys(
    dispatch,
    ["planned", "started", "verified"],
    [],
    "Wrench live receipt dispatch",
  );
  if (receipt.risk !== "R1") {
    throw new Error("Wrench live receipt risk is malformed");
  }
  const authKind = auth.kind;
  if (
    authKind !== "browser-profile"
    && authKind !== "cookie-source"
    && authKind !== "cookies-file"
    && authKind !== "linked-device-store"
    && authKind !== "oauth-token-file"
  ) throw new Error("Wrench live receipt auth kind is malformed");
  if (receipt.dispatchStarted !== false) {
    throw new Error("Wrench live receipt dispatch state is malformed");
  }
  const planned = safeInteger(
    dispatch.planned,
    "Wrench live receipt planned dispatch count",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const started = safeInteger(
    dispatch.started,
    "Wrench live receipt started dispatch count",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const verified = safeInteger(
    dispatch.verified,
    "Wrench live receipt verified dispatch count",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (planned !== 0 || started !== 0 || verified !== 0) {
    throw new Error("Wrench live receipt dispatch counts are inconsistent");
  }
  const status = parseReceiptStatus(receipt.status);
  const finalOrigin = receipt.finalOrigin === null
    ? null
    : safeString(receipt.finalOrigin, "Wrench live receipt final origin", 4_096);
  const error = receipt.error === null
    ? null
    : boundedUtf8String(
        receipt.error,
        "Wrench live receipt error",
        MAX_RUN_RECEIPT_ERROR_BYTES,
      );
  if (receipt.planDigest !== null) {
    throw new Error("Wrench live receipt plan digest is malformed");
  }
  const startedAt = timestamp(receipt.startedAt, "Wrench live receipt start time");
  const finishedAt = timestamp(receipt.finishedAt, "Wrench live receipt finish time");
  if (startedAt > finishedAt) {
    throw new Error("Wrench live receipt finished before it started");
  }
  const common = Object.freeze({
    runId: safeString(receipt.runId, "Wrench live receipt run ID", 64),
    planDigest: null,
    adapter: Object.freeze({
      id: safeString(adapter.id, "Wrench live receipt adapter ID", 64),
      version: safeString(adapter.version, "Wrench live receipt adapter version", 64),
      hash: digest(adapter.hash, "Wrench live receipt adapter hash"),
    }),
    operation: safeString(receipt.operation, "Wrench live receipt operation", 128),
    risk: "R1" as const,
    inputHash: digest(receipt.inputHash, "Wrench live receipt input hash"),
    auth: Object.freeze({
      id: safeString(auth.id, "Wrench live receipt auth ID", 64),
      hash: digest(auth.hash, "Wrench live receipt auth hash"),
      kind: authKind,
    }),
    status,
    dispatchStarted: false as const,
    dispatch: Object.freeze({
      planned: 0 as const,
      started: 0 as const,
      verified: 0 as const,
    }),
    startedAt,
    finishedAt,
    finalOrigin,
    error,
  });
  if (
    common.adapter.id !== request.adapterId
    || common.operation !== request.operationId
  ) throw new Error("Wrench live receipt route does not match its request");
  if (common.auth.id !== request.authId) {
    throw new Error("Wrench live receipt auth does not match its request");
  }
  if (common.inputHash !== expectedInputHash) {
    throw new Error("Wrench live receipt input does not match its request");
  }
  if (receipt.schemaVersion === 2 && receipt.transport === "browser") {
    return Object.freeze({ ...common, schemaVersion: 2 as const, transport: "browser" as const });
  }
  if (receipt.schemaVersion === 3 && receipt.transport === "provider-api") {
    return Object.freeze({
      ...common,
      schemaVersion: 3 as const,
      transport: "provider-api" as const,
      providerContractHash: digest(
        receipt.providerContractHash,
        "Wrench live receipt provider contract hash",
      ),
    });
  }
  if (receipt.schemaVersion === 4 && receipt.transport === "web-session-api") {
    return Object.freeze({
      ...common,
      schemaVersion: 4 as const,
      transport: "web-session-api" as const,
      webSessionContractHash: digest(
        receipt.webSessionContractHash,
        "Wrench live receipt web-session contract hash",
      ),
    });
  }
  if (
    receipt.schemaVersion === 5
    && receipt.transport === "reviewed-template-api"
  ) {
    return Object.freeze({
      ...common,
      schemaVersion: 5 as const,
      transport: "reviewed-template-api" as const,
      reviewedTemplateContractHash: digest(
        receipt.reviewedTemplateContractHash,
        "Wrench live receipt reviewed-template contract hash",
      ),
    });
  }
  if (
    receipt.schemaVersion === 6
    && receipt.transport === "portable-provider-plugin"
  ) {
    const portablePluginContract = parsePortableOperationIdentity(
      receipt.portablePluginContract,
    );
    if (
      portablePluginContract.adapterId !== common.adapter.id
      || portablePluginContract.operation !== common.operation
    ) {
      throw new Error("Wrench live portable contract route is malformed");
    }
    return Object.freeze({
      ...common,
      schemaVersion: 6 as const,
      transport: "portable-provider-plugin" as const,
      portablePluginContract,
    });
  }
  throw new Error("Wrench live receipt schema and transport are malformed");
}

function parseLiveResult(
  value: JsonRecord,
  request: PreparedRequest,
  expectedInputHash: string,
): {
  readonly live: WrenchClientInvocationResult;
  readonly cache: ReadProjectionCacheOutcome;
} {
  assertExactKeys(
    value,
    ["ok", "source", "status", "runId", "replayed", "receipt", "output", "cache"],
    [],
    "Wrench live response",
  );
  if (value.source !== "live") throw new Error("Wrench live response has the wrong source");
  const receipt = parseLiveReceipt(value.receipt, request, expectedInputHash);
  const status = safeString(value.status, "Wrench live status", 32);
  const responseRunId = safeString(value.runId, "Wrench live run ID", 64);
  const expectedOk = receipt.status === "succeeded";
  if (
    status !== receipt.status
    || receipt.runId !== responseRunId
    || value.ok !== expectedOk
  ) {
    throw new Error("Wrench live response is not bound to its receipt");
  }
  if (typeof value.replayed !== "boolean" || !("output" in value)) {
    throw new Error("Wrench live response is incomplete");
  }
  const cache = parseCacheOutcome(value.cache);
  const cacheMatchesReceipt = receipt.status === "succeeded"
    ? cache.status === "stored"
      || cache.status === "error"
      || cache.status === "skipped"
    : cache.status === "retained"
      || cache.status === "miss"
      || cache.status === "error"
      || cache.status === "skipped";
  if (!cacheMatchesReceipt) {
    throw new Error(
      "Wrench live cache outcome is inconsistent with its receipt",
    );
  }
  return Object.freeze({
    live: Object.freeze({
      receipt,
      output: value.output,
      replayed: value.replayed,
    }),
    cache,
  });
}

export function readCachedCapability(
  request: CapabilityReadRequest,
  options: ReadCapabilityOptions = {},
): ReadProjectionCacheResult {
  const preparedOptions = snapshotClientOptions(options, false);
  const now = validateReadOptions(preparedOptions);
  const prepared = prepareRequest(request);
  return readCachedPreparedCapability(prepared, preparedOptions, now);
}

function readCachedPreparedCapability(
  request: PreparedRequest,
  options: PreparedClientOptions,
  now: Date,
): ReadProjectionCacheResult {
  const command = preparedCommand(request, {
    cacheOnly: true,
    projectionIdentityOnly: false,
    headed: false,
  });
  return parseCacheResult(
    runCacheCommand(command, options).output,
    options,
    now,
  );
}

function selectCurrentCapability(
  cachedBefore: ReadProjectionCacheResult | null,
  cachedAfter: ReadProjectionCacheResult | null,
  parsed: Pick<RevalidatedCapability, "live" | "cache">,
): RevalidatedCapabilityCurrent {
  const before = cachedBefore?.status === "hit" ? cachedBefore : null;
  const after = cachedAfter?.status === "hit" ? cachedAfter : null;
  if (parsed.live.receipt.status === "failed") return after;
  if (parsed.cache.status === "stored") {
    if (after !== null) return after;
    if (parsed.cache.publication.disposition === "superseded") return null;
    return Object.freeze({ source: "live", output: parsed.live.output });
  }
  if (parsed.cache.status === "error") {
    const cacheAdvanced = after !== null
      && (
        before === null
        || after.runId !== before.runId
        || after.dataRevision !== before.dataRevision
        || after.validatedAt !== before.validatedAt
      );
    if (cacheAdvanced) return after;
  }
  return Object.freeze({ source: "live", output: parsed.live.output });
}

async function runRevalidation(
  request: PreparedRequest,
  options: PreparedClientOptions,
  executionIdentityBefore: ExecutionIdentity,
  identityBefore: ProjectionIdentity,
  cachedBefore: ReadProjectionCacheResult | null,
  observationTime: Date,
): Promise<RevalidatedCapability> {
  const parsed = parseLiveResult(
    await runLiveCommand(
      preparedCommand(request, {
        cacheOnly: false,
        projectionIdentityOnly: false,
        headed: options.headed ?? false,
      }),
      options,
    ),
    request,
    identityBefore.inputHash,
  );
  // Identity preflights do not decode projection payloads, so corrupt local
  // data can still be repaired by a live read. Every process receives one
  // frozen options/environment snapshot. Both the projection key and unbound
  // auth token include Wrench's auth incarnation and detect A-to-B-to-A
  // mutations.
  const identityAfter = observeProjectionIdentity(request, options);
  if (!projectionIdentitiesMatch(identityBefore, identityAfter)) {
    throw new Error(
      "Wrench projection identity changed while revalidation was running; the live result was discarded",
    );
  }
  if (!executionIdentitiesMatch(
    executionIdentityBefore,
    receiptExecutionIdentity(parsed.live.receipt),
  )) {
    throw new Error(
      "Wrench execution identity changed while revalidation was running; the live result was discarded",
    );
  }
  if (parsed.live.receipt.auth.hash !== identityBefore.authHash) {
    throw new Error(
      "Wrench projection identity changed while revalidation was running; the live result was discarded",
    );
  }
  if (identityBefore.status === "unbound") {
    if (parsed.cache.status !== "skipped") {
      throw new Error(
        "Wrench projection identity changed while revalidation was running; the live result was discarded",
      );
    }
    return Object.freeze({
      cachedBefore: null,
      cachedAfter: null,
      current: selectCurrentCapability(null, null, parsed),
      ...parsed,
    });
  }
  if (
    parsed.cache.status === "skipped"
    || (
      parsed.cache.status === "stored"
      && parsed.cache.publication.key !== identityBefore.key
    )
  ) {
    throw new Error(
      "Wrench projection identity changed while revalidation was running; the live result was discarded",
    );
  }
  let cachedAfter: ReadProjectionCacheResult | null = null;
  try {
    cachedAfter = readCachedPreparedCapability(
      request,
      options,
      observationTime,
    );
  } catch {
    // The identity-only preflight remains authoritative when a corrupt cache
    // payload could not be decoded before or after live repair.
  }
  if (
    (cachedBefore !== null && cachedBefore.key !== identityBefore.key)
    || (cachedAfter !== null && cachedAfter.key !== identityBefore.key)
  ) {
    throw new Error(
      "Wrench projection identity changed while revalidation was running; the live result was discarded",
    );
  }
  return Object.freeze({
    cachedBefore,
    cachedAfter,
    current: selectCurrentCapability(cachedBefore, cachedAfter, parsed),
    ...parsed,
  });
}

type CachedBeforeSource =
  | { readonly status: "provided"; readonly value: ReadProjectionCacheResult | null }
  | { readonly status: "lookup" };

function scheduleRevalidation(
  request: PreparedRequest,
  options: PreparedClientOptions,
  observationTime: Date,
  cachedBeforeSource: CachedBeforeSource,
): Promise<RevalidatedCapability> {
  // Promise callbacks run after the public API returns. Keep every identity
  // and live subprocess behind this boundary while retaining the exact frozen
  // request, options, observation time, and any cache-only SWR result.
  return Promise.resolve().then(() => {
    const executionIdentityBefore = observeExecutionIdentity(request, options);
    const identityBefore = observeProjectionIdentity(request, options);
    let cachedBefore = cachedBeforeSource.status === "provided"
      ? cachedBeforeSource.value
      : null;
    if (
      cachedBeforeSource.status === "lookup"
      && identityBefore.status === "ready"
    ) {
      try {
        cachedBefore = readCachedPreparedCapability(
          request,
          options,
          observationTime,
        );
      } catch {
        // A valid identity preflight fences live repair even when the encrypted
        // projection itself is corrupt or temporarily unreadable.
      }
    }
    if (
      cachedBefore !== null
      && (
        identityBefore.status !== "ready"
        || cachedBefore.key !== identityBefore.key
      )
    ) {
      throw new Error(
        "Wrench projection identity changed before revalidation started",
      );
    }
    return runRevalidation(
      request,
      options,
      executionIdentityBefore,
      identityBefore,
      cachedBefore,
      observationTime,
    );
  });
}

export function revalidateCapability(
  request: CapabilityReadRequest,
  options: RevalidateCapabilityOptions = {},
): Promise<RevalidatedCapability> {
  const preparedOptions = snapshotClientOptions(options, true);
  const now = validateReadOptions(preparedOptions);
  const prepared = prepareRequest(request);
  return scheduleRevalidation(
    prepared,
    preparedOptions,
    now,
    { status: "lookup" },
  );
}

/**
 * Read the current exact projection synchronously through Wrench's installed
 * cache-only command, then start one semantic R1 revalidation through the same
 * CLI safety kernel. No provider runtime is bundled into this client module.
 */
export function staleWhileRevalidateCapability(
  request: CapabilityReadRequest,
  options: RevalidateCapabilityOptions = {},
): {
  readonly cached: ReadProjectionCacheResult | null;
  readonly revalidation: Promise<RevalidatedCapability>;
} {
  const preparedOptions = snapshotClientOptions(options, true);
  const now = validateReadOptions(preparedOptions);
  const prepared = prepareRequest(request);
  let cached: ReadProjectionCacheResult | null = null;
  try {
    cached = readCachedPreparedCapability(prepared, preparedOptions, now);
  } catch {
    // Cache corruption or an unbound subject must not suppress the separately
    // scheduled live path.
  }
  return Object.freeze({
    cached,
    revalidation: scheduleRevalidation(
      prepared,
      preparedOptions,
      now,
      { status: "provided", value: cached },
    ),
  });
}

export type {
  CapabilityReadRequest,
  ReadCapabilityOptions,
  ReadProjectionCacheResult,
  ReadProjectionCacheOutcome,
  ReadProjectionPublication,
  RevalidateCapabilityOptions,
  RevalidatedCapability,
  RevalidatedCapabilityCurrent,
  WrenchClientEnvironment,
  WrenchClientInvocationResult,
  WrenchClientPortableOperationIdentity,
  WrenchClientRunReceipt,
  WrenchClientRunReceiptCommon,
} from "./client-types";
