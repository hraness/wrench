import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";

import {
  PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION,
  PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginBindingV1,
  type PortableProviderPluginOperationV1,
  type PortableProviderPluginSessionMaterialName,
  type VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  announcePortableProviderPluginHostStarted,
  announcePortableProviderPluginHostStarting,
  registerPortableProviderPluginCleanupBarrier,
  type PortableProviderPluginCleanupBarrier,
} from "./provider-plugin-cleanup-barrier";
import {
  captureProcessOwnerIdentity,
  processOwnerStatus,
  type ProcessOwnerIdentity,
} from "./process-identity";
import {
  validateOperationInput,
  type FileInputField,
} from "./model";
import {
  encodePortableProviderPluginMessage,
  parsePortableProviderPluginMessage,
  PortableProviderPluginFrameDecoder,
  PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
  type PortablePluginCapabilityRequest,
  type PortablePluginCapabilityResult,
  type PortablePluginInvocationAuth,
  type PortablePluginInvocationFile,
  type PortablePluginJsonObject,
  type PortablePluginJsonValue,
  type PortablePluginRoute,
  type PortableProviderPluginHostMessage,
  type PortableProviderPluginMessage,
  type PortableProviderPluginProcessMessage,
} from "./provider-plugin-protocol";

const MAX_HOST_MESSAGES = 256;
const MAX_HOST_STDERR_BYTES = 64 * 1024;
const MAX_HOST_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_HOST_STDIN_BYTES = 8 * 1024 * 1024;
const MIN_INVOCATION_TIMEOUT_MS = 100;
const MAX_INVOCATION_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 250;
const TERMINATION_CONFIRMATION_MS = 2_000;
const TERMINATION_STREAM_CLOSE_MS = 250;
const RUNTIME_CHILD_FD = 3;
const EMPTY_HOST_CONFIG_PATH = "/dev/null";
const HOST_GUARD_NAME = ".wrench-portable-host-guard.mjs";
const MAX_CONTAINED_DESCENDANTS = 256;
const HOST_GUARD_SOURCE = `
import childProcess from "node:child_process";
import cluster from "node:cluster";
import { syncBuiltinESMExports } from "node:module";
import workerThreads from "node:worker_threads";

const unavailable = () => {
  throw new Error("portable plugin subprocess creation is unavailable");
};
for (const name of ["$", "openInEditor", "spawn", "spawnSync"]) {
  Object.defineProperty(Bun, name, {
    value: unavailable,
    writable: false,
    configurable: false,
  });
}
for (const name of ["dlopen", "linkSymbols"]) {
  if (typeof Bun.FFI?.[name] !== "function") continue;
  Object.defineProperty(Bun.FFI, name, {
    value: unavailable,
    writable: false,
    configurable: false,
  });
}
const ChildProcess = childProcess.ChildProcess;
Object.defineProperty(ChildProcess.prototype, "spawn", {
  value: unavailable,
  writable: false,
  configurable: false,
});
for (
  const [module, names] of [
    [
      childProcess,
      [
        "exec",
        "execFile",
        "execFileSync",
        "execSync",
        "fork",
        "spawn",
        "spawnSync",
      ],
    ],
    [
      cluster,
      ["disconnect", "fork", "setupMaster", "setupPrimary"],
    ],
    [workerThreads, ["Worker"]],
  ]
) {
  for (const name of names) {
    if (typeof module[name] !== "function") continue;
    Object.defineProperty(module, name, {
      value: unavailable,
      writable: false,
      configurable: false,
    });
  }
}
if (typeof globalThis.Worker === "function") {
  Object.defineProperty(globalThis, "Worker", {
    value: unavailable,
    writable: false,
    configurable: false,
  });
}
syncBuiltinESMExports();
for (
  const name of [
    "_kill",
    "_linkedBinding",
    "binding",
    "dlopen",
    "execve",
    "getBuiltinModule",
    "kill",
  ]
) {
  if (typeof process[name] !== "function") continue;
  Object.defineProperty(process, name, {
    value: unavailable,
    writable: false,
    configurable: false,
  });
}

const admission = process.stdin;
await new Promise((resolve) => {
  let admitted = false;
  const stop = () => process.exit(125);
  const onData = (chunk) => {
    if (
      admitted
      || !(chunk instanceof Uint8Array)
      || chunk.byteLength < 1
      || chunk[0] !== 1
    ) stop();
    admitted = true;
    admission.removeListener("error", stop);
    admission.removeListener("end", stop);
    admission.removeListener("data", onData);
    if (chunk.byteLength > 1) admission.unshift(chunk.subarray(1));
    admission.pause();
    resolve();
  };
  admission.once("error", stop);
  admission.once("end", stop);
  admission.once("data", onData);
  admission.resume();
});
`.trimStart();

const PORTABLE_RUNTIME_PROCESS_MODULES = new Set([
  "bun",
  "bun:ffi",
  "child_process",
  "cluster",
  "node:child_process",
  "node:cluster",
  "node:worker_threads",
  "worker_threads",
]);

type ProcessMessage = PortableProviderPluginProcessMessage;

export type PortableProviderPluginHostProcessObserverForTest = {
  readonly staged?: (stage: { readonly cwd: string }) => void;
  readonly beforeSpawn?: (command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }) => void;
  readonly beforeParentDescriptorRelease?: () => void;
  readonly descendantProcessIds?: (
    host: ProcessOwnerIdentity,
  ) => readonly number[];
  readonly exit?: (result: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => void;
};

let hostProcessObserverForTest:
  PortableProviderPluginHostProcessObserverForTest | undefined;

export function observePortableProviderPluginHostProcessForTest(
  observer: PortableProviderPluginHostProcessObserverForTest,
): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("portable plugin host observation is available only in tests");
  }
  if (hostProcessObserverForTest !== undefined) {
    throw new Error("portable plugin host observation is already active");
  }
  hostProcessObserverForTest = observer;
  return () => {
    if (hostProcessObserverForTest === observer) {
      hostProcessObserverForTest = undefined;
    }
  };
}

export type PortableProviderPluginCapabilityContext = {
  readonly invocationId: string;
  readonly requestId: string;
  readonly route: PortablePluginRoute;
  /** One total invocation deadline; capability implementations must obey it. */
  readonly signal: AbortSignal;
};

export type PortableProviderPluginCapabilityHost = {
  /**
   * Exercise one host-owned capability. The host calls this only after the
   * request passes the installed manifest and invocation policy.
   *
   * Throwing is converted to a value-free capability error. Exception text is
   * never returned to plugin code or included in the public host diagnostic.
   */
  readonly handle: (
    request: PortablePluginCapabilityRequest,
    context: PortableProviderPluginCapabilityContext,
  ) => Promise<PortablePluginCapabilityResult>;
};

