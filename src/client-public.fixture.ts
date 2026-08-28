import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { canonicalJson, sha256 } from "./canonical-json";

const adapterId = "bluesky-web";
const operationId = "profiles.read";
const input = { handle: "hraness.bsky.social" } as const;
const canonicalInput = canonicalJson(input);
const inputHash = sha256(canonicalInput);
const adapterHash = "a".repeat(64);
const contractHash = "b".repeat(64);
const projectionKey = "c".repeat(64);
const localOperationSegment = `a${"b".repeat(39)}`;
const localOperationId = [
  localOperationSegment,
  localOperationSegment,
  localOperationSegment,
  localOperationSegment,
].join(".");
const localAdapterId = "beeper-local";
const localSurfaceId = `a${"b".repeat(62)}`;
const localAuthId = "beeper-main";
const localAuthHash = "d".repeat(64);
const localProjectionKey = "e".repeat(64);
const localContractHash = "f".repeat(64);
const localTool = Object.freeze({
  schemaVersion: 1,
  id: "beeper-cli",
  implementation: "github.com/beeper/cli",
  versionScheme: "opaque",
  version: " release stable ",
  artifacts: Object.freeze([Object.freeze({
    platform: "darwin",
    arch: "arm64",
    executableSha256: "1".repeat(64),
  })]),
});
const localContract = Object.freeze({
  surface: localSurfaceId,
  action: localOperationId,
  version: 1_000_000,
  hash: localContractHash,
  tool: localTool,
});
const authority = Object.freeze({
  schemaVersion: 1 as const,
  id: `public-${sha256(canonicalJson({
    adapter: adapterId,
    operation: operationId,
  })).slice(0, 32)}`,
  kind: "public-web-session" as const,
  subject: `public:${adapterId}:${operationId}`,
});
const authorityHash = sha256(canonicalJson(authority));
const authorityIdentity = sha256(
  `wrench-public-web-session-authority-v1\0${canonicalJson(authority)}`,
);

function responseChild(response: string): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  stdin.once("finish", () => {
    stdout.end(response);
    stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  });
  return child;
}

function previewEnvelope(): string {
  return JSON.stringify({
    ok: true,
    status: "preview",
    requiresConfirmation: false,
    adapter: {
      id: adapterId,
      version: "1.5.0",
      hash: adapterHash,
    },
    operation: operationId,
    risk: "R1",
    sideEffect: "read",
    input,
    auth: {
      id: authority.id,
      kind: authority.kind,
      realmFingerprint: authorityHash.slice(0, 16),
    },
    identityBinding: {
      status: "public",
      subject: authority.subject,
      accountActor: null,
      requestedActor: null,
    },
    transport: "web-session-api",
  });
}

function catalogEnvelope(): string {
  return JSON.stringify({
    ok: true,
    adapters: [{
      id: adapterId,
      version: "1.5.0",
      displayName: "Bluesky Web API",
      surfaceId: "bluesky",
      origins: ["https://bsky.app", "https://public.api.bsky.app"],
      manifestHash: adapterHash,
      operations: [{
        id: operationId,
        description: "Read one public Bluesky profile.",
        risk: "R1",
        sideEffect: "read",
        idempotency: "safe",
        dedupeWindowMs: 0,
        transport: "web-session-api",
        input: {},
        site: "bluesky",
        webSessionAction: operationId,
        webSessionContractVersion: 2,
        webSessionContractHash: contractHash,
        state: "implemented",
        implementation: "Fixture public profile read",
      }],
    }],
  });
}

function localPreviewEnvelope(): string {
  return JSON.stringify({
    ok: true,
    status: "preview",
    requiresConfirmation: false,
    adapter: {
      id: localAdapterId,
      version: "2.0.0",
      hash: adapterHash,
    },
    operation: localOperationId,
    risk: "R1",
    sideEffect: "read",
    input: {},
    auth: {
      id: localAuthId,
      kind: "linked-device-store",
      realmFingerprint: localAuthHash.slice(0, 16),
    },
    identityBinding: {
      status: "account-subject",
      subject: "beeper:local:fixture",
      accountActor: "beeper:local:fixture",
      requestedActor: null,
    },
    transport: "local-cli",
  });
}

