import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS,
  encodeApplePhotosContactEvidenceExportResult,
  parseApplePhotosContactEvidenceExportResult,
} from "./apple-photos-contact-evidence";
import type {
  ApplePhotosContactEvidenceExportResult,
} from "./apple-photos-client-types";
import {
  exportApplePhotosContactEvidence,
  type ApplePhotosLocalSourceDependencies,
  type ApplePhotosLocalSourceProgressEvent,
} from "./apple-photos-local-source";
import {
  acquireBeeperMessageLikeMeExportAdmission,
  beginBeeperMessageLikeMeHelperLaunch,
  bindBeeperMessageLikeMeHelperOwner,
  markBeeperMessageLikeMeHelperCleanupUnsafe,
  recoverBeeperMessageLikeMeDirectoryLeases,
  releaseBeeperMessageLikeMeExportAdmission,
  settleBeeperMessageLikeMeHelper,
  type BeeperMessageLikeMeExportAdmission,
} from "./beeper-message-like-me-recovery";
import { canonicalJson } from "./canonical-json";
import { wrenchStateHome } from "./storage";

const APPLE_PHOTOS_WORKER_TIMEOUT_MS = 15 * 60 * 1_000;
const APPLE_PHOTOS_WORKER_TERMINATION_GRACE_MS = 1_000;
const APPLE_PHOTOS_WORKER_MAX_STDERR_BYTES = 32 * 1024;
const APPLE_PHOTOS_WORKER_PROGRESS_PREFIX = "wrench-apple-photos-progress:";
const APPLE_PHOTOS_WORKER_ERROR_PREFIX = "wrench-apple-photos-error:";

type ApplePhotosWorkerSupervisorDependencies = Readonly<{
  argv?: readonly string[];
  timeoutMs?: number;
  terminationGraceMs?: number;
  processGroupAlive?: (pid: number) => boolean;
  afterAbortListenerForTest?: () => void;
}>;

export type ApplePhotosContactEvidenceProgressEvent = Readonly<
  | { phase: "platform-check" }
  | { phase: "private-export-admission" }
  | { phase: "private-export-recovery" }
  | ApplePhotosLocalSourceProgressEvent
  | { phase: "artifact-validation" }
  | { phase: "complete" }
>;

export type ApplePhotosContactEvidenceCliRequest = Readonly<{
  library?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  dependencies?: ApplePhotosLocalSourceDependencies;
  /** @internal Process-supervisor fault injection. */
  supervisorDependencies?: ApplePhotosWorkerSupervisorDependencies;
  progress?: (event: ApplePhotosContactEvidenceProgressEvent) => void;
}>;

function reportProgress(
  request: ApplePhotosContactEvidenceCliRequest,
  event: ApplePhotosContactEvidenceProgressEvent,
): void {
  try {
    request.progress?.(Object.freeze(event));
  } catch {
    // Diagnostics are advisory and cannot change admission or cleanup behavior.
  }
}

class ApplePhotosWorkerIndeterminateError extends Error {}