export type PortableProviderPluginHostInvocation = {
  readonly package: VerifiedPortableProviderPluginPackage;
  readonly route: PortablePluginRoute;
  readonly input: PortablePluginJsonObject;
  readonly auth: PortablePluginInvocationAuth;
  readonly files: readonly PortablePluginInvocationFile[];
  readonly timeoutMs: number;
  readonly hostVersion: string;
  readonly plannedDispatchIds?: readonly string[];
  readonly capabilityHost?: PortableProviderPluginCapabilityHost;
  readonly signal?: AbortSignal;
  /** Test-only executable seam. Production callers leave this unset. */
  readonly bunExecutable?: string;
};

export type PortableProviderPluginHostResult = {
  readonly output: PortablePluginJsonValue;
  readonly finalUrl: string | null;
  readonly dispatch: {
    readonly planned: number;
    readonly started: number;
    readonly verified: number;
  };
};

export class PortableProviderPluginHostError extends Error {
  readonly code: string;
  readonly dispatch: PortableProviderPluginHostResult["dispatch"];

  constructor(
    code: string,
    message: string,
    dispatch: PortableProviderPluginHostResult["dispatch"],
  ) {
    super(message);
    this.name = "PortableProviderPluginHostError";
    this.code = code;
    this.dispatch = Object.freeze({ ...dispatch });
  }
}

type PendingMessage = {
  readonly resolve: (value: ProcessMessage) => void;
  readonly reject: (error: Error) => void;
};

class ProcessMessageQueue {
  readonly #messages: ProcessMessage[] = [];
  readonly #pending: PendingMessage[] = [];
  #failure: Error | null = null;

  push(message: ProcessMessage): void {
    if (this.#failure !== null) return;
    const pending = this.#pending.shift();
    if (pending === undefined) {
      this.#messages.push(message);
      return;
    }
    pending.resolve(message);
  }

  fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    for (const pending of this.#pending.splice(0)) pending.reject(error);
  }

  next(): Promise<ProcessMessage> {
    const message = this.#messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.#failure !== null) return Promise.reject(this.#failure);
    return new Promise<ProcessMessage>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
    });
  }
}

function isProcessMessage(
  message: PortableProviderPluginMessage,
): message is ProcessMessage {
  return message.kind.startsWith("plugin.");
}

function operationOwnsRoute(
  packageValue: VerifiedPortableProviderPluginPackage,
  route: PortablePluginRoute,
): boolean {
  const binding = packageValue.manifest.bindings.find((candidate) =>
    candidate.transport === route.transport
    && candidate.surfaceId === route.surfaceId);
  if (binding === undefined) return false;
  return binding.operations.some((operation) =>
    operation.name === route.operation
    && operation.contractVersion === route.contractVersion);
}

function routeBinding(
  packageValue: VerifiedPortableProviderPluginPackage,
  route: PortablePluginRoute,
): VerifiedPortableProviderPluginPackage["manifest"]["bindings"][number] {
  const binding = packageValue.manifest.bindings.find((candidate) =>
    candidate.transport === route.transport
    && candidate.surfaceId === route.surfaceId);
  if (binding === undefined || !operationOwnsRoute(packageValue, route)) {
    throw new Error("portable plugin route is not declared by the installed package");
  }
  return binding;
}

function routeOperation(
  packageValue: VerifiedPortableProviderPluginPackage,
  route: PortablePluginRoute,
): PortableProviderPluginOperationV1 {
  const binding = routeBinding(packageValue, route);
  const operation = binding.operations.find((candidate) =>
    candidate.name === route.operation
    && candidate.contractVersion === route.contractVersion);
  if (operation === undefined) {
    throw new Error("portable plugin operation is not declared by the installed package");
  }
  return operation;
}

type ExpectedInvocationFileBinding = {
  readonly input: string;
  readonly field: FileInputField;
};

function mediaTypeIsAllowed(
  mediaType: string,
  allowed: readonly string[] | undefined,
): boolean {
  if (allowed === undefined) return true;
  const essence = mediaType.split(";", 1)[0]?.toLowerCase();
  if (essence === undefined) return false;
  return allowed.some((candidate) =>
    candidate === essence
    || (
      candidate.endsWith("/*")
      && essence.startsWith(candidate.slice(0, -1))
    ));
}

function assertInvocationFileBindings(
  operation: PortableProviderPluginOperationV1,
  input: PortablePluginJsonObject,
  files: readonly PortablePluginInvocationFile[],
): void {
  const expectedByHandle = new Map<string, ExpectedInvocationFileBinding>();
  const addExpected = (
    inputName: string,
    handle: PortablePluginJsonValue,
    field: FileInputField,
  ): void => {
    // validateOperationInput has already established this value as an opaque
    // file-reference string. Keep this guard local so the binding invariant
    // cannot silently depend on a future parser representation.
    if (typeof handle !== "string") {
      throw new Error("portable plugin invocation file input is invalid");
    }
    if (expectedByHandle.has(handle)) {
      throw new Error(
        "portable plugin invocation repeats a file handle in its operation input",
      );
    }
    expectedByHandle.set(handle, { input: inputName, field });
  };

  for (const [inputName, field] of Object.entries(
    operation.input.properties,
  )) {
    const value = input[inputName];
    if (value === undefined) continue;
    if (field.type === "file") {
      addExpected(inputName, value, field);
      continue;
    }
    if (field.type !== "array" || field.items.type !== "file") continue;
    if (!Array.isArray(value)) {
      throw new Error("portable plugin invocation file array input is invalid");
    }
    for (const handle of value as readonly PortablePluginJsonValue[]) {
      addExpected(inputName, handle, field.items);
    }
  }

  const seenHandles = new Set<string>();
  for (const file of files) {
    if (seenHandles.has(file.handle)) {
      throw new Error("portable plugin invocation repeats a file handle");
    }
    seenHandles.add(file.handle);
    const expected = expectedByHandle.get(file.handle);
    if (expected === undefined) {
      throw new Error(
        "portable plugin invocation includes a file that is not referenced by its operation input",
      );
    }
    if (file.input !== expected.input) {
      throw new Error(
        "portable plugin invocation file does not match its operation input name",
      );
    }
    if (
      !Number.isSafeInteger(file.bytes)
      || file.bytes < 1
      || file.bytes > expected.field.maxBytes
    ) {
      throw new Error(
        "portable plugin invocation file exceeds its operation input byte bound",
      );
    }
    if (!mediaTypeIsAllowed(file.mediaType, expected.field.mediaTypes)) {
      throw new Error(
        "portable plugin invocation file media type is not allowed by its operation input",
      );
    }
  }
  if (seenHandles.size !== expectedByHandle.size) {
    throw new Error(
      "portable plugin invocation omits a file referenced by its operation input",
    );
  }
}

