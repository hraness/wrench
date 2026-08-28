// @bun
import {
  PROVIDER_PLUGIN_ID_MAX_LENGTH,
  PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH,
  isProviderPluginOperationName,
  isProviderPluginSurfaceId
} from "./index-26yq8q16.js";
import {
  canonicalJson,
  sha256
} from "./index-dqv16dt0.js";

// src/client.ts
import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { types as nodeTypes } from "util";

// src/provider-plugin-portable-identity.ts
var PORTABLE_OPERATION_IDENTITY_VERSION = 1;
var descriptorDomain = `io-portable-operation-descriptor-v${PORTABLE_OPERATION_IDENTITY_VERSION}\x00`;
var pluginIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var pluginVersionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
var sha256Pattern = /^[a-f0-9]{64}$/u;
var adapterIdPattern = /^[a-z][a-z0-9-]{0,47}$/u;
var operationPattern = /^[a-z][a-z0-9-]{0,39}(?:\.[a-z][a-z0-9-]{0,39}){1,3}$/u;
function ownDataValue(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`${label} contains unsupported accessor state`);
  }
  return descriptor.value;
}
function identityRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("portable operation identity must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("portable operation identity must be a plain object");
  }
  const keys = Reflect.ownKeys(value);
  const expected = [
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
    "descriptorSha256"
  ].sort();
  if (keys.some((key) => typeof key !== "string") || keys.length !== expected.length || keys.sort().some((key, index) => key !== expected[index])) {
    throw new Error("portable operation identity has unsupported fields");
  }
  const result = {};
  for (const key of expected) {
    result[key] = ownDataValue(value, key, `portable operation identity.${key}`);
  }
  return result;
}
function parsePortableOperationIdentityV1(value) {
  const record = identityRecord(value);
  if (typeof record.pluginId !== "string" || record.pluginId.length > 128 || !pluginIdPattern.test(record.pluginId) || typeof record.pluginVersion !== "string" || record.pluginVersion.length > 128 || !pluginVersionPattern.test(record.pluginVersion) || record.hostApiVersion !== 1 || typeof record.bundleSha256 !== "string" || !sha256Pattern.test(record.bundleSha256) || typeof record.manifestSha256 !== "string" || !sha256Pattern.test(record.manifestSha256) || typeof record.adapterId !== "string" || !adapterIdPattern.test(record.adapterId) || record.transport !== "provider-api" && record.transport !== "web-session-api" && record.transport !== "linked-device" || typeof record.surfaceId !== "string" || record.surfaceId.length > 128 || !pluginIdPattern.test(record.surfaceId) || typeof record.operation !== "string" || !operationPattern.test(record.operation) || typeof record.contractVersion !== "number" || !Number.isSafeInteger(record.contractVersion) || record.contractVersion < 1 || record.contractVersion > 1e6 || typeof record.descriptorSha256 !== "string" || !sha256Pattern.test(record.descriptorSha256)) {
    throw new Error("portable operation identity is malformed");
  }
  return Object.freeze({
    pluginId: record.pluginId,
    pluginVersion: record.pluginVersion,
    hostApiVersion: 1,
    bundleSha256: record.bundleSha256,
    manifestSha256: record.manifestSha256,
    adapterId: record.adapterId,
    transport: record.transport,
    surfaceId: record.surfaceId,
    operation: record.operation,
    contractVersion: record.contractVersion,
    descriptorSha256: record.descriptorSha256
  });
}