function localCatalogEnvelope(): string {
  return JSON.stringify({
    ok: true,
    adapters: [{
      id: localAdapterId,
      version: "2.0.0",
      displayName: "Beeper local fixture",
      surfaceId: localSurfaceId,
      origins: ["https://www.beeper.com"],
      manifestHash: adapterHash,
      operations: [{
        id: localOperationId,
        description: "Read one local fixture.",
        risk: "R1",
        sideEffect: "read",
        idempotency: "safe",
        dedupeWindowMs: 0,
        transport: "local-cli",
        input: {},
        surface: localCatalogSurfaceMismatch ? "beeper" : localSurfaceId,
        localCliAction: localOperationId,
        localCliContractVersion: 1_000_000,
        localCliContractHash: localContractHash,
        localCliTool: localTool,
        state: "implemented",
        implementation: "Fixture local CLI read",
      }],
    }],
  });
}

function projectionIdentityEnvelope(): string {
  return JSON.stringify({
    ok: true,
    source: "projection-identity",
    status: "ready",
    authIdentity: authorityIdentity,
    authHash: authorityHash,
    inputHash,
    projection: { key: projectionKey },
  });
}

function cacheMissEnvelope(): string {
  return JSON.stringify({
    ok: false,
    source: "cache",
    status: "cache-miss",
    projection: { key: projectionKey },
  });
}

function localProjectionIdentityEnvelope(): string {
  return JSON.stringify({
    ok: true,
    source: "projection-identity",
    status: "ready",
    authIdentity: localAuthHash,
    authHash: localAuthHash,
    inputHash: sha256("{}"),
    projection: { key: localProjectionKey },
  });
}

function receipt(
  auth: Readonly<Record<string, unknown>>,
  runId: string,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 4,
    runId,
    planDigest: null,
    adapter: {
      id: adapterId,
      version: "1.5.0",
      hash: adapterHash,
    },
    operation: operationId,
    risk: "R1",
    inputHash,
    auth,
    transport: "web-session-api",
    webSessionContractHash: contractHash,
    status: "succeeded",
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
    startedAt: "2026-08-22T15:00:00.000Z",
    finishedAt: "2026-08-22T15:00:01.000Z",
    finalOrigin: "https://public.api.bsky.app",
    error: null,
  };
}

function localReceipt(): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 7,
    runId: "00000000-0000-4000-8000-000000000299",
    planDigest: null,
    adapter: {
      id: localAdapterId,
      version: "2.0.0",
      hash: adapterHash,
    },
    operation: localOperationId,
    risk: "R1",
    inputHash: sha256("{}"),
    auth: {
      id: localAuthId,
      hash: localAuthHash,
      kind: "linked-device-store",
    },
    transport: "local-cli",
    localCliContract: localContract,
    status: "succeeded",
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
    startedAt: "2026-08-26T15:00:00.000Z",
    finishedAt: "2026-08-26T15:00:01.000Z",
    finalOrigin: "https://www.beeper.com",
    error: null,
  };
}

function liveEnvelope(selectedReceipt: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    ok: true,
    source: "live",
    status: "succeeded",
    runId: selectedReceipt.runId,
    replayed: false,
    receipt: selectedReceipt,
    output: { metrics: { followers: { value: 52 } } },
    cache: { status: "error", message: "fixture cache unavailable" },
  });
}

const invokeArguments: Array<readonly string[]> = [];
let liveInvocation = 0;
let syncLiveEnabled = false;
let localMode = false;
let localCatalogSurfaceMismatch = false;

await mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: ((
    _command: string,
    arguments_: readonly string[],
    options: { readonly input?: unknown },
  ) => {
    if (arguments_[1] === "capabilities") {
      return {
        status: 0,
        stdout: localMode ? localCatalogEnvelope() : catalogEnvelope(),
        stderr: "",
      };
    }
    invokeArguments.push(arguments_);
    if (options.input !== (localMode ? "{}" : canonicalInput)) {
      throw new Error("public client command changed its canonical input");
    }
    if (arguments_.includes("--preview")) {
      return {
        status: 0,
        stdout: localMode ? localPreviewEnvelope() : previewEnvelope(),
        stderr: "",
      };
    }
    if (arguments_.includes("--projection-identity-only")) {
      return {
        status: 0,
        stdout: localMode
          ? localProjectionIdentityEnvelope()
          : projectionIdentityEnvelope(),
        stderr: "",
      };
    }
    if (localMode) {
      return {
        status: 0,
        stdout: liveEnvelope(localReceipt()),
        stderr: "",
      };
    }
    if (syncLiveEnabled) {
      return {
        status: 0,
        stdout: liveEnvelope(receipt(
          { id: authority.id, hash: authorityHash, kind: authority.kind },
          "00000000-0000-4000-8000-000000000199",
        )),
        stderr: "",
      };
    }
    return { status: 3, stdout: cacheMissEnvelope(), stderr: "" };
  }) as unknown as typeof childProcess.spawnSync,
  spawn: ((
    _command: string,
    arguments_: readonly string[],
  ) => {
    invokeArguments.push(arguments_);
    const index = liveInvocation;
    liveInvocation += 1;
    const selectedAuth = index === 1
      ? { id: "public-tampered", hash: authorityHash, kind: authority.kind }
      : index === 2
        ? { id: authority.id, hash: "d".repeat(64), kind: authority.kind }
        : { id: authority.id, hash: authorityHash, kind: authority.kind };
    return responseChild(liveEnvelope(receipt(
      selectedAuth,
      `00000000-0000-4000-8000-00000000010${String(index)}`,
    )));
  }) as unknown as typeof childProcess.spawn,
}));