function assertInvocation(
  invocation: PortableProviderPluginHostInvocation,
  verified: VerifiedPortableProviderPluginPackage,
): void {
  if (
    verified.bundleSha256 !== invocation.package.bundleSha256
    || verified.manifestSha256 !== invocation.package.manifestSha256
    || verified.manifest.id !== invocation.package.manifest.id
    || verified.manifest.version !== invocation.package.manifest.version
  ) {
    throw new Error("portable plugin package changed after its verified snapshot");
  }
  if (
    !Number.isSafeInteger(invocation.timeoutMs)
    || invocation.timeoutMs < MIN_INVOCATION_TIMEOUT_MS
    || invocation.timeoutMs > MAX_INVOCATION_TIMEOUT_MS
  ) {
    throw new Error("portable plugin invocation timeout is outside host bounds");
  }
  if (
    typeof invocation.hostVersion !== "string"
    || invocation.hostVersion.length < 1
    || invocation.hostVersion.length > 128
    || /[\0\r\n]/u.test(invocation.hostVersion)
  ) {
    throw new Error("portable plugin host version is invalid");
  }
  const binding = routeBinding(verified, invocation.route);
  const operation = routeOperation(verified, invocation.route);
  if (operation.state !== "observed") {
    throw new Error("capture-required portable plugin operations are not executable");
  }
  const parsedInput = validateOperationInput(
    operation.input,
    invocation.input,
    [binding.origin],
  );
  if (!parsedInput.ok) {
    throw new Error(
      `portable plugin invocation input is invalid: ${parsedInput.issues.join("; ")}`,
    );
  }
  if (!binding.authKinds.includes(invocation.auth.kind)) {
    throw new Error("portable plugin invocation auth kind is not declared");
  }
  assertInvocationFileBindings(operation, invocation.input, invocation.files);
  const planned = invocation.plannedDispatchIds ?? [];
  if (
    planned.length > 25
    || new Set(planned).size !== planned.length
    || planned.some((id) =>
      !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*(?:\[[1-9][0-9]*\])?$/u
        .test(id))
  ) {
    throw new Error("portable plugin invocation dispatch plan is invalid");
  }
  if (
    (operation.dispatch === "none" && planned.length !== 0)
    || (operation.dispatch === "single" && planned.length !== 1)
  ) {
    throw new Error(
      "portable plugin invocation dispatch plan does not match its static operation descriptor",
    );
  }
}

function exactOrigin(urlValue: string): string | null {
  try {
    const url = new URL(urlValue);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

type InvocationPolicyState = {
  readonly requestIds: Set<string>;
  readonly filesByHandle: ReadonlyMap<string, PortablePluginInvocationFile>;
  readonly materialHandles: Map<
    string,
    PortableProviderPluginSessionMaterialName
  >;
  readonly dispatchHandles: Map<string, {
    readonly dispatchId: string;
    verified: boolean;
    mutationAttempted: boolean;
    mutationCompleted: boolean;
  }>;
  started: number;
  verified: number;
};

function capabilityIsDeclared(
  request: PortablePluginCapabilityRequest,
  granted:
    VerifiedPortableProviderPluginPackage["manifest"]["capabilities"],
  binding: PortableProviderPluginBindingV1,
  auth: PortablePluginInvocationAuth,
  plannedDispatchIds: readonly string[],
  state: InvocationPolicyState,
): boolean {
  if (request.kind === "log.write") return true;
  if (request.kind === "dispatch.begin") {
    return (
      plannedDispatchIds[state.started] === request.dispatchId
    );
  }
  if (request.kind === "dispatch.verify") {
    const dispatch = state.dispatchHandles.get(request.dispatchHandle);
    return dispatch !== undefined
      && !dispatch.verified
      && dispatch.mutationCompleted;
  }
  if (request.kind === "http.request") {
    const origin = exactOrigin(request.url);
    if (
      origin === null
      || origin !== binding.origin
      || !granted.networkOrigins.includes(origin)
    ) return false;
    for (const credential of request.credentials) {
      const material = state.materialHandles.get(credential.handle);
      if (
        material === undefined
        || (
          material === "cookie-jar"
            ? credential.sink.kind !== "cookie-jar"
            : credential.sink.kind !== "header"
              || credential.sink.name !== "authorization"
        )
      ) return false;
    }
    const mutating = request.method !== "GET" && request.method !== "HEAD";
    if (!mutating) return request.dispatchHandle === undefined;
    if (request.dispatchHandle === undefined) return false;
    const dispatch = state.dispatchHandles.get(request.dispatchHandle);
    return dispatch !== undefined
      && !dispatch.verified
      && !dispatch.mutationAttempted;
  }
  if (request.kind === "file.read") {
    return (
      granted.planFiles === "read"
      && state.filesByHandle.has(request.handle)
    );
  }
  if (
    request.kind === "state.read"
    || request.kind === "state.write"
    || request.kind === "state.delete"
  ) {
    return granted.state === "namespaced";
  }
  return (
    request.kind === "session.acquire"
    && granted.sessionMaterial.includes(request.name)
    && (
      request.name === "oauth-access-token"
        ? binding.transport === "provider-api"
          && auth.kind === "oauth-token-file"
        : binding.transport === "web-session-api"
          && (
            auth.kind === "cookie-source"
            || auth.kind === "cookies-file"
            || auth.kind === "browser-profile"
          )
    )
  );
}

function matchingCapabilityResult(
  request: PortablePluginCapabilityRequest,
  result: PortablePluginCapabilityResult,
  filesByHandle: ReadonlyMap<string, PortablePluginInvocationFile>,
): boolean {
  if (request.kind !== result.kind) return false;
  if (request.kind === "http.request" && result.kind === "http.request") {
    const bodyBytes = result.body.kind === "utf8"
      ? Buffer.byteLength(result.body.text, "utf8")
      : Buffer.byteLength(result.body.data, "base64");
    return bodyBytes <= request.maxOutputBytes
      && result.finalUrl === request.url;
  }
  if (request.kind === "file.read" && result.kind === "file.read") {
    const descriptor = filesByHandle.get(request.handle);
    if (descriptor === undefined) return false;
    const bytes = Buffer.byteLength(result.data, "base64");
    const remaining = Math.max(0, descriptor.bytes - request.offset);
    const maximum = Math.min(request.length, remaining);
    if (bytes > maximum || (bytes === 0 && remaining > 0)) return false;
    const reachedDeclaredEnd = request.offset >= descriptor.bytes
      || request.offset + bytes === descriptor.bytes;
    return result.eof === reachedDeclaredEnd;
  }
  if (request.kind === "state.read" && result.kind === "state.read") {
    return ("version" in result) === (request.includeVersion === true);
  }
  if (request.kind === "state.write" && result.kind === "state.write") {
    return ("version" in result) === (request.expectedVersion !== undefined);
  }
  return true;
}

function normalizedCapabilityResult(
  invocationId: string,
  requestId: string,
  result: PortablePluginCapabilityResult,
): PortablePluginCapabilityResult {
  const parsed = parsePortableProviderPluginMessage({
    protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
    kind: "host.capability.result",
    invocationId,
    requestId,
    result,
  });
  if (!parsed.ok || parsed.value.kind !== "host.capability.result") {
    throw new Error("portable plugin capability host returned an invalid result");
  }
  return parsed.value.result;
}

function hostMessage(
  value: PortableProviderPluginHostMessage,
): PortableProviderPluginHostMessage {
  return value;
}

async function writeHostMessage(
  child: ChildProcessWithoutNullStreams,
  message: PortableProviderPluginHostMessage,
  signal: AbortSignal,
  written: { bytes: number },
): Promise<void> {
  if (!child.stdin.writable) {
    throw new Error("portable plugin stdin closed before host response");
  }
  const frame = encodePortableProviderPluginMessage(message);
  written.bytes += Buffer.byteLength(frame, "utf8");
  if (written.bytes > MAX_HOST_STDIN_BYTES) {
    throw new Error("portable plugin host exceeded its outbound byte bound");
  }
  if (child.stdin.write(frame, "utf8")) return;
  if (signal.aborted) {
    throw new Error("portable plugin invocation was cancelled");
  }
  let rejectAbort: ((error: Error) => void) | null = null;
  const onAbort = (): void => {
    rejectAbort?.(new Error("portable plugin invocation was cancelled"));
  };
  try {
    await Promise.race([
      once(child.stdin, "drain").then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    rejectAbort = null;
    signal.removeEventListener("abort", onAbort);
  }
}

function valueFreeError(
  code: string,
  message: string,
  planned: number,
  started: number,
  verified: number,
): PortableProviderPluginHostError {
  return new PortableProviderPluginHostError(
    code,
    message,
    { planned, started, verified },
  );
}

function asHostError(
  error: unknown,
  planned: number,
  state: Pick<InvocationPolicyState, "started" | "verified">,
): PortableProviderPluginHostError {
  if (error instanceof PortableProviderPluginHostError) return error;
  return valueFreeError(
    "host-failed",
    "portable provider plugin host failed",
    planned,
    state.started,
    state.verified,
  );
}

function hasProtocolStreams(
  child: ChildProcess,
): child is ChildProcessWithoutNullStreams {
  return (
    child.stdin !== null
    && child.stdout !== null
    && child.stderr !== null
  );
}

async function admitPortableProviderPluginHost(
  stream: Writable,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return;
      if (error !== undefined && error !== null) {
        fail("portable plugin admission pipe failed");
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new Error(message));
    };
    const onAbort = (): void => {
      fail("portable plugin admission exceeded the invocation deadline");
    };
    const onError = (): void => {
      // Retain this listener after settlement: a child pipe may report another
      // close error while process cleanup is already in progress.
      fail("portable plugin admission pipe failed");
    };
    stream.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // The guard consumes exactly the first stdin byte before the runtime starts
    // and preserves any coalesced remainder. Writing it before host.hello
    // orders admission ahead of every frame on the same durable stream.
    stream.write(Buffer.from([1]), finish);
  });
}

type StagedPortablePackage = {
  readonly cwd: string;
  readonly fd: number;
  readonly childPath: string;
  readonly guardPath: string;
  readonly releaseParentDescriptor: () => void;
  readonly dispose: () => void;
};

class UnverifiedPortablePackageStagingCleanupError extends Error {
  constructor(cause: unknown, cleanupCause: unknown) {
    super(
      "portable provider plugin staging rollback could not be verified",
      { cause: new AggregateError([cause, cleanupCause]) },
    );
    this.name = "UnverifiedPortablePackageStagingCleanupError";
  }
}

function assertNoPortableRuntimeProcessImports(
  runtimeBytes: Uint8Array,
): void {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(runtimeBytes);
  } catch (cause) {
    throw new Error("portable plugin runtime is not valid UTF-8", { cause });
  }
  let imports: readonly { readonly path: string }[];
  try {
    imports = new Bun.Transpiler({ loader: "js" }).scan(source).imports;
  } catch (cause) {
    throw new Error("portable plugin runtime could not be parsed safely", {
      cause,
    });
  }
  if (
    imports.some(({ path }) =>
      PORTABLE_RUNTIME_PROCESS_MODULES.has(path)
    )
  ) {
    throw new Error(
      "portable plugin runtime process-creation imports are unavailable",
    );
  }
}