// src/client.ts
var MAX_INPUT_BYTES = 1024 * 1024;
var MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
var MAX_ERROR_BYTES = 8 * 1024;
var MAX_RUN_RECEIPT_ERROR_BYTES = 12 * 1024;
var MAX_FRESH_FOR_MS = 365 * 24 * 60 * 60 * 1000;
var MAX_INPUT_DEPTH = 64;
var MAX_INPUT_NODES = 1e5;
var abortSignalAbortedGetter = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
  const getter = descriptor === undefined ? undefined : Reflect.get(descriptor, "get");
  return typeof getter !== "function" ? undefined : (value) => Reflect.apply(getter, value, []);
})();
var PUBLIC_WEB_SESSION_AUTHORITY_KIND = "public-web-session";
function publicWebSessionAuthority(request) {
  const coordinate = Object.freeze({
    adapter: request.adapterId,
    operation: request.operationId
  });
  return Object.freeze({
    schemaVersion: 1,
    id: `public-${sha256(canonicalJson(coordinate)).slice(0, 32)}`,
    kind: PUBLIC_WEB_SESSION_AUTHORITY_KIND,
    subject: `public:${request.adapterId}:${request.operationId}`
  });
}
function expectedRequestAuthId(request, authKind) {
  if (authKind === PUBLIC_WEB_SESSION_AUTHORITY_KIND) {
    if (request.authId !== undefined) {
      throw new Error("Wrench public invocation unexpectedly accepted an auth locator");
    }
    return publicWebSessionAuthority(request).id;
  }
  return request.authId ?? request.adapterId;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isUnknownArray(value) {
  return Array.isArray(value);
}
function record(value, label) {
  if (!isRecord(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error(`${label} must be a plain data object`);
  }
  const result = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must be a plain data object`);
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true
    });
  }
  return result;
}
function assertExactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key)))
    throw new Error(`${label} is malformed`);
}
var clientReadFailureRetryDisposition = Object.freeze({
  "target-unavailable": "do-not-retry",
  "auth-repair-required": "repair-auth",
  "account-mismatch": "do-not-retry",
  "provider-throttled": "retry-once-after-60s",
  "provider-temporary": "retry-once-after-60s",
  "operation-timeout": "retry-once-after-60s",
  "contract-drift": "do-not-retry",
  "cleanup-required": "do-not-retry"
});
function parseClientReadFailure(value) {
  const failure = record(value, "Wrench read failure");
  assertExactKeys(failure, ["category", "retryDisposition"], [], "Wrench read failure");
  const category = failure.category;
  if (typeof category !== "string" || !Object.hasOwn(clientReadFailureRetryDisposition, category))
    throw new Error("Wrench read failure category is malformed");
  const retryDisposition = clientReadFailureRetryDisposition[category];
  if (failure.retryDisposition !== retryDisposition) {
    throw new Error("Wrench read failure retry disposition is inconsistent");
  }
  return Object.freeze({ category, retryDisposition });
}
function snapshotJson(value, label) {
  let nodes = 0;
  const ancestors = new WeakSet;
  const completed = new WeakMap;
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) {
      throw new Error(`${label} exceeds its structural bound`);
    }
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string")
      return candidate;
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
    if (prior !== undefined)
      return prior;
    if (ancestors.has(candidate))
      throw new Error(`${label} must not be circular`);
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getPrototypeOf(candidate) !== Array.prototype) {
          throw new Error(`${label} arrays must use the standard prototype`);
        }
        const descriptors2 = Object.getOwnPropertyDescriptors(candidate);
        const descriptorKeys2 = Reflect.ownKeys(descriptors2);
        if (descriptorKeys2.some((key) => typeof key !== "string")) {
          throw new Error(`${label} arrays have unsupported symbol fields`);
        }
        const lengthDescriptor = descriptors2.length;
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0)
          throw new Error(`${label} arrays are malformed`);
        const length = lengthDescriptor.value;
        const keys = descriptorKeys2.filter((key) => typeof key === "string" && key !== "length");
        if (keys.length !== length || keys.some((key, index) => key !== String(index)))
          throw new Error(`${label} arrays must be dense data arrays`);
        const cloned2 = [];
        for (let index = 0;index < length; index += 1) {
          const descriptor = descriptors2[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
            throw new Error(`${label} arrays must contain only data elements`);
          cloned2.push(visit(descriptor.value, depth + 1));
        }
        const snapshot2 = Object.freeze(cloned2);
        completed.set(candidate, snapshot2);
        return snapshot2;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${label} objects must use a plain prototype`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const descriptorKeys = Reflect.ownKeys(descriptors);
      if (descriptorKeys.some((key) => typeof key !== "string")) {
        throw new Error(`${label} objects have unsupported symbol fields`);
      }
      const cloned = {};
      for (const key of descriptorKeys.sort((left, right) => left.localeCompare(right))) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
          throw new Error(`${label} objects must contain only data properties`);
        Object.defineProperty(cloned, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false
        });
      }
      const snapshot = Object.freeze(cloned);
      completed.set(candidate, snapshot);
      return snapshot;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value, 0);
}
function safeString(value, label, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value || [...value].some((character) => {
    const code = character.codePointAt(0) ?? -1;
    return code <= 31 || code === 127;
  }))
    throw new Error(`${label} is malformed`);
  return value;
}
function providerOperationName(value, label) {
  const operation = safeString(value, label, PROVIDER_PLUGIN_OPERATION_NAME_MAX_LENGTH);
  if (!isProviderPluginOperationName(operation)) {
    throw new Error(`${label} is malformed`);
  }
  return operation;
}
function providerSurfaceId(value, label) {
  const surface = safeString(value, label, PROVIDER_PLUGIN_ID_MAX_LENGTH);
  if (!isProviderPluginSurfaceId(surface)) {
    throw new Error(`${label} is malformed`);
  }
  return surface;
}
function boundedUtf8String(value, label, maximumBytes) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes)
    throw new Error(`${label} is malformed`);
  return value;
}
function digest(value, label) {
  const text = safeString(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(text))
    throw new Error(`${label} is malformed`);
  return text;
}
function safeInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}
function timestamp(value, label) {
  const text = safeString(value, label, 64);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${label} is malformed`);
  }
  return text;
}
function boundedMessage(value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_ERROR_BYTES)
    return value.trim();
  return `${bytes.subarray(0, MAX_ERROR_BYTES).toString("utf8").trim()}\u2026`;
}
function cliSourcePath() {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource))
    return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource))
    return packagedSource;
  throw new Error("the installed Wrench CLI source is unavailable");
}
function requireBunRuntime() {
  if (typeof process.versions.bun !== "string") {
    throw new Error("@hraness/wrench/client requires Bun to run the installed Wrench CLI");
  }
}
function environmentName(value) {
  if (value.length < 1 || value.includes("=") || value.includes("\x00")) {
    throw new Error("Wrench client environment name is malformed");
  }
  return value;
}
function defineEnvironmentValue(environment, key, value) {
  Object.defineProperty(environment, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}
function snapshotChildEnvironment(overrides) {
  const environment = Object.create(null);
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string")
      defineEnvironmentValue(environment, key, value);
  }
  if (overrides === undefined)
    return Object.freeze(environment);
  if (!isRecord(overrides) || nodeTypes.isProxy(overrides) || Object.getPrototypeOf(overrides) !== Object.prototype && Object.getPrototypeOf(overrides) !== null) {
    throw new Error("Wrench client environment must use a plain, non-proxy object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(overrides);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error("Wrench client environment has unsupported symbol fields");
  }
  for (const key of keys.sort((left, right) => left.localeCompare(right))) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error("Wrench client environment must contain only data properties");
    }
    if (!descriptor.enumerable) {
      throw new Error("Wrench client environment properties must be enumerable");
    }
    const name = environmentName(key);
    if (descriptor.value === undefined) {
      delete environment[name];
    } else if (typeof descriptor.value !== "string" || descriptor.value.includes("\x00")) {
      throw new Error("Wrench client environment value is malformed");
    } else {
      defineEnvironmentValue(environment, name, descriptor.value);
    }
  }
  return Object.freeze(environment);
}
function isBrandedAbortSignal(value) {
  if (nodeTypes.isProxy(value) || typeof value !== "object" || value === null || abortSignalAbortedGetter === undefined)
    return false;
  if (Object.getPrototypeOf(value) !== AbortSignal.prototype)
    return false;
  try {
    return typeof abortSignalAbortedGetter(value) === "boolean";
  } catch {
    return false;
  }
}
function snapshotClientOptions(optionsValue, mode) {
  if (!isRecord(optionsValue) || nodeTypes.isProxy(optionsValue) || Object.getPrototypeOf(optionsValue) !== Object.prototype && Object.getPrototypeOf(optionsValue) !== null)
    throw new Error("Wrench client options must use a plain, non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(optionsValue);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    throw new Error("Wrench client options have unsupported symbol fields");
  }
  const allowed = new Set(mode === "read" ? ["environment", "freshForMs", "now"] : mode === "revalidation" ? ["environment", "freshForMs", "now", "headed", "signal"] : mode === "invoke-async" ? ["environment", "headed", "signal"] : ["environment", "headed"]);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !allowed.has(key)) {
      throw new Error("Wrench client options contain an unsupported field");
    }
    if (!("value" in descriptor)) {
      throw new Error("Wrench client options must contain only data properties");
    }
  }
  const option = (key) => descriptors[key]?.value;
  const freshForMsValue = option("freshForMs");
  const nowValue = option("now");
  const headedValue = option("headed");
  const signalValue = option("signal");
  const freshForMs = freshForMsValue === undefined ? undefined : safeInteger(freshForMsValue, "Wrench client freshness window", 0, MAX_FRESH_FOR_MS);
  let now;
  if (nowValue !== undefined) {
    if (nodeTypes.isProxy(nowValue) || !(nowValue instanceof Date) || Object.getPrototypeOf(nowValue) !== Date.prototype)
      throw new Error("Wrench client observation time is invalid");
    let time;
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
  if (signalValue !== undefined && !isBrandedAbortSignal(signalValue))
    throw new Error("Wrench client abort signal is malformed");
  return Object.freeze({
    cwd: process.cwd(),
    environment: snapshotChildEnvironment(option("environment")),
    ...freshForMs === undefined ? {} : { freshForMs },
    ...now === undefined ? {} : { now },
    ...headedValue === undefined ? {} : { headed: headedValue },
    ...signalValue === undefined ? {} : { signal: signalValue }
  });
}
function prepareRequest(requestValue) {
  const snapshot = snapshotJson(requestValue, "Wrench client request");
  const request = record(snapshot, "Wrench client request");
  assertExactKeys(request, ["adapterId", "operationId"], ["authId", "input"], "Wrench client request");
  const adapterId = safeString(request.adapterId, "Wrench client adapter ID", 64);
  const operationId = providerOperationName(request.operationId, "Wrench client operation ID");
  const authId = Object.hasOwn(request, "authId") ? safeString(request.authId, "Wrench client auth ID", 64) : undefined;
  const rawInput = Object.hasOwn(request, "input") ? request.input : {};
  if (!isRecord(rawInput))
    throw new Error("input must be a JSON object");
  const input = canonicalJson(rawInput);
  if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Wrench client input exceeds its byte bound");
  }
  return Object.freeze({
    adapterId,
    operationId,
    ...authId === undefined ? {} : { authId },
    input
  });
}
function preparedCommand(request, options) {
  return Object.freeze({
    arguments: Object.freeze([
      cliSourcePath(),
      "invoke",
      request.adapterId,
      request.operationId,
      "--input",
      "-",
      ...request.authId === undefined ? [] : ["--auth", request.authId],
      ...options.cacheOnly ? ["--cache-only"] : [],
      ...options.projectionIdentityOnly ? ["--projection-identity-only"] : [],
      ...options.preview === true ? ["--preview"] : [],
      ...options.headed ? ["--headed"] : [],
      "--json"
    ]),
    input: request.input
  });
}
function preparedCapabilitiesCommand(request) {
  return Object.freeze({
    arguments: Object.freeze([
      cliSourcePath(),
      "capabilities",
      request.adapterId,
      "--json"
    ]),
    input: ""
  });
}
function parseOutput(text, label) {
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error(`${label} exceeds its byte bound`);
  }
  try {
    return record(JSON.parse(text), label);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be an object`)
      throw error;
    throw new Error(`${label} is malformed`);
  }
}
function runCacheCommand(command, options) {
  requireBunRuntime();
  const result = spawnSync(process.execPath, command.arguments, {
    cwd: options.cwd,
    env: options.environment,
    input: command.input,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.error !== undefined)
    throw result.error;
  const code = result.status ?? 3;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (stdout.trim().length === 0) {
    throw new Error(boundedMessage(stderr) || `Wrench cache lookup exited ${code}`);
  }
  if (code !== 0 && code !== 3) {
    throw new Error(boundedMessage(stderr) || `Wrench cache lookup exited ${code}`);
  }
  return Object.freeze({
    code,
    output: parseOutput(stdout, "Wrench cache response")
  });
}
function runIdentityCommand(command, options, label, responseLabel = `${label} response`) {
  requireBunRuntime();
  const result = spawnSync(process.execPath, command.arguments, {
    cwd: options.cwd,
    env: options.environment,
    input: command.input,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.error !== undefined)
    throw result.error;
  const code = result.status ?? 3;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (stdout.trim().length === 0 || code !== 0) {
    throw new Error(boundedMessage(stderr) || `${label} exited ${code}`);
  }
  return parseOutput(stdout, responseLabel);
}
function runProjectionIdentityCommand(command, options) {
  return runIdentityCommand(command, options, "Wrench projection identity preflight", "Wrench projection identity response");
}
function observeProjectionIdentity(request, options) {
  const value = runProjectionIdentityCommand(preparedCommand(request, {
    cacheOnly: false,
    projectionIdentityOnly: true,
    headed: false
  }), options);
  if (value.ok !== true || value.source !== "projection-identity")
    throw new Error("Wrench projection identity response is malformed");
  if (value.status === "ready") {
    assertExactKeys(value, [
      "ok",
      "source",
      "status",
      "authIdentity",
      "authHash",
      "inputHash",
      "projection"
    ], [], "Wrench projection identity response");
    const projection = record(value.projection, "Wrench projection identity");
    assertExactKeys(projection, ["key"], [], "Wrench projection identity");
    return Object.freeze({
      status: "ready",
      key: digest(projection.key, "Wrench projection identity key"),
      authIdentity: digest(value.authIdentity, "Wrench projection auth identity"),
      authHash: digest(value.authHash, "Wrench projection auth hash"),
      inputHash: digest(value.inputHash, "Wrench projection validated input hash")
    });
  }
  if (value.status === "unbound") {
    assertExactKeys(value, [
      "ok",
      "source",
      "status",
      "authIdentity",
      "authHash",
      "inputHash"
    ], [], "Wrench projection identity response");
    return Object.freeze({
      status: "unbound",
      authIdentity: digest(value.authIdentity, "Wrench projection auth identity"),
      authHash: digest(value.authHash, "Wrench projection auth hash"),
      inputHash: digest(value.inputHash, "Wrench projection validated input hash")
    });
  }
  throw new Error("Wrench projection identity response is malformed");
}
function projectionIdentitiesMatch(before, after) {
  return before.status === "ready" ? after.status === "ready" && after.key === before.key && after.authIdentity === before.authIdentity && after.authHash === before.authHash && after.inputHash === before.inputHash : after.status === "unbound" && after.authIdentity === before.authIdentity && after.authHash === before.authHash && after.inputHash === before.inputHash;
}
function parseExecutionPreview(value, request) {
  const portable = value.transport === "portable-provider-plugin";
  assertExactKeys(value, [
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
    ...portable ? ["portablePluginContract"] : []
  ], [], "Wrench execution identity preview");
  if (value.ok !== true || value.status !== "preview" || value.requiresConfirmation !== false || value.risk !== "R1")
    throw new Error("Wrench execution identity preview is malformed");
  const adapterValue = record(value.adapter, "Wrench execution identity preview adapter");
  const auth = record(value.auth, "Wrench execution identity preview auth");
  const binding = record(value.identityBinding, "Wrench execution identity preview binding");
  assertExactKeys(adapterValue, ["id", "version", "hash"], [], "Wrench execution identity preview adapter");
  assertExactKeys(auth, ["id", "kind", "realmFingerprint"], [], "Wrench execution identity preview auth");
  assertExactKeys(binding, ["status", "subject", "accountActor", "requestedActor"], [], "Wrench execution identity preview binding");
  const adapter = Object.freeze({
    id: safeString(adapterValue.id, "Wrench execution identity preview adapter ID", 64),
    version: safeString(adapterValue.version, "Wrench execution identity preview adapter version", 64),
    hash: digest(adapterValue.hash, "Wrench execution identity preview adapter hash")
  });
  const operation = providerOperationName(value.operation, "Wrench execution identity preview operation");
  if (adapter.id !== request.adapterId || operation !== request.operationId) {
    throw new Error("Wrench execution identity preview route is malformed");
  }
  const authKind = safeString(auth.kind, "Wrench execution identity preview auth kind", 64);
  if (safeString(auth.id, "Wrench execution identity preview auth ID", 64) !== expectedRequestAuthId(request, authKind))
    throw new Error("Wrench execution identity preview auth is malformed");
  const realmFingerprint = safeString(auth.realmFingerprint, "Wrench execution identity preview auth fingerprint", 16);
  if (!/^[a-f0-9]{16}$/u.test(realmFingerprint)) {
    throw new Error("Wrench execution identity preview auth fingerprint is malformed");
  }
  if (authKind === PUBLIC_WEB_SESSION_AUTHORITY_KIND) {
    const authority = publicWebSessionAuthority(request);
    if (value.transport !== "web-session-api" || realmFingerprint !== sha256(canonicalJson(authority)).slice(0, 16) || binding.status !== "public" || binding.subject !== authority.subject || binding.accountActor !== null || binding.requestedActor !== null) {
      throw new Error("Wrench execution identity preview public authority is malformed");
    }
  }
  safeString(value.sideEffect, "Wrench execution identity preview side effect", 64);
  const transport = value.transport;
  if (transport === "portable-provider-plugin") {
    const portablePluginContract = parsePortableOperationIdentity(value.portablePluginContract);
    if (portablePluginContract.adapterId !== adapter.id || portablePluginContract.operation !== operation)
      throw new Error("Wrench execution identity preview route is malformed");
    return Object.freeze({
      adapter,
      operation,
      transport,
      portablePluginContract
    });
  }
  if (transport !== "browser" && transport !== "provider-api" && transport !== "web-session-api" && transport !== "reviewed-template-api" && transport !== "local-cli")
    throw new Error("Wrench execution identity preview transport is malformed");
  return Object.freeze({ adapter, operation, transport });
}
function parseCatalogExecutionIdentity(value, request, preview) {
  assertExactKeys(value, ["ok", "adapters"], [], "Wrench execution identity catalog");
  if (value.ok !== true || !isUnknownArray(value.adapters)) {
    throw new Error("Wrench execution identity catalog is malformed");
  }
  if (value.adapters.length !== 1) {
    throw new Error("Wrench execution identity catalog is ambiguous");
  }
  const adapterValue = record(value.adapters[0], "Wrench execution identity catalog adapter");
  assertExactKeys(adapterValue, [
    "id",
    "version",
    "displayName",
    "surfaceId",
    "origins",
    "manifestHash",
    "operations"
  ], [], "Wrench execution identity catalog adapter");
  const adapter = Object.freeze({
    id: safeString(adapterValue.id, "Wrench execution identity catalog adapter ID", 64),
    version: safeString(adapterValue.version, "Wrench execution identity catalog adapter version", 64),
    hash: digest(adapterValue.manifestHash, "Wrench execution identity catalog adapter hash")
  });
  if (adapter.id !== request.adapterId || adapter.id !== preview.adapter.id || adapter.version !== preview.adapter.version || adapter.hash !== preview.adapter.hash || !isUnknownArray(adapterValue.operations))
    throw new Error("Wrench execution identity preflights disagreed");
  const operations = adapterValue.operations.filter((candidate) => isRecord(candidate) && candidate.id === request.operationId);
  if (operations.length !== 1) {
    throw new Error("Wrench execution identity catalog operation is ambiguous");
  }
  const operation = operations[0];
  const commonKeys = [
    "id",
    "description",
    "risk",
    "sideEffect",
    "idempotency",
    "dedupeWindowMs",
    "transport",
    "input"
  ];
  if (operation.risk !== "R1" || operation.transport !== preview.transport)
    throw new Error("Wrench execution identity preflights disagreed");
  const common = Object.freeze({
    adapter,
    operation: preview.operation
  });
  if (preview.transport === "provider-api") {
    assertExactKeys(operation, [
      ...commonKeys,
      "provider",
      "providerAction",
      "providerContractVersion",
      "providerContractHash",
      "requiredScopeSets",
      "coverage",
      "implementation"
    ], [], "Wrench execution identity provider capability");
    const catalogSurface = providerSurfaceId(adapterValue.surfaceId, "Wrench execution identity catalog surface");
    const provider = providerSurfaceId(operation.provider, "Wrench execution identity provider surface");
    const providerAction = providerOperationName(operation.providerAction, "Wrench execution identity provider action");
    safeInteger(operation.providerContractVersion, "Wrench execution identity provider contract version", 1, 1e6);
    if (provider !== catalogSurface || providerAction !== preview.operation)
      throw new Error("Wrench execution identity provider route is malformed");
    return Object.freeze({
      ...common,
      schemaVersion: 3,
      transport: "provider-api",
      providerContractHash: digest(operation.providerContractHash, "Wrench execution identity provider contract hash")
    });
  }
  if (preview.transport === "web-session-api") {
    assertExactKeys(operation, [
      ...commonKeys,
      "site",
      "webSessionAction",
      "webSessionContractVersion",
      "webSessionContractHash",
      "state",
      "implementation"
    ], [], "Wrench execution identity web-session capability");
    const catalogSurface = providerSurfaceId(adapterValue.surfaceId, "Wrench execution identity catalog surface");
    const site = providerSurfaceId(operation.site, "Wrench execution identity web-session surface");
    const webSessionAction = providerOperationName(operation.webSessionAction, "Wrench execution identity web-session action");
    safeInteger(operation.webSessionContractVersion, "Wrench execution identity web-session contract version", 1, 1e6);
    if (site !== catalogSurface || webSessionAction !== preview.operation)
      throw new Error("Wrench execution identity web-session route is malformed");
    return Object.freeze({
      ...common,
      schemaVersion: 4,
      transport: "web-session-api",
      webSessionContractHash: digest(operation.webSessionContractHash, "Wrench execution identity web-session contract hash")
    });
  }
  if (preview.transport === "local-cli") {
    assertExactKeys(operation, [
      ...commonKeys,
      "surface",
      "localCliAction",
      "localCliContractVersion",
      "localCliContractHash",
      "localCliTool",
      "state",
      "implementation"
    ], [], "Wrench execution identity local CLI capability");
    const catalogSurface = providerSurfaceId(adapterValue.surfaceId, "Wrench execution identity catalog surface");
    const localCliContract = parseLocalCliContractIdentity({
      surface: operation.surface,
      action: operation.localCliAction,
      version: operation.localCliContractVersion,
      hash: operation.localCliContractHash,
      tool: operation.localCliTool
    });
    if (localCliContract.surface !== catalogSurface || localCliContract.action !== preview.operation) {
      throw new Error("Wrench execution identity local CLI route is malformed");
    }
    return Object.freeze({
      ...common,
      schemaVersion: 7,
      transport: "local-cli",
      localCliContract
    });
  }
  assertExactKeys(operation, [
    ...commonKeys,
    "state",
    "reviewedTemplateContractVersion",
    "reviewedTemplateContractHash"
  ], ["instructions", "reviewedAt", "evidenceSha256", "origin"], "Wrench execution identity reviewed-template capability");
  safeInteger(operation.reviewedTemplateContractVersion, "Wrench execution identity reviewed-template contract version", 1, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    ...common,
    schemaVersion: 5,
    transport: "reviewed-template-api",
    reviewedTemplateContractHash: digest(operation.reviewedTemplateContractHash, "Wrench execution identity reviewed-template contract hash")
  });
}
function observeExecutionIdentity(request, options) {
  const preview = parseExecutionPreview(runIdentityCommand(preparedCommand(request, {
    cacheOnly: false,
    projectionIdentityOnly: false,
    preview: true,
    headed: false
  }), options, "Wrench execution identity preview"), request);
  if (preview.transport === "portable-provider-plugin") {
    return Object.freeze({
      adapter: preview.adapter,
      operation: preview.operation,
      schemaVersion: 6,
      transport: preview.transport,
      portablePluginContract: preview.portablePluginContract
    });
  }
  if (preview.transport === "browser") {
    return Object.freeze({
      adapter: preview.adapter,
      operation: preview.operation,
      schemaVersion: 2,
      transport: preview.transport
    });
  }
  return parseCatalogExecutionIdentity(runIdentityCommand(preparedCapabilitiesCommand(request), options, "Wrench execution identity catalog preflight"), request, preview);
}
function receiptExecutionIdentity(receipt) {
  const common = Object.freeze({
    adapter: receipt.adapter,
    operation: receipt.operation
  });
  if (receipt.schemaVersion === 2) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport
    });
  }
  if (receipt.schemaVersion === 3) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
      providerContractHash: receipt.providerContractHash
    });
  }
  if (receipt.schemaVersion === 4) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
      webSessionContractHash: receipt.webSessionContractHash
    });
  }
  if (receipt.schemaVersion === 5) {
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
      reviewedTemplateContractHash: receipt.reviewedTemplateContractHash
    });
  }
  if (receipt.schemaVersion === 6)
    return Object.freeze({
      ...common,
      schemaVersion: receipt.schemaVersion,
      transport: receipt.transport,
      portablePluginContract: receipt.portablePluginContract
    });
  return Object.freeze({
    ...common,
    schemaVersion: receipt.schemaVersion,
    transport: receipt.transport,
    localCliContract: receipt.localCliContract
  });
}
function executionIdentitiesMatch(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function runLiveCommand(command, options) {
  requireBunRuntime();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, command.arguments, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      ...options.signal === undefined ? {} : { signal: options.signal }
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled)
        return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout.on("data", (chunkValue) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("Wrench live response exceeds its byte bound"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunkValue) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_ERROR_BYTES)
        stderr.push(chunk);
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled)
        return;
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
      let parsed;
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
function runLiveCommandSync(command, options) {
  requireBunRuntime();
  const result = spawnSync(process.execPath, command.arguments, {
    cwd: options.cwd,
    env: options.environment,
    input: command.input,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.error !== undefined)
    throw result.error;
  const code = result.status ?? 3;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (stdout.trim().length === 0) {
    throw new Error(boundedMessage(stderr) || `Wrench live invocation exited ${String(code)}`);
  }
  if (code !== 0 && code !== 3 && code !== 5) {
    throw new Error(boundedMessage(stderr) || `Wrench live invocation exited ${String(code)}`);
  }
  return parseOutput(stdout, "Wrench live response");
}
function parseFreshness(value, options, ageMs) {
  const freshnessValue = record(value, "Wrench cache freshness");
  assertExactKeys(freshnessValue, ["state", "freshForMs"], [], "Wrench cache freshness");
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
  const freshForMs = safeInteger(options.freshForMs, "Wrench client freshness window", 0, MAX_FRESH_FOR_MS);
  return Object.freeze({
    state: ageMs <= freshForMs ? "fresh" : "stale",
    freshForMs
  });
}
function validateReadOptions(options) {
  const now = options.now ?? new Date;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("Wrench client observation time is invalid");
  }
  if (options.freshForMs !== undefined) {
    safeInteger(options.freshForMs, "Wrench client freshness window", 0, MAX_FRESH_FOR_MS);
  }
  return now;
}
function parseCacheResult(value, options, now) {
  if (value.source !== "cache")
    throw new Error("Wrench cache response has the wrong source");
  const projection = record(value.projection, "Wrench cache projection");
  if (value.status === "cache-miss") {
    assertExactKeys(value, ["ok", "source", "status", "projection"], [], "Wrench cache miss");
    assertExactKeys(projection, ["key"], [], "Wrench cache miss projection");
    if (value.ok !== false)
      throw new Error("Wrench cache miss has the wrong success state");
    const key2 = digest(projection.key, "Wrench cache key");
    return Object.freeze({ status: "miss", key: key2 });
  }
  if (value.status !== "cached" || value.ok !== true || !("output" in value)) {
    throw new Error("Wrench cache response has an unsupported outcome");
  }
  assertExactKeys(value, ["ok", "source", "status", "projection", "output"], [], "Wrench cache response");
  assertExactKeys(projection, [
    "key",
    "dataRevision",
    "createdAt",
    "dataChangedAt",
    "validatedAt",
    "runId",
    "ageMs",
    "freshness"
  ], [], "Wrench cache projection");
  const key = digest(projection.key, "Wrench cache key");
  const validatedAt = timestamp(projection.validatedAt, "Wrench cache validation time");
  const childAgeMs = safeInteger(projection.ageMs, "Wrench cache age", 0, Number.MAX_SAFE_INTEGER);
  const ageMs = options.now === undefined ? childAgeMs : Math.max(0, now.getTime() - new Date(validatedAt).getTime());
  return Object.freeze({
    status: "hit",
    source: "cache",
    key,
    output: value.output,
    dataRevision: digest(projection.dataRevision, "Wrench cache data revision"),
    createdAt: timestamp(projection.createdAt, "Wrench cache creation time"),
    dataChangedAt: timestamp(projection.dataChangedAt, "Wrench cache data-change time"),
    validatedAt,
    runId: safeString(projection.runId, "Wrench cache run ID", 64),
    ageMs,
    freshness: parseFreshness(projection.freshness, options, ageMs)
  });
}
function parsePublication(value) {
  const publication = record(value, "Wrench cache publication");
  assertExactKeys(publication, ["key", "dataRevision", "validatedAt", "dataChangedAt", "disposition"], ["currentDataRevision"], "Wrench cache publication");
  const disposition = publication.disposition;
  if (disposition !== "created" && disposition !== "changed" && disposition !== "unchanged" && disposition !== "superseded")
    throw new Error("Wrench cache publication disposition is malformed");
  if (disposition === "superseded" !== Object.hasOwn(publication, "currentDataRevision"))
    throw new Error("Wrench cache publication current revision is malformed");
  return Object.freeze({
    key: digest(publication.key, "Wrench cache publication key"),
    dataRevision: digest(publication.dataRevision, "Wrench cache publication data revision"),
    validatedAt: timestamp(publication.validatedAt, "Wrench cache publication validation time"),
    dataChangedAt: timestamp(publication.dataChangedAt, "Wrench cache publication data-change time"),
    disposition,
    ...publication.currentDataRevision === undefined ? {} : {
      currentDataRevision: digest(publication.currentDataRevision, "Wrench current cache data revision")
    }
  });
}
function parseCacheOutcome(value) {
  const outcome = record(value, "Wrench cache outcome");
  if (outcome.status === "stored") {
    assertExactKeys(outcome, ["status", "publication"], [], "Wrench cache outcome");
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
  if (outcome.status === "skipped" && outcome.reason === "auth-subject-unbound") {
    assertExactKeys(outcome, ["status", "reason"], [], "Wrench cache outcome");
    return Object.freeze({ status: "skipped", reason: outcome.reason });
  }
  if (outcome.status === "error") {
    assertExactKeys(outcome, ["status", "message"], [], "Wrench cache outcome");
    return Object.freeze({ status: "error", message: safeString(outcome.message, "Wrench cache error", MAX_ERROR_BYTES) });
  }
  throw new Error("Wrench cache outcome is malformed");
}
function parseReceiptStatus(value) {
  if (value !== "succeeded" && value !== "failed") {
    throw new Error("Wrench live receipt status is malformed");
  }
  return value;
}
function parsePortableOperationIdentity(value) {
  return parsePortableOperationIdentityV1(value);
}
function parseLocalCliToolIdentity(value) {
  const strictRecord = (candidate, label) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) || nodeTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)
      throw new Error(`${label} is malformed`);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      throw new Error(`${label} is malformed`);
    }
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${label} is malformed`);
      }
      result[key] = descriptor.value;
    }
    return result;
  };
  const strictArray = (candidate, label) => {
    if (!Array.isArray(candidate) || nodeTypes.isProxy(candidate) || Object.getPrototypeOf(candidate) !== Array.prototype || candidate.length > 16)
      throw new Error(`${label} is malformed`);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") || Object.keys(descriptors).length !== candidate.length + 1)
      throw new Error(`${label} is malformed`);
    return Object.freeze(Array.from({ length: candidate.length }, (_unused, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`${label} is malformed`);
      }
      return descriptor.value;
    }));
  };
  const exactHttpsUrl = (candidate, label) => {
    const source = safeString(candidate, label, 2000);
    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      throw new Error(`${label} is malformed`);
    }
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.search !== "" || parsed.href !== source)
      throw new Error(`${label} is malformed`);
    return source;
  };
  const wellFormedVisible = (candidate) => {
    for (let index = 0;index < candidate.length; index += 1) {
      const code = candidate.charCodeAt(index);
      if (code <= 31 || code >= 127 && code <= 159)
        return false;
      if (code >= 55296 && code <= 56319) {
        if (index + 1 >= candidate.length)
          return false;
        const next = candidate.charCodeAt(index + 1);
        if (next < 56320 || next > 57343)
          return false;
        index += 1;
      } else if (code >= 56320 && code <= 57343) {
        return false;
      }
    }
    return true;
  };
  const token = (candidate, label) => {
    const parsed = safeString(candidate, label, 64);
    if (!/^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/u.test(parsed)) {
      throw new Error(`${label} is malformed`);
    }
    return parsed;
  };
  const tool = strictRecord(value, "Wrench local CLI tool identity");
  assertExactKeys(tool, [
    "schemaVersion",
    "id",
    "implementation",
    "versionScheme",
    "version",
    "artifacts"
  ], [
    "sourceUrl",
    "releaseCommit",
    "releaseManifestSha256",
    "releaseManifestUrl"
  ], "Wrench local CLI tool identity");
  const artifactValues = strictArray(tool.artifacts, "Wrench local CLI tool artifact table");
  if (tool.schemaVersion !== 1) {
    throw new Error("Wrench local CLI tool identity is malformed");
  }
  if (artifactValues.length < 1) {
    throw new Error("Wrench local CLI tool artifact table is malformed");
  }
  const artifacts = artifactValues.map((artifactValue, index) => {
    const artifact = strictRecord(artifactValue, `Wrench local CLI tool artifact ${index}`);
    assertExactKeys(artifact, ["platform", "arch", "executableSha256"], ["archiveSha256", "downloadUrl"], `Wrench local CLI tool artifact ${index}`);
    const archiveSha256 = artifact.archiveSha256 === undefined ? undefined : digest(artifact.archiveSha256, `Wrench local CLI tool artifact ${index} archive hash`);
    const downloadUrl = artifact.downloadUrl === undefined ? undefined : exactHttpsUrl(artifact.downloadUrl, `Wrench local CLI tool artifact ${index} download URL`);
    if (archiveSha256 === undefined !== (downloadUrl === undefined)) {
      throw new Error("Wrench local CLI tool artifact archive provenance is malformed");
    }
    return Object.freeze({
      platform: token(artifact.platform, `Wrench local CLI tool artifact ${index} platform`),
      arch: token(artifact.arch, `Wrench local CLI tool artifact ${index} architecture`),
      executableSha256: digest(artifact.executableSha256, `Wrench local CLI tool artifact ${index} executable hash`),
      ...archiveSha256 === undefined ? {} : { archiveSha256 },
      ...downloadUrl === undefined ? {} : { downloadUrl }
    });
  });
  const coordinates = artifacts.map((artifact) => `${artifact.platform}\x00${artifact.arch}`);
  if (new Set(coordinates).size !== coordinates.length || coordinates.some((coordinate, index) => index > 0 && coordinates[index - 1] >= coordinate))
    throw new Error("Wrench local CLI tool artifact table is not canonical");
  const sourceUrl = tool.sourceUrl === undefined ? undefined : exactHttpsUrl(tool.sourceUrl, "Wrench local CLI tool source URL");
  const releaseManifestSha256 = tool.releaseManifestSha256 === undefined ? undefined : digest(tool.releaseManifestSha256, "Wrench local CLI tool release manifest hash");
  const releaseManifestUrl = tool.releaseManifestUrl === undefined ? undefined : exactHttpsUrl(tool.releaseManifestUrl, "Wrench local CLI tool release manifest URL");
  if (releaseManifestSha256 === undefined !== (releaseManifestUrl === undefined))
    throw new Error("Wrench local CLI tool release manifest provenance is malformed");
  if (tool.versionScheme !== "semver" && tool.versionScheme !== "opaque") {
    throw new Error("Wrench local CLI tool version scheme is malformed");
  }
  if (typeof tool.version !== "string" || tool.version.length < 1 || tool.version.length > 128)
    throw new Error("Wrench local CLI tool version is malformed");
  const version = tool.version;
  if (!wellFormedVisible(version) || tool.versionScheme === "semver" && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
    throw new Error("Wrench local CLI tool version is malformed");
  }
  const hasReleaseCommit = tool.releaseCommit !== undefined;
  const releaseCommit = hasReleaseCommit ? safeString(tool.releaseCommit, "Wrench local CLI tool release commit", 40) : undefined;
  if (releaseCommit !== undefined && !/^[a-f0-9]{40}$/u.test(releaseCommit))
    throw new Error("Wrench local CLI tool release commit is malformed");
  const implementation = safeString(tool.implementation, "Wrench local CLI tool implementation", 256);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._/+:-]{0,254}[A-Za-z0-9])?$/u.test(implementation)) {
    throw new Error("Wrench local CLI tool implementation is malformed");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: token(tool.id, "Wrench local CLI tool ID"),
    implementation,
    versionScheme: tool.versionScheme,
    version,
    ...releaseCommit === undefined ? {} : { releaseCommit },
    ...releaseManifestSha256 === undefined ? {} : { releaseManifestSha256, releaseManifestUrl },
    ...sourceUrl === undefined ? {} : { sourceUrl },
    artifacts: Object.freeze(artifacts)
  });
}
function parseLocalCliContractIdentity(value) {
  const identity = record(value, "Wrench local CLI contract identity");
  assertExactKeys(identity, ["surface", "action", "version", "hash", "tool"], [], "Wrench local CLI contract identity");
  const surface = providerSurfaceId(identity.surface, "Wrench local CLI surface");
  const action = providerOperationName(identity.action, "Wrench local CLI action");
  return Object.freeze({
    surface,
    action,
    version: safeInteger(identity.version, "Wrench local CLI contract version", 1, 1e6),
    hash: digest(identity.hash, "Wrench local CLI contract hash"),
    tool: parseLocalCliToolIdentity(identity.tool)
  });
}
function parseLiveReceipt(value, request, expectedInputHash) {
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
    "error"
  ];
  if (receipt.schemaVersion === 2 && receipt.transport === "browser") {
    assertExactKeys(receipt, commonKeys, [], "Wrench live receipt");
  } else if (receipt.schemaVersion === 3 && receipt.transport === "provider-api") {
    assertExactKeys(receipt, [...commonKeys, "providerContractHash"], [], "Wrench live receipt");
  } else if (receipt.schemaVersion === 4 && receipt.transport === "web-session-api") {
    assertExactKeys(receipt, [...commonKeys, "webSessionContractHash"], [], "Wrench live receipt");
  } else if (receipt.schemaVersion === 5 && receipt.transport === "reviewed-template-api") {
    assertExactKeys(receipt, [...commonKeys, "reviewedTemplateContractHash"], [], "Wrench live receipt");
  } else if (receipt.schemaVersion === 6 && receipt.transport === "portable-provider-plugin") {
    assertExactKeys(receipt, [...commonKeys, "portablePluginContract"], [], "Wrench live receipt");
  } else if (receipt.schemaVersion === 7 && receipt.transport === "local-cli") {
    assertExactKeys(receipt, [...commonKeys, "localCliContract"], [], "Wrench live receipt");
  } else {
    throw new Error("Wrench live receipt schema and transport are malformed");
  }
  const adapter = record(receipt.adapter, "Wrench live receipt adapter");
  const auth = record(receipt.auth, "Wrench live receipt auth");
  const dispatch = record(receipt.dispatch, "Wrench live receipt dispatch");
  assertExactKeys(adapter, ["id", "version", "hash"], [], "Wrench live receipt adapter");
  assertExactKeys(auth, ["id", "hash", "kind"], [], "Wrench live receipt auth");
  assertExactKeys(dispatch, ["planned", "started", "verified"], [], "Wrench live receipt dispatch");
  if (receipt.risk !== "R1") {
    throw new Error("Wrench live receipt risk is malformed");
  }
  const authKind = auth.kind;
  if (authKind !== "browser-profile" && authKind !== "cookie-source" && authKind !== "cookies-file" && authKind !== "linked-device-store" && authKind !== "oauth-token-file" && authKind !== PUBLIC_WEB_SESSION_AUTHORITY_KIND)
    throw new Error("Wrench live receipt auth kind is malformed");
  if (receipt.dispatchStarted !== false) {
    throw new Error("Wrench live receipt dispatch state is malformed");
  }
  const planned = safeInteger(dispatch.planned, "Wrench live receipt planned dispatch count", 0, Number.MAX_SAFE_INTEGER);
  const started = safeInteger(dispatch.started, "Wrench live receipt started dispatch count", 0, Number.MAX_SAFE_INTEGER);
  const verified = safeInteger(dispatch.verified, "Wrench live receipt verified dispatch count", 0, Number.MAX_SAFE_INTEGER);
  if (planned !== 0 || started !== 0 || verified !== 0) {
    throw new Error("Wrench live receipt dispatch counts are inconsistent");
  }
  const status = parseReceiptStatus(receipt.status);
  const finalOrigin = receipt.finalOrigin === null ? null : safeString(receipt.finalOrigin, "Wrench live receipt final origin", 4096);
  const error = receipt.error === null ? null : boundedUtf8String(receipt.error, "Wrench live receipt error", MAX_RUN_RECEIPT_ERROR_BYTES);
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
      hash: digest(adapter.hash, "Wrench live receipt adapter hash")
    }),
    operation: providerOperationName(receipt.operation, "Wrench live receipt operation"),
    risk: "R1",
    inputHash: digest(receipt.inputHash, "Wrench live receipt input hash"),
    auth: Object.freeze({
      id: safeString(auth.id, "Wrench live receipt auth ID", 64),
      hash: digest(auth.hash, "Wrench live receipt auth hash"),
      kind: authKind
    }),
    status,
    dispatchStarted: false,
    dispatch: Object.freeze({
      planned: 0,
      started: 0,
      verified: 0
    }),
    startedAt,
    finishedAt,
    finalOrigin,
    error
  });
  if (common.adapter.id !== request.adapterId || common.operation !== request.operationId)
    throw new Error("Wrench live receipt route does not match its request");
  if (common.auth.id !== expectedRequestAuthId(request, common.auth.kind)) {
    throw new Error("Wrench live receipt auth does not match its request");
  }
  if (common.auth.kind === PUBLIC_WEB_SESSION_AUTHORITY_KIND) {
    const authority = publicWebSessionAuthority(request);
    if (receipt.schemaVersion !== 4 || receipt.transport !== "web-session-api" || common.auth.hash !== sha256(canonicalJson(authority))) {
      throw new Error("Wrench live receipt public authority is malformed");
    }
  }
  if (common.inputHash !== expectedInputHash) {
    throw new Error("Wrench live receipt input does not match its request");
  }
  if (receipt.schemaVersion === 2 && receipt.transport === "browser") {
    return Object.freeze({ ...common, schemaVersion: 2, transport: "browser" });
  }
  if (receipt.schemaVersion === 3 && receipt.transport === "provider-api") {
    return Object.freeze({
      ...common,
      schemaVersion: 3,
      transport: "provider-api",
      providerContractHash: digest(receipt.providerContractHash, "Wrench live receipt provider contract hash")
    });
  }
  if (receipt.schemaVersion === 4 && receipt.transport === "web-session-api") {
    return Object.freeze({
      ...common,
      schemaVersion: 4,
      transport: "web-session-api",
      webSessionContractHash: digest(receipt.webSessionContractHash, "Wrench live receipt web-session contract hash")
    });
  }
  if (receipt.schemaVersion === 5 && receipt.transport === "reviewed-template-api") {
    return Object.freeze({
      ...common,
      schemaVersion: 5,
      transport: "reviewed-template-api",
      reviewedTemplateContractHash: digest(receipt.reviewedTemplateContractHash, "Wrench live receipt reviewed-template contract hash")
    });
  }
  if (receipt.schemaVersion === 6 && receipt.transport === "portable-provider-plugin") {
    const portablePluginContract = parsePortableOperationIdentity(receipt.portablePluginContract);
    if (portablePluginContract.adapterId !== common.adapter.id || portablePluginContract.operation !== common.operation) {
      throw new Error("Wrench live portable contract route is malformed");
    }
    return Object.freeze({
      ...common,
      schemaVersion: 6,
      transport: "portable-provider-plugin",
      portablePluginContract
    });
  }
  if (receipt.schemaVersion === 7 && receipt.transport === "local-cli") {
    const localCliContract = parseLocalCliContractIdentity(receipt.localCliContract);
    if (localCliContract.action !== common.operation) {
      throw new Error("Wrench live local CLI contract route is malformed");
    }
    return Object.freeze({
      ...common,
      schemaVersion: 7,
      transport: "local-cli",
      localCliContract
    });
  }
  throw new Error("Wrench live receipt schema and transport are malformed");
}
function parseLiveResult(value, request, expectedInputHash) {
  assertExactKeys(value, ["ok", "source", "status", "runId", "replayed", "receipt", "output", "cache"], ["readFailure"], "Wrench live response");
  if (value.source !== "live")
    throw new Error("Wrench live response has the wrong source");
  const receipt = parseLiveReceipt(value.receipt, request, expectedInputHash);
  const status = safeString(value.status, "Wrench live status", 32);
  const responseRunId = safeString(value.runId, "Wrench live run ID", 64);
  const expectedOk = receipt.status === "succeeded";
  if (status !== receipt.status || receipt.runId !== responseRunId || value.ok !== expectedOk) {
    throw new Error("Wrench live response is not bound to its receipt");
  }
  if (typeof value.replayed !== "boolean" || !("output" in value)) {
    throw new Error("Wrench live response is incomplete");
  }
  const cache = parseCacheOutcome(value.cache);
  const cacheMatchesReceipt = receipt.status === "succeeded" ? cache.status === "stored" || cache.status === "error" || cache.status === "skipped" : cache.status === "retained" || cache.status === "miss" || cache.status === "error" || cache.status === "skipped";
  if (!cacheMatchesReceipt) {
    throw new Error("Wrench live cache outcome is inconsistent with its receipt");
  }
  const live = receipt.status === "failed" ? (() => {
    if (value.output !== null) {
      throw new Error("Wrench failed live response retained an output");
    }
    return Object.freeze({
      status: "failed",
      receipt,
      output: null,
      replayed: value.replayed,
      readFailure: parseClientReadFailure(value.readFailure)
    });
  })() : (() => {
    if (value.readFailure !== undefined) {
      throw new Error("Wrench successful live response included a read failure");
    }
    return Object.freeze({
      status: "succeeded",
      receipt,
      output: value.output,
      replayed: value.replayed
    });
  })();
  return Object.freeze({
    live,
    cache
  });
}
function assertLiveInvocationFences(request, options, executionIdentityBefore, identityBefore, parsed, activity) {
  const identityAfter = observeProjectionIdentity(request, options);
  if (!projectionIdentitiesMatch(identityBefore, identityAfter)) {
    throw new Error(`Wrench projection identity changed while ${activity} was running; the live result was discarded`);
  }
  if (!executionIdentitiesMatch(executionIdentityBefore, receiptExecutionIdentity(parsed.live.receipt))) {
    throw new Error(`Wrench execution identity changed while ${activity} was running; the live result was discarded`);
  }
  if (parsed.live.receipt.auth.hash !== identityBefore.authHash) {
    throw new Error(`Wrench projection identity changed while ${activity} was running; the live result was discarded`);
  }
  if (identityBefore.status === "unbound") {
    if (parsed.cache.status !== "skipped") {
      throw new Error(`Wrench projection identity changed while ${activity} was running; the live result was discarded`);
    }
    return;
  }
  if (parsed.cache.status === "skipped" || parsed.cache.status === "stored" && parsed.cache.publication.key !== identityBefore.key) {
    throw new Error(`Wrench projection identity changed while ${activity} was running; the live result was discarded`);
  }
}
function readCachedCapability(request, options = {}) {
  const preparedOptions = snapshotClientOptions(options, "read");
  const now = validateReadOptions(preparedOptions);
  const prepared = prepareRequest(request);
  return readCachedPreparedCapability(prepared, preparedOptions, now);
}
function readCachedPreparedCapability(request, options, now) {
  const command = preparedCommand(request, {
    cacheOnly: true,
    projectionIdentityOnly: false,
    headed: false
  });
  return parseCacheResult(runCacheCommand(command, options).output, options, now);
}
function selectCurrentCapability(cachedBefore, cachedAfter, parsed) {
  const before = cachedBefore?.status === "hit" ? cachedBefore : null;
  const after = cachedAfter?.status === "hit" ? cachedAfter : null;
  if (parsed.live.status === "failed")
    return after;
  if (parsed.cache.status === "stored") {
    if (after !== null)
      return after;
    if (parsed.cache.publication.disposition === "superseded")
      return null;
    return Object.freeze({ source: "live", output: parsed.live.output });
  }
  if (parsed.cache.status === "error") {
    const cacheAdvanced = after !== null && (before === null || after.runId !== before.runId || after.dataRevision !== before.dataRevision || after.validatedAt !== before.validatedAt);
    if (cacheAdvanced)
      return after;
  }
  return Object.freeze({ source: "live", output: parsed.live.output });
}
async function runRevalidation(request, options, executionIdentityBefore, identityBefore, cachedBefore, observationTime) {
  const parsed = parseLiveResult(await runLiveCommand(preparedCommand(request, {
    cacheOnly: false,
    projectionIdentityOnly: false,
    headed: options.headed ?? false
  }), options), request, identityBefore.inputHash);
  assertLiveInvocationFences(request, options, executionIdentityBefore, identityBefore, parsed, "revalidation");
  if (identityBefore.status === "unbound") {
    return Object.freeze({
      cachedBefore: null,
      cachedAfter: null,
      current: selectCurrentCapability(null, null, parsed),
      ...parsed
    });
  }
  let cachedAfter = null;
  try {
    cachedAfter = readCachedPreparedCapability(request, options, observationTime);
  } catch {}
  if (cachedBefore !== null && cachedBefore.key !== identityBefore.key || cachedAfter !== null && cachedAfter.key !== identityBefore.key) {
    throw new Error("Wrench projection identity changed while revalidation was running; the live result was discarded");
  }
  return Object.freeze({
    cachedBefore,
    cachedAfter,
    current: selectCurrentCapability(cachedBefore, cachedAfter, parsed),
    ...parsed
  });
}
function scheduleRevalidation(request, options, observationTime, cachedBeforeSource) {
  return Promise.resolve().then(() => {
    const executionIdentityBefore = observeExecutionIdentity(request, options);
    const identityBefore = observeProjectionIdentity(request, options);
    let cachedBefore = cachedBeforeSource.status === "provided" ? cachedBeforeSource.value : null;
    if (cachedBeforeSource.status === "lookup" && identityBefore.status === "ready") {
      try {
        cachedBefore = readCachedPreparedCapability(request, options, observationTime);
      } catch {}
    }
    if (cachedBefore !== null && (identityBefore.status !== "ready" || cachedBefore.key !== identityBefore.key)) {
      throw new Error("Wrench projection identity changed before revalidation started");
    }
    return runRevalidation(request, options, executionIdentityBefore, identityBefore, cachedBefore, observationTime);
  });
}
function invokeCapability(request, options = {}) {
  const preparedOptions = snapshotClientOptions(options, "invoke-async");
  const prepared = prepareRequest(request);
  return Promise.resolve().then(async () => {
    const executionIdentityBefore = observeExecutionIdentity(prepared, preparedOptions);
    const identityBefore = observeProjectionIdentity(prepared, preparedOptions);
    const parsed = parseLiveResult(await runLiveCommand(preparedCommand(prepared, {
      cacheOnly: false,
      projectionIdentityOnly: false,
      headed: preparedOptions.headed ?? false
    }), preparedOptions), prepared, identityBefore.inputHash);
    assertLiveInvocationFences(prepared, preparedOptions, executionIdentityBefore, identityBefore, parsed, "invocation");
    return parsed.live;
  });
}
function invokeCapabilitySync(request, options = {}) {
  const preparedOptions = snapshotClientOptions(options, "invoke-sync");
  const prepared = prepareRequest(request);
  const executionIdentityBefore = observeExecutionIdentity(prepared, preparedOptions);
  const identityBefore = observeProjectionIdentity(prepared, preparedOptions);
  const parsed = parseLiveResult(runLiveCommandSync(preparedCommand(prepared, {
    cacheOnly: false,
    projectionIdentityOnly: false,
    headed: preparedOptions.headed ?? false
  }), preparedOptions), prepared, identityBefore.inputHash);
  assertLiveInvocationFences(prepared, preparedOptions, executionIdentityBefore, identityBefore, parsed, "invocation");
  return parsed.live;
}
function revalidateCapability(request, options = {}) {
  const preparedOptions = snapshotClientOptions(options, "revalidation");
  const now = validateReadOptions(preparedOptions);
  const prepared = prepareRequest(request);
  return scheduleRevalidation(prepared, preparedOptions, now, { status: "lookup" });
}
function staleWhileRevalidateCapability(request, options = {}) {
  const preparedOptions = snapshotClientOptions(options, "revalidation");
  const now = validateReadOptions(preparedOptions);
  const prepared = prepareRequest(request);
  let cached = null;
  try {
    cached = readCachedPreparedCapability(prepared, preparedOptions, now);
  } catch {}
  return Object.freeze({
    cached,
    revalidation: scheduleRevalidation(prepared, preparedOptions, now, { status: "provided", value: cached })
  });
}
export {
  staleWhileRevalidateCapability,
  revalidateCapability,
  readCachedCapability,
  invokeCapabilitySync,
  invokeCapability
};