const {
  invokeCapability,
  invokeCapabilitySync,
  revalidateCapability,
} = await import("./client");

const request = { adapterId, operationId, input } as const;
const result = await revalidateCapability(request);
if (
  result.live.status !== "succeeded"
  || result.live.receipt.auth.id !== authority.id
  || result.live.receipt.auth.hash !== authorityHash
  || result.live.receipt.auth.kind !== authority.kind
  || result.live.output === null
) {
  throw new Error(`public client result was malformed: ${JSON.stringify(result)}`);
}

for (const expectedMessage of [
  "Wrench live receipt auth does not match its request",
  "Wrench live receipt public authority is malformed",
] as const) {
  let message = "";
  try {
    await revalidateCapability(request);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message !== expectedMessage) {
    throw new Error(
      `public client accepted malformed authority: ${JSON.stringify({ message, expectedMessage })}`,
    );
  }
}

syncLiveEnabled = true;
const synchronous = invokeCapabilitySync(request);
syncLiveEnabled = false;
if (
  synchronous.status !== "succeeded"
  || synchronous.receipt.runId !== "00000000-0000-4000-8000-000000000199"
  || synchronous.output === null
) throw new Error("synchronous invocation did not return its validated live envelope");

const asynchronous = await invokeCapability(request);
if (
  asynchronous.status !== "succeeded"
  || asynchronous.receipt.auth.id !== authority.id
  || asynchronous.output === null
) {
  throw new Error("asynchronous invocation did not return its validated live envelope");
}

if (
  invokeArguments.length === 0
  || invokeArguments.some((arguments_) => arguments_.includes("--auth"))
  || invokeArguments.some((arguments_) => (
    arguments_[2] !== adapterId || arguments_[3] !== operationId
  ))
) {
  throw new Error(
    `public client did not preserve absent auth: ${JSON.stringify(invokeArguments)}`,
  );
}

const publicArgumentCount = invokeArguments.length;
localMode = true;
const local = invokeCapabilitySync({
  adapterId: localAdapterId,
  operationId: localOperationId,
  authId: localAuthId,
  input: {},
});
if (
  local.receipt.schemaVersion !== 7
  || local.receipt.transport !== "local-cli"
  || local.receipt.localCliContract.action !== localOperationId
  || local.receipt.localCliContract.surface !== localSurfaceId
  || local.receipt.localCliContract.version !== 1_000_000
  || local.receipt.localCliContract.tool.version !== " release stable "
  || local.output === null
) throw new Error("public client changed the canonical local CLI identity");
const localArguments = invokeArguments.slice(publicArgumentCount);
if (
  localArguments.length === 0
  || localArguments.some((arguments_) => !arguments_.includes("--auth"))
  || localArguments.some((arguments_) => !arguments_.includes(localAuthId))
) throw new Error("public client did not bind the local CLI auth realm");

localCatalogSurfaceMismatch = true;
try {
  invokeCapabilitySync({
    adapterId: localAdapterId,
    operationId: localOperationId,
    authId: localAuthId,
    input: {},
  });
  throw new Error("public client accepted a mismatched local CLI catalog surface");
} catch (error) {
  if (
    !(error instanceof Error)
    || !error.message.includes("local CLI route is malformed")
  ) throw error;
}
localCatalogSurfaceMismatch = false;
localMode = false;

try {
  invokeCapabilitySync({
    adapterId: localAdapterId,
    operationId: "single",
    authId: localAuthId,
    input: {},
  });
  throw new Error("public client accepted a malformed semantic operation");
} catch (error) {
  if (
    !(error instanceof Error)
    || !error.message.includes("Wrench client operation ID is malformed")
  ) throw error;
}