function stageVerifiedPortablePackage(
  packageValue: VerifiedPortableProviderPluginPackage,
): StagedPortablePackage {
  if (
    process.platform === "win32"
    || !existsSync("/dev/fd")
    || !existsSync(EMPTY_HOST_CONFIG_PATH)
  ) {
    throw new Error(
      "portable provider plugin host cannot bind exact runtime bytes on this platform",
    );
  }
  const directory = mkdtempSync(
    join(tmpdir(), "wrench-portable-plugin-package-"),
  );
  const directories = new Set([directory]);
  let reader = -1;
  let descriptorState: "closed" | "open" | "unknown" = "closed";
  let stagingDescriptorUnknown = false;
  const cleanup = (): void => {
    const failures: unknown[] = [];
    if (stagingDescriptorUnknown) {
      failures.push(new Error(
        "staged portable plugin writer descriptor state is unknown",
      ));
    }
    if (descriptorState === "open") {
      try {
        closeSync(reader);
        descriptorState = "closed";
      } catch (error) {
        descriptorState = "unknown";
        failures.push(error);
      }
    } else if (descriptorState === "unknown") {
      failures.push(new Error(
        "staged portable plugin runtime descriptor state is unknown",
      ));
    }
    for (const stagedDirectory of directories) {
      try {
        chmodSync(stagedDirectory, 0o700);
      } catch {
        // The stage may not have reached directory creation or hardening.
      }
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (existsSync(directory)) {
      failures.push(new Error(
        "staged portable plugin package directory survived cleanup",
      ));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "portable provider plugin stage cleanup failed",
      );
    }
  };
  const writeFile = (relativePath: string, bytes: Uint8Array): string => {
    const segments = relativePath.split("/");
    let parent = directory;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      if (directories.has(parent)) continue;
      mkdirSync(parent, { mode: 0o700 });
      directories.add(parent);
    }
    const path = join(parent, segments.at(-1)!);
    let writer = -1;
    const closeWriter = (): void => {
      try {
        closeSync(writer);
        writer = -1;
      } catch (error) {
        writer = -2;
        stagingDescriptorUnknown = true;
        throw error;
      }
    };
    try {
      writer = openSync(
        path,
        constants.O_WRONLY
          | constants.O_CREAT
          | constants.O_EXCL
          | constants.O_NOFOLLOW,
        0o400,
      );
      let written = 0;
      while (written < bytes.byteLength) {
        written += writeSync(
          writer,
          bytes,
          written,
          bytes.byteLength - written,
        );
      }
      fsyncSync(writer);
      closeWriter();
      return path;
    } finally {
      if (writer >= 0) closeWriter();
    }
  };
  try {
    chmodSync(directory, 0o700);
    hostProcessObserverForTest?.staged?.({ cwd: directory });
    const guardPath = writeFile(
      HOST_GUARD_NAME,
      Buffer.from(HOST_GUARD_SOURCE, "utf8"),
    );
    writeFile(
      PORTABLE_PROVIDER_PLUGIN_MANIFEST_NAME,
      packageValue.manifestBytes,
    );
    let runtimePath: string | null = null;
    let runtimeBytes: Buffer | null = null;
    for (const file of packageValue.files) {
      const path = writeFile(file.path, file.bytes);
      if (file.kind === "runtime") {
        runtimePath = path;
        runtimeBytes = file.bytes;
      }
    }
    if (runtimePath === null || runtimeBytes === null) {
      throw new Error("portable provider plugin verified runtime is absent");
    }
    assertNoPortableRuntimeProcessImports(runtimeBytes);
    reader = openSync(
      runtimePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    descriptorState = "open";
    const stats = fstatSync(reader);
    if (!stats.isFile() || stats.size !== runtimeBytes.byteLength) {
      throw new Error("staged portable plugin runtime has the wrong identity");
    }
    const checked = Buffer.allocUnsafe(runtimeBytes.byteLength);
    let read = 0;
    while (read < checked.byteLength) {
      const count = readSync(
        reader,
        checked,
        read,
        checked.byteLength - read,
        read,
      );
      if (count === 0) break;
      read += count;
    }
    if (
      read !== runtimeBytes.byteLength
      || !checked.equals(runtimeBytes)
    ) {
      throw new Error("staged portable plugin runtime bytes changed");
    }
    for (const stagedDirectory of directories) {
      chmodSync(stagedDirectory, 0o500);
    }
    return {
      cwd: directory,
      fd: reader,
      childPath: `/dev/fd/${RUNTIME_CHILD_FD}`,
      guardPath,
      releaseParentDescriptor: () => {
        if (descriptorState === "closed") return;
        if (descriptorState === "unknown") {
          throw new Error(
            "staged portable plugin runtime descriptor state is unknown",
          );
        }
        hostProcessObserverForTest?.beforeParentDescriptorRelease?.();
        closeSync(reader);
        descriptorState = "closed";
      },
      dispose: cleanup,
    };
  } catch (error) {
    try {
      cleanup();
    } catch (cleanupError) {
      throw new UnverifiedPortablePackageStagingCleanupError(
        error,
        cleanupError,
      );
    }
    throw error;
  }
}