function fail(message: string): never {
  throw new Error(`Apple Photos local source: ${message}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Apple Photos export was cancelled", "AbortError");
}

function defaultWorkerArgv(): readonly string[] {
  const program = [
    `const runtime = await import(${JSON.stringify(import.meta.url)});`,
    "await runtime.runApplePhotosContactEvidenceWorker();",
  ].join("\n");
  const config = fileURLToPath(new URL("./state-helper.bunfig.toml", import.meta.url));
  return Object.freeze([
    process.execPath,
    "--no-env-file",
    "--no-install",
    "--no-macros",
    "--no-addons",
    `--config=${config}`,
    "-e",
    program,
  ]);
}

function minimalWorkerEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  canonicalStateHome: string,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = Object.create(null);
  for (const key of [
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TZ",
  ] as const) {
    const value = environment[key];
    if (typeof value === "string" && !value.includes("\0")) selected[key] = value;
  }
  selected.WRENCH_STATE_HOME = canonicalStateHome;
  selected.NODE_ENV = "production";
  return Object.freeze(selected);
}

function defaultProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { readonly code?: unknown }).code === "ESRCH") return false;
    return true;
  }
}

function privateWorkerError(stderr: string): Error {
  const line = stderr.split("\n").find((candidate) =>
    candidate.startsWith(APPLE_PHOTOS_WORKER_ERROR_PREFIX));
  if (line !== undefined) {
    try {
      const decoded = JSON.parse(
        line.slice(APPLE_PHOTOS_WORKER_ERROR_PREFIX.length),
      ) as unknown;
      if (
        typeof decoded === "string"
        && decoded.length > 0
        && Buffer.byteLength(decoded, "utf8") <= 4_096
        && !/[\\/\r\n]/u.test(decoded)
      ) return new Error(decoded);
    } catch {
      // Malformed and path-bearing diagnostics are deliberately collapsed.
    }
  }
  return new Error("Apple Photos local source: private worker failed");
}

function parseWorkerProgress(
  line: string,
): ApplePhotosLocalSourceProgressEvent | null {
  if (!line.startsWith(APPLE_PHOTOS_WORKER_PROGRESS_PREFIX)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      line.slice(APPLE_PHOTOS_WORKER_PROGRESS_PREFIX.length),
    ) as unknown;
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  const simple = new Set([
    "source-admission",
    "contacts-discovery",
    "photos-capture",
    "evidence-validation",
    "generation-hashing",
    "cleanup",
  ]);
  if (
    typeof record.phase === "string"
    && simple.has(record.phase)
    && Object.keys(record).length === 1
  ) return Object.freeze({
    phase: record.phase,
  } as ApplePhotosLocalSourceProgressEvent);
  if (
    record.phase === "contacts-capture"
    && Object.keys(record).sort().join(",") === "current,phase,total"
    && typeof record.current === "number"
    && Number.isSafeInteger(record.current)
    && record.current >= 1
    && typeof record.total === "number"
    && Number.isSafeInteger(record.total)
    && record.total >= record.current
    && record.total <= APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases
  ) return Object.freeze({
    phase: "contacts-capture",
    current: record.current,
    total: record.total,
  });
  return null;
}

async function superviseApplePhotosWorker(
  request: ApplePhotosContactEvidenceCliRequest,
  environment: Readonly<Record<string, string | undefined>>,
  canonicalStateHome: string,
  deadlineAt: number,
  admission: BeeperMessageLikeMeExportAdmission,
): Promise<ApplePhotosContactEvidenceExportResult> {
  if (request.signal?.aborted === true) throw abortError(request.signal);
  const dependencies = request.supervisorDependencies;
  const graceMs = dependencies?.terminationGraceMs
    ?? APPLE_PHOTOS_WORKER_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 10_000) {
    return fail("private worker termination grace is invalid");
  }
  const argv = dependencies?.argv === undefined
    ? [...defaultWorkerArgv()]
    : [...dependencies.argv];
  const [command, ...arguments_] = argv;
  if (command === undefined) return fail("private worker command is unavailable");
  beginBeeperMessageLikeMeHelperLaunch(admission);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: minimalWorkerEnvironment(environment, canonicalStateHome),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    try {
      settleBeeperMessageLikeMeHelper(admission);
    } catch {
      try {
        markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
      } catch {
        // The unchanged launching claim remains fail-closed.
      }
      throw new ApplePhotosWorkerIndeterminateError(
        "Apple Photos local source: private worker launch outcome is indeterminate; recovery remains blocked",
      );
    }
    throw error;
  }
  const childStdin = child.stdin!;
  const childStdout = child.stdout!;
  const childStderr = child.stderr!;
  const detachChild = (): void => {
    child.removeAllListeners();
    for (const stream of [childStdin, childStdout, childStderr]) {
      stream.removeAllListeners();
      stream.destroy();
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    child.unref();
  };
  if (child.pid === undefined) {
    return new Promise<ApplePhotosContactEvidenceExportResult>((_resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
        } catch {
          // The unchanged durable launching claim remains fail-closed.
        }
        detachChild();
        reject(new ApplePhotosWorkerIndeterminateError(
          "Apple Photos local source: private worker launch outcome is indeterminate; recovery remains blocked",
        ));
      }, graceMs);
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detachChild();
        try {
          settleBeeperMessageLikeMeHelper(admission);
        } catch {
          try {
            markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
          } catch {
            // The unchanged launching claim remains fail-closed.
          }
          reject(new ApplePhotosWorkerIndeterminateError(
            "Apple Photos local source: private worker launch outcome is indeterminate; recovery remains blocked",
          ));
          return;
        }
        reject(new Error("Apple Photos local source: private worker launch failed"));
      });
    });
  }
  const pid = child.pid;
  const groupAlive = dependencies?.processGroupAlive ?? defaultProcessGroupAlive;
  const ownedGroupAlive = (): boolean => {
    try {
      return groupAlive(pid);
    } catch {
      return true;
    }
  };
  const input = `${canonicalJson({
    ...(request.library === undefined ? {} : { library: request.library }),
  })}\n`;
  return new Promise<ApplePhotosContactEvidenceExportResult>((resolvePromise, rejectPromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutClosed = false;
    let stderrClosed = false;
    let childClosed = false;
    let settled = false;
    let terminating = false;
    let pendingFailure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let proofTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout>;
    const cleanupListeners = (): void => {
      clearTimeout(deadlineTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (proofTimer !== undefined) clearTimeout(proofTimer);
      request.signal?.removeEventListener("abort", onAbort);
    };
    const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
      try {
        process.kill(-pid, signal);
      } catch {
        // Child close plus process-group absence are checked separately.
      }
    };
    const failIndeterminate = (): void => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try {
        markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
      } catch {
        // A stale helper-active claim still retains exact ownership safely.
      }
      detachChild();
      rejectPromise(new ApplePhotosWorkerIndeterminateError(
        "Apple Photos local source: private worker termination is indeterminate; recovery remains blocked",
      ));
    };
    let beginTermination: (reason: Error) => void;
    const maybeFinish = (): void => {
      if (settled || !stdoutClosed || !stderrClosed || !childClosed) return;
      if (ownedGroupAlive()) {
        if (!terminating) beginTermination(
          new Error("Apple Photos local source: private worker process group remained active"),
        );
        return;
      }
      try {
        settleBeeperMessageLikeMeHelper(admission);
      } catch {
        failIndeterminate();
        return;
      }
      settled = true;
      cleanupListeners();
      if (pendingFailure !== null) {
        rejectPromise(pendingFailure);
        return;
      }
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (child.exitCode !== 0) {
        rejectPromise(privateWorkerError(stderrText));
        return;
      }
      for (const line of stderrText.split("\n")) {
        const event = parseWorkerProgress(line);
        if (event !== null) reportProgress(request, event);
        else if (line.length > 0) {
          rejectPromise(new Error("Apple Photos local source: private worker protocol drifted"));
          return;
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown;
      } catch {
        rejectPromise(new Error("Apple Photos local source: private worker returned malformed JSON"));
        return;
      }
      try {
        resolvePromise(parseApplePhotosContactEvidenceExportResult(parsed));
      } catch (error) {
        rejectPromise(error);
      }
    };
    beginTermination = (reason: Error): void => {
      pendingFailure ??= reason;
      if (terminating) return;
      terminating = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL");
        proofTimer = setTimeout(() => {
          maybeFinish();
          if (!settled && (ownedGroupAlive() || !childClosed || !stdoutClosed || !stderrClosed)) {
            failIndeterminate();
          }
        }, graceMs);
      }, graceMs);
    };
    const observedSignal = request.signal;
    const onAbort = (): void => beginTermination(abortError(observedSignal!));
    deadlineTimer = setTimeout(() => beginTermination(
      new Error("Apple Photos local source: private worker exceeded the total operation deadline"),
    ), Math.max(0, deadlineAt - performance.now()));
    observedSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      dependencies?.afterAbortListenerForTest?.();
    } catch {
      beginTermination(new Error(
        "Apple Photos local source: private worker abort hook failed",
      ));
    }
    child.on("error", () => beginTermination(
      new Error("Apple Photos local source: private worker launch failed"),
    ));
    childStdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumWireBytes) {
        beginTermination(new Error(
          "Apple Photos local source: private worker response exceeded its byte bound",
        ));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    childStderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > APPLE_PHOTOS_WORKER_MAX_STDERR_BYTES) {
        beginTermination(new Error(
          "Apple Photos local source: private worker diagnostic exceeded its byte bound",
        ));
        return;
      }
      stderr.push(Buffer.from(chunk));
    });
    childStdout.once("close", () => {
      stdoutClosed = true;
      maybeFinish();
    });
    childStderr.once("close", () => {
      stderrClosed = true;
      maybeFinish();
    });
    child.once("close", () => {
      childClosed = true;
      maybeFinish();
    });
    childStdin.once("error", () => beginTermination(
      new Error("Apple Photos local source: private worker input failed"),
    ));
    try {
      bindBeeperMessageLikeMeHelperOwner(admission, pid);
    } catch {
      beginTermination(new Error(
        "Apple Photos local source: private worker ownership could not be bound safely",
      ));
      return;
    }
    if (observedSignal?.aborted === true) onAbort();
    if (!terminating) childStdin.end(input, "utf8");
  });
}

export async function exportApplePhotosContactEvidenceForCli(
  request: ApplePhotosContactEvidenceCliRequest = {},
): Promise<ApplePhotosContactEvidenceExportResult> {
  const timeoutMs = request.supervisorDependencies?.timeoutMs
    ?? APPLE_PHOTOS_WORKER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return fail("private worker timeout is invalid");
  }
  const deadlineAt = performance.now() + timeoutMs;
  reportProgress(request, { phase: "platform-check" });
  const platform = request.dependencies?.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error("Apple Photos local source: this source requires macOS");
  }
  if (request.signal?.aborted === true) throw abortError(request.signal);
  const environment = request.environment ?? process.env;
  const canonicalStateHome = wrenchStateHome(environment);
  reportProgress(request, { phase: "private-export-admission" });
  const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
  let releaseAdmission: boolean = true;
  try {
    reportProgress(request, { phase: "private-export-recovery" });
    if (performance.now() >= deadlineAt) {
      throw new Error("Apple Photos local source: private export exceeded the total operation deadline");
    }
    const result = await superviseApplePhotosWorker(
      request,
      environment,
      canonicalStateHome,
      deadlineAt,
      admission,
    )
      .catch((error: unknown) => {
        if (error instanceof ApplePhotosWorkerIndeterminateError) {
          releaseAdmission = false;
        }
        throw error;
      });
    reportProgress(request, { phase: "artifact-validation" });
    const verified = parseApplePhotosContactEvidenceExportResult(result);
    reportProgress(request, { phase: "complete" });
    return verified;
  } finally {
    if (releaseAdmission) releaseBeeperMessageLikeMeExportAdmission(admission);
  }
}

async function readWorkerInput(): Promise<Readonly<{ library?: string }>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk as Buffer);
    bytes += value.byteLength;
    if (bytes > 16 * 1024) return fail("private worker request exceeded its byte bound");
    chunks.push(value);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return fail("private worker request was malformed");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return fail("private worker request was malformed");
  }
  const record = decoded as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "library")
    || (record.library !== undefined && typeof record.library !== "string")
  ) return fail("private worker request was malformed");
  return Object.freeze(
    record.library === undefined ? {} : { library: record.library as string },
  );
}

/** @internal No public argument parser route exposes this worker entry point. */
export async function runApplePhotosContactEvidenceWorker(): Promise<void> {
  try {
    const input = await readWorkerInput();
    const recovery = await recoverBeeperMessageLikeMeDirectoryLeases({
      environment: process.env,
    });
    if (recovery.active > 0 || recovery.indeterminate > 0) {
      throw new Error(
        "Apple Photos local source: another private export is active or prior recovery is indeterminate",
      );
    }
    const result = await exportApplePhotosContactEvidence({
      ...(input.library === undefined ? {} : { library: input.library }),
      stateEnvironment: process.env,
      progress: (event) => {
        process.stderr.write(
          `${APPLE_PHOTOS_WORKER_PROGRESS_PREFIX}${canonicalJson(event)}\n`,
        );
      },
    });
    process.stdout.write(encodeApplePhotosContactEvidenceExportResult(result));
  } catch (error) {
    const message = error instanceof Error
      && Buffer.byteLength(error.message, "utf8") <= 4_096
      && !/[\\/\r\n]/u.test(error.message)
      ? error.message
      : "Apple Photos local source: private local operation failed";
    process.stderr.write(
      `${APPLE_PHOTOS_WORKER_ERROR_PREFIX}${JSON.stringify(message)}\n`,
    );
    process.exitCode = 1;
  }
}

export function formatApplePhotosContactEvidenceProgress(
  event: ApplePhotosContactEvidenceProgressEvent,
): string {
  return event.phase === "contacts-capture"
    ? `apple-photos: contacts-capture ${String(event.current)}-of-${String(event.total)}\n`
    : `apple-photos: ${event.phase}\n`;
}

export function encodeApplePhotosContactEvidenceSummary(
  value: ApplePhotosContactEvidenceExportResult,
): string {
  const parsed = parseApplePhotosContactEvidenceExportResult(value);
  return `${canonicalJson({
    schemaVersion: 1,
    format: "wrench.apple-photos-contact-evidence-summary",
    source: {
      id: parsed.output.source.id,
      version: parsed.output.source.version,
      platform: parsed.output.source.platform,
      libraryRealmSha256: parsed.output.source.libraryRealmSha256,
      generationSha256: parsed.output.source.generationSha256,
    },
    qualification: {
      people: parsed.output.scope.people,
      consistency: parsed.output.source.capture.consistency,
      crossDatabaseAtomicity:
        parsed.output.source.capture.crossDatabaseAtomicity,
      remoteSync: parsed.output.completeness.remoteSync,
      biometricDerivedPrivateMetadata:
        "aggregate-counts-included",
      perClusterPrivateMetadata: "full-json-only",
    },
    counts: parsed.output.counts,
    integrity: {
      artifactSha256: parsed.output.integrity.artifactSha256,
      receiptSha256: parsed.receipt.integrity.receiptSha256,
    },
  })}\n`;
}

export function encodeApplePhotosContactEvidenceCliOutput(
  value: ApplePhotosContactEvidenceExportResult,
  json: boolean,
): string {
  return json
    ? encodeApplePhotosContactEvidenceExportResult(value)
    : encodeApplePhotosContactEvidenceSummary(value);
}

export { encodeApplePhotosContactEvidenceExportResult };