function descendantProcessIds(rootPid: number): readonly number[] {
  const probe = spawnSync(
    "/bin/ps",
    ["-axo", "pid=,ppid="],
    {
      encoding: "utf8",
      env: {
        LANG: "C",
        LC_ALL: "C",
        NODE_ENV: "production",
        PATH: "/usr/bin:/bin",
      },
      maxBuffer: 1024 * 1024,
    },
  );
  if (probe.error !== undefined) throw probe.error;
  if (probe.status !== 0) {
    throw new Error("portable plugin process tree could not be inspected");
  }
  const children = new Map<number, number[]>();
  for (const line of probe.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match === null) {
      throw new Error("portable plugin process tree returned malformed data");
    }
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (
      !Number.isSafeInteger(pid)
      || pid < 1
      || !Number.isSafeInteger(parentPid)
      || parentPid < 0
    ) {
      throw new Error("portable plugin process tree returned invalid identities");
    }
    const values = children.get(parentPid) ?? [];
    values.push(pid);
    children.set(parentPid, values);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pid === undefined) break;
    descendants.push(pid);
    if (descendants.length > MAX_CONTAINED_DESCENDANTS) {
      throw new Error("portable plugin exceeded the descendant process bound");
    }
    pending.push(...(children.get(pid) ?? []));
  }
  return Object.freeze(descendants);
}

async function terminateChild(
  child: ChildProcess,
  closed: Promise<void>,
  options: {
    readonly beforeTermination?: () => Promise<void>;
    readonly hostIdentity?: ProcessOwnerIdentity;
    readonly portableCodeAdmitted: boolean;
  },
): Promise<void> {
  let descendantObserved = false;
  let containmentProofError: unknown = null;
  const retainProofError = (error: unknown): void => {
    if (containmentProofError === null) containmentProofError = error;
  };
  const inspectContainment = (): void => {
    if (!options.portableCodeAdmitted) return;
    const hostIdentity = options.hostIdentity;
    if (hostIdentity === undefined) {
      retainProofError(new Error(
        "admitted portable plugin host identity is unavailable",
      ));
      return;
    }
    if (processOwnerStatus(hostIdentity) !== "exact-live-owner") {
      retainProofError(new Error(
        "portable plugin host identity was not live during containment inspection",
      ));
      return;
    }
    let descendants: readonly number[];
    try {
      descendants = (
        hostProcessObserverForTest?.descendantProcessIds?.(hostIdentity)
        ?? descendantProcessIds(hostIdentity.pid)
      );
      if (descendants.length > MAX_CONTAINED_DESCENDANTS) {
        throw new Error("portable plugin exceeded the descendant process bound");
      }
      for (const pid of descendants) {
        if (!Number.isSafeInteger(pid) || pid < 1) {
          throw new Error(
            "portable plugin process tree returned invalid identities",
          );
        }
      }
    } catch (error) {
      retainProofError(error);
      return;
    }
    if (processOwnerStatus(hostIdentity) !== "exact-live-owner") {
      retainProofError(new Error(
        "portable plugin host identity changed during containment inspection",
      ));
      return;
    }
    if (descendants.length > 0) descendantObserved = true;
  };
  const signalDirectChild = (value: NodeJS.Signals): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      // The owned ChildProcess handle remains bound until reaping. Never turn
      // its numeric PID into a later process or process-group signal target.
      child.kill(value);
    } catch (error) {
      retainProofError(error);
    }
  };
  const closesWithin = async (maximumMs: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true as const),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), maximumMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const destroyProtocolStreams = (): void => {
    for (const stream of child.stdio) stream?.destroy();
  };

  inspectContainment();
  try {
    await options.beforeTermination?.();
  } catch {
    // Direct process termination remains the cleanup boundary.
  }
  child.stdin?.end();
  signalDirectChild("SIGTERM");
  let directChildClosed = await closesWithin(TERMINATION_GRACE_MS);
  if (!directChildClosed) {
    inspectContainment();
    signalDirectChild("SIGKILL");
    directChildClosed = await closesWithin(TERMINATION_CONFIRMATION_MS);
  }
  if (!directChildClosed) {
    destroyProtocolStreams();
    await closesWithin(TERMINATION_STREAM_CLOSE_MS);
    throw new Error(
      "portable plugin invocation process survived forced termination",
      containmentProofError === null
        ? undefined
        : { cause: containmentProofError },
    );
  }
  if (descendantObserved) {
    retainProofError(new Error(
      "portable plugin descendant cleanup cannot be proven without atomic process ownership",
    ));
  }
  if (containmentProofError !== null) {
    destroyProtocolStreams();
    throw new Error(
      "portable plugin invocation containment could not be verified",
      { cause: containmentProofError },
    );
  }
}

/**
 * Run one exact installed portable provider plugin through the v1 framed
 * protocol.
 *
 * The child process isolates crashes and dependencies. It is deliberately not
 * described as a hostile-code sandbox: explicitly trusted same-account
 * JavaScript still has ambient OS authority. Every host-provided capability,
 * however, is denied unless both the immutable manifest and invocation grant
 * it.
 */
async function runPortableProviderPluginHostCore(
  invocation: PortableProviderPluginHostInvocation,
  cleanupBarrier: PortableProviderPluginCleanupBarrier,
): Promise<PortableProviderPluginHostResult> {
  let verified: VerifiedPortableProviderPluginPackage;
  try {
    verified = verifyPortableProviderPluginPackageDirectory(
      invocation.package.root,
    );
    assertInvocation(invocation, verified);
  } catch (error) {
    // Validation has not staged bytes or started a child.
    cleanupBarrier.verified();
    throw error;
  }
  const binding = routeBinding(verified, invocation.route);
  const plannedDispatchIds = invocation.plannedDispatchIds ?? [];
  const invocationId = crypto.randomUUID();
  const identity = Object.freeze({
    id: verified.manifest.id,
    version: verified.manifest.version,
    bundleSha256: verified.bundleSha256,
  });
  const executable = invocation.bunExecutable ?? process.execPath;
  let stagedPackage: StagedPortablePackage;
  try {
    stagedPackage = stageVerifiedPortablePackage(verified);
  } catch (error) {
    // Ordinary staging failures own and prove their synchronous rollback.
    // Only an explicitly unverified descriptor/directory cleanup retains the
    // invocation lease.
    if (error instanceof UnverifiedPortablePackageStagingCleanupError) {
      cleanupBarrier.unsafe(error);
    } else {
      cleanupBarrier.verified();
    }
    throw error;
  }
  const childArgs = Object.freeze([
    "--no-env-file",
    "--no-install",
    "--no-macros",
    "--no-addons",
    `--config=${EMPTY_HOST_CONFIG_PATH}`,
    `--preload=${stagedPackage.guardPath}`,
    stagedPackage.childPath,
  ]);
  const processObserver = hostProcessObserverForTest;
  const isolatesProcessGroup = process.platform !== "win32";
  let child: ChildProcessWithoutNullStreams;
  let childClosed: Promise<void>;
  let childIdentity: ProcessOwnerIdentity;
  let spawned: ChildProcess | undefined;
  let spawnedClosed: Promise<void> | undefined;
  let spawnedIdentity: ProcessOwnerIdentity | undefined;
  let portableCodeAdmitted = false;
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(),
    invocation.timeoutMs,
  );
  timeout.unref();
  const onCallerAbort = (): void => timeoutController.abort();
  if (invocation.signal?.aborted === true) timeoutController.abort();
  else invocation.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    processObserver?.beforeSpawn?.({
      executable,
      args: childArgs,
      cwd: stagedPackage.cwd,
    });
    spawned = spawn(executable, childArgs, {
      cwd: stagedPackage.cwd,
      env: {
        LANG: "C",
        LC_ALL: "C",
        NODE_ENV: "production",
        NO_COLOR: "1",
        PATH: dirname(executable),
        TZ: "UTC",
      },
      stdio: ["pipe", "pipe", "pipe", stagedPackage.fd],
      detached: isolatesProcessGroup,
      windowsHide: true,
    });
    spawnedClosed = new Promise<void>((resolve) => {
      spawned?.once("close", () => resolve());
    });
    spawned.once("exit", (code, signal) => {
      processObserver?.exit?.({ code, signal });
    });
    const spawnedPid = spawned.pid;
    if (spawnedPid === undefined) {
      throw new Error("portable plugin process has no process identity");
    }
    spawnedIdentity = captureProcessOwnerIdentity(spawnedPid);
    announcePortableProviderPluginHostStarting(spawnedIdentity);
    stagedPackage.releaseParentDescriptor();
    if (!hasProtocolStreams(spawned)) {
      throw new Error("portable plugin process has no protocol streams");
    }
    announcePortableProviderPluginHostStarted(spawnedIdentity);
    portableCodeAdmitted = true;
    await admitPortableProviderPluginHost(
      spawned.stdin,
      timeoutController.signal,
    );
    child = spawned;
    childClosed = spawnedClosed;
    childIdentity = spawnedIdentity;
  } catch (error) {
    const setupError = timeoutController.signal.aborted
      ? valueFreeError(
          invocation.signal?.aborted === true ? "cancelled" : "timeout",
          invocation.signal?.aborted === true
            ? "portable provider plugin invocation was cancelled"
            : "portable provider plugin invocation exceeded its total deadline",
          plannedDispatchIds.length,
          0,
          0,
        )
      : asHostError(
          error,
          plannedDispatchIds.length,
          { started: 0, verified: 0 },
        );
    clearTimeout(timeout);
    invocation.signal?.removeEventListener("abort", onCallerAbort);
    const cleanupFailures: unknown[] = [];
    if (spawned !== undefined && spawnedClosed !== undefined) {
      try {
        await terminateChild(spawned, spawnedClosed, {
          ...(spawnedIdentity === undefined
            ? {}
            : { hostIdentity: spawnedIdentity }),
          portableCodeAdmitted,
        });
      } catch (candidate) {
        cleanupFailures.push(candidate);
      }
    }
    try {
      stagedPackage.dispose();
    } catch (candidate) {
      cleanupFailures.push(candidate);
    }
    if (cleanupFailures.length > 0) {
      cleanupBarrier.unsafe(new AggregateError(
        cleanupFailures,
        "portable plugin setup cleanup failed",
      ));
      throw asHostError(
        new AggregateError(
          [setupError, ...cleanupFailures],
          "portable plugin setup and cleanup failed",
        ),
        plannedDispatchIds.length,
        { started: 0, verified: 0 },
      );
    } else {
      cleanupBarrier.verified();
    }
    throw setupError;
  }
  const queue = new ProcessMessageQueue();
  const decoder = new PortableProviderPluginFrameDecoder();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let messageCount = 0;
  let streamFinished = false;
  let resultReceived = false;
  const state: InvocationPolicyState = {
    requestIds: new Set(),
    filesByHandle: new Map(
      invocation.files.map((file) => [file.handle, file] as const),
    ),
    materialHandles: new Map(),
    dispatchHandles: new Map(),
    started: 0,
    verified: 0,
  };

  child.stdout.on("data", (chunkValue: unknown) => {
    if (!Buffer.isBuffer(chunkValue)) {
      queue.fail(new Error("portable plugin stdout returned non-byte data"));
      return;
    }
    stdoutBytes += chunkValue.byteLength;
    if (stdoutBytes > MAX_HOST_STDOUT_BYTES) {
      queue.fail(new Error("portable plugin stdout exceeded the invocation bound"));
      return;
    }
    try {
      for (const message of decoder.push(chunkValue)) {
        messageCount += 1;
        if (messageCount > MAX_HOST_MESSAGES) {
          throw new Error("portable plugin exceeded the message-count bound");
        }
        if (!isProcessMessage(message)) {
          throw new Error("portable plugin emitted a host-direction message");
        }
        queue.push(message);
      }
    } catch (error) {
      queue.fail(
        error instanceof Error
          ? error
          : new Error("portable plugin stdout was malformed"),
      );
    }
  });
  child.stdout.once("end", () => {
    if (streamFinished) return;
    streamFinished = true;
    try {
      decoder.finish();
    } catch (error) {
      queue.fail(
        error instanceof Error
          ? error
          : new Error("portable plugin stdout ended incorrectly"),
      );
    }
  });
  child.stderr.on("data", (chunkValue: unknown) => {
    if (!Buffer.isBuffer(chunkValue)) {
      queue.fail(new Error("portable plugin stderr returned non-byte data"));
      return;
    }
    stderrBytes += chunkValue.byteLength;
    if (stderrBytes > MAX_HOST_STDERR_BYTES) {
      queue.fail(new Error("portable plugin stderr exceeded the invocation bound"));
    }
  });
  child.once("error", () => {
    queue.fail(new Error("portable plugin process could not be started"));
  });
  child.stdin.once("error", () => {
    queue.fail(new Error("portable plugin stdin failed"));
  });
  child.once("exit", () => {
    if (!resultReceived) {
      queue.fail(new Error("portable plugin process exited before completing a response"));
    }
  });

  const aborted = new Promise<never>((_resolve, reject) => {
    if (timeoutController.signal.aborted) {
      reject(new Error("portable plugin invocation was cancelled"));
      return;
    }
    timeoutController.signal.addEventListener(
      "abort",
      () => reject(new Error("portable plugin invocation was cancelled")),
      { once: true },
    );
  });
  const nextMessage = (): Promise<ProcessMessage> =>
    Promise.race([queue.next(), aborted]);
  const written = { bytes: 0 };

  let invoked = false;
  let executionResult: PortableProviderPluginHostResult | null = null;
  let executionError: PortableProviderPluginHostError | null = null;
  try {
    await writeHostMessage(child, hostMessage({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "host.hello",
      hostVersion: invocation.hostVersion,
      hostApiVersion: PORTABLE_PROVIDER_PLUGIN_HOST_API_VERSION,
      plugin: identity,
      granted: verified.manifest.capabilities,
    }), timeoutController.signal, written);
    const ready = await nextMessage();
    if (
      ready.kind !== "plugin.ready"
      || ready.plugin.id !== identity.id
      || ready.plugin.version !== identity.version
      || ready.plugin.bundleSha256 !== identity.bundleSha256
    ) {
      throw valueFreeError(
        "handshake-failed",
        "portable provider plugin did not accept its exact installed identity",
        plannedDispatchIds.length,
        state.started,
        state.verified,
      );
    }
    await writeHostMessage(child, hostMessage({
      protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
      kind: "host.invoke",
      invocationId,
      route: invocation.route,
      input: invocation.input,
      auth: invocation.auth,
      files: invocation.files,
      timeoutMs: invocation.timeoutMs,
    }), timeoutController.signal, written);
    invoked = true;

    for (;;) {
      const message = await nextMessage();
      if (message.kind === "plugin.capability.request") {
        if (
          message.invocationId !== invocationId
          || state.requestIds.has(message.requestId)
          || state.requestIds.size >= MAX_HOST_MESSAGES
        ) {
          throw valueFreeError(
            "protocol-violation",
            "portable provider plugin emitted an invalid capability request",
            plannedDispatchIds.length,
            state.started,
            state.verified,
          );
        }
        state.requestIds.add(message.requestId);
        const declared = capabilityIsDeclared(
          message.request,
          verified.manifest.capabilities,
          binding,
          invocation.auth,
          plannedDispatchIds,
          state,
        );
        if (
          !declared
          && (
            message.request.kind === "dispatch.begin"
            || message.request.kind === "dispatch.verify"
            || (
              message.request.kind === "http.request"
              && (
                message.request.dispatchHandle !== undefined
                || (
                  message.request.method !== "GET"
                  && message.request.method !== "HEAD"
                )
              )
            )
          )
        ) {
          throw valueFreeError(
            "protocol-violation",
            "portable provider plugin violated its confirmed dispatch boundary",
            plannedDispatchIds.length,
            state.started,
            state.verified,
          );
        }
        const mutationDispatch = (
          declared
          && invocation.capabilityHost !== undefined
          && message.request.kind === "http.request"
          && message.request.method !== "GET"
          && message.request.method !== "HEAD"
          && message.request.dispatchHandle !== undefined
        )
          ? state.dispatchHandles.get(message.request.dispatchHandle)
          : undefined;
        if (mutationDispatch !== undefined) {
          // Consume the one remote-write attempt before crossing the host
          // capability boundary. A reset, timeout, oversized response, or
          // malformed host result may occur after the provider accepted the
          // write, so the same dispatch handle must never become reusable.
          mutationDispatch.mutationAttempted = true;
        }
        let result: PortablePluginCapabilityResult | null = null;
        if (declared && message.request.kind === "log.write") {
          result = { kind: "log.write", accepted: true };
        } else if (declared && invocation.capabilityHost !== undefined) {
          try {
            const candidate = await Promise.race([
              invocation.capabilityHost.handle(
                message.request,
                {
                  invocationId,
                  requestId: message.requestId,
                  route: invocation.route,
                  signal: timeoutController.signal,
                },
              ),
              aborted,
            ]);
            const normalized = normalizedCapabilityResult(
              invocationId,
              message.requestId,
              candidate,
            );
            if (matchingCapabilityResult(
              message.request,
              normalized,
              state.filesByHandle,
            )) {
              result = normalized;
            }
          } catch {
            if (mutationDispatch !== undefined) {
              throw valueFreeError(
                "dispatch-indeterminate",
                "portable provider plugin mutation failed after its dispatch boundary began",
                plannedDispatchIds.length,
                state.started,
                state.verified,
              );
            }
            if (timeoutController.signal.aborted) {
              throw new Error("portable plugin capability exceeded the invocation deadline");
            }
            // Capability failures are returned without carrying foreign values.
          }
        }
        if (result === null) {
          if (mutationDispatch !== undefined) {
            throw valueFreeError(
              "dispatch-indeterminate",
              "portable provider plugin mutation returned no valid result after its dispatch boundary began",
              plannedDispatchIds.length,
              state.started,
              state.verified,
            );
          }
          await writeHostMessage(child, hostMessage({
            protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
            kind: "host.capability.error",
            invocationId,
            requestId: message.requestId,
            capability: message.request.kind,
            error: {
              code: declared ? "CAPABILITY_FAILED" : "CAPABILITY_DENIED",
              message: declared
                ? "host capability failed"
                : "requested capability is not granted",
            },
          }), timeoutController.signal, written);
          continue;
        }
        if (
          message.request.kind === "dispatch.begin"
          && result.kind === "dispatch.begin"
        ) {
          if (state.dispatchHandles.has(result.dispatchHandle)) {
            throw valueFreeError(
              "protocol-violation",
              "portable provider plugin host returned a repeated dispatch handle",
              plannedDispatchIds.length,
              state.started,
              state.verified,
            );
          }
          state.dispatchHandles.set(result.dispatchHandle, {
            dispatchId: message.request.dispatchId,
            verified: false,
            mutationAttempted: false,
            mutationCompleted: false,
          });
          state.started += 1;
        } else if (
          message.request.kind === "http.request"
          && message.request.method !== "GET"
          && message.request.method !== "HEAD"
          && message.request.dispatchHandle !== undefined
          && result.kind === "http.request"
        ) {
          const dispatch = state.dispatchHandles.get(
            message.request.dispatchHandle,
          );
          if (
            dispatch === undefined
            || dispatch.verified
            || !dispatch.mutationAttempted
            || dispatch.mutationCompleted
          ) {
            throw valueFreeError(
              "protocol-violation",
              "portable provider plugin used an invalid mutation dispatch handle",
              plannedDispatchIds.length,
              state.started,
              state.verified,
            );
          }
          dispatch.mutationCompleted = true;
        } else if (
          message.request.kind === "dispatch.verify"
          && result.kind === "dispatch.verify"
        ) {
          const dispatch = state.dispatchHandles.get(
            message.request.dispatchHandle,
          );
          if (dispatch === undefined || dispatch.verified) {
            throw valueFreeError(
              "protocol-violation",
              "portable provider plugin verified an unknown dispatch",
              plannedDispatchIds.length,
              state.started,
              state.verified,
            );
          }
          dispatch.verified = true;
          state.verified += 1;
        } else if (
          message.request.kind === "session.acquire"
          && result.kind === "session.acquire"
        ) {
          if (state.materialHandles.has(result.materialHandle)) {
            throw valueFreeError(
              "protocol-violation",
              "portable provider plugin host returned a repeated material handle",
              plannedDispatchIds.length,
              state.started,
              state.verified,
            );
          }
          state.materialHandles.set(
            result.materialHandle,
            message.request.name,
          );
        }
        await writeHostMessage(child, hostMessage({
          protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
          kind: "host.capability.result",
          invocationId,
          requestId: message.requestId,
          result,
        }), timeoutController.signal, written);
        continue;
      }
      if (message.kind === "plugin.result") {
        if (message.invocationId !== invocationId) {
          throw valueFreeError(
            "protocol-violation",
            "portable provider plugin returned a result for another invocation",
            plannedDispatchIds.length,
            state.started,
            state.verified,
          );
        }
        if (
          state.started !== plannedDispatchIds.length
          || state.verified !== state.started
        ) {
          throw valueFreeError(
            state.started > state.verified
              ? "dispatch-indeterminate"
              : "dispatch-incomplete",
            state.started > state.verified
              ? "portable provider plugin returned before verifying a started dispatch"
              : "portable provider plugin returned without completing its confirmed dispatch plan",
            plannedDispatchIds.length,
            state.started,
            state.verified,
          );
        }
        if (
          message.finalUrl !== null
          && !verified.manifest.capabilities.networkOrigins.includes(
            exactOrigin(message.finalUrl) as `https://${string}`,
          )
        ) {
          throw valueFreeError(
            "origin-violation",
            "portable provider plugin returned a final URL outside its granted origins",
            plannedDispatchIds.length,
            state.started,
            state.verified,
          );
        }
        resultReceived = true;
        executionResult = Object.freeze({
          output: message.output,
          finalUrl: message.finalUrl,
          dispatch: Object.freeze({
            planned: plannedDispatchIds.length,
            started: state.started,
            verified: state.verified,
          }),
        });
        break;
      }
      if (message.kind === "plugin.cancelled") {
        throw valueFreeError(
          "plugin-cancelled",
          "portable provider plugin cancelled its invocation",
          plannedDispatchIds.length,
          state.started,
          state.verified,
        );
      }
      throw valueFreeError(
        message.kind === "plugin.error"
          ? "plugin-error"
          : "protocol-violation",
        message.kind === "plugin.error"
          ? "portable provider plugin reported an execution failure"
          : "portable provider plugin emitted an unexpected message",
        plannedDispatchIds.length,
        state.started,
        state.verified,
      );
    }
  } catch (error) {
    if (
      timeoutController.signal.aborted
      && !(error instanceof PortableProviderPluginHostError)
    ) {
      executionError = valueFreeError(
        invocation.signal?.aborted === true ? "cancelled" : "timeout",
        invocation.signal?.aborted === true
          ? "portable provider plugin invocation was cancelled"
          : "portable provider plugin invocation exceeded its total deadline",
        plannedDispatchIds.length,
        state.started,
        state.verified,
      );
    } else {
      executionError = asHostError(error, plannedDispatchIds.length, state);
    }
  }

  clearTimeout(timeout);
  invocation.signal?.removeEventListener("abort", onCallerAbort);
  let cleanupError: unknown = null;
  try {
    await terminateChild(
      child,
      childClosed,
      {
        beforeTermination: async () => {
          if (!invoked || !child.stdin.writable) return;
          const cleanupController = new AbortController();
          const cleanupTimer = setTimeout(
            () => cleanupController.abort(),
            TERMINATION_GRACE_MS,
          );
          try {
            await writeHostMessage(child, hostMessage({
              protocolVersion: PORTABLE_PROVIDER_PLUGIN_PROTOCOL_VERSION,
              kind: "host.cancel",
              invocationId,
              reason: timeoutController.signal.aborted
                ? "timeout"
                : "shutdown",
            }), cleanupController.signal, written);
          } finally {
            clearTimeout(cleanupTimer);
          }
        },
        hostIdentity: childIdentity,
        portableCodeAdmitted: true,
      },
    );
  } catch (error) {
    cleanupError = error;
  }
  try {
    stagedPackage.dispose();
  } catch (error) {
    if (cleanupError === null) cleanupError = error;
  }
  if (cleanupError !== null) {
    cleanupBarrier.unsafe(cleanupError);
    if (state.started > state.verified) {
      throw valueFreeError(
        "dispatch-indeterminate",
        "portable provider plugin process cleanup failed after dispatch began",
        plannedDispatchIds.length,
        state.started,
        state.verified,
      );
    }
    throw asHostError(cleanupError, plannedDispatchIds.length, state);
  }
  cleanupBarrier.verified();
  if (executionError !== null) throw executionError;
  if (executionResult === null) {
    throw valueFreeError(
      "host-failed",
      "portable provider plugin host produced no result",
      plannedDispatchIds.length,
      state.started,
      state.verified,
    );
  }
  return executionResult;
}

export async function runPortableProviderPluginHost(
  invocation: PortableProviderPluginHostInvocation,
): Promise<PortableProviderPluginHostResult> {
  const cleanupBarrier = registerPortableProviderPluginCleanupBarrier();
  try {
    return await runPortableProviderPluginHostCore(
      invocation,
      cleanupBarrier,
    );
  } catch (error) {
    if (!cleanupBarrier.settled) {
      cleanupBarrier.unsafe(new Error(
        "portable provider plugin host exited without cleanup proof",
      ));
    }
    throw error;
  }
}
