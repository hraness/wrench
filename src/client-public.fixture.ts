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

await mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: ((
    _command: string,
    arguments_: readonly string[],
    options: { readonly input?: unknown },
  ) => {
    if (arguments_[1] === "capabilities") {
      return { status: 0, stdout: catalogEnvelope(), stderr: "" };
    }
    invokeArguments.push(arguments_);
    if (options.input !== canonicalInput) {
      throw new Error("public client command changed its canonical input");
    }
    if (arguments_.includes("--preview")) {
      return { status: 0, stdout: previewEnvelope(), stderr: "" };
    }
    if (arguments_.includes("--projection-identity-only")) {
      return { status: 0, stdout: projectionIdentityEnvelope(), stderr: "" };
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
  result.live.receipt.auth.id !== authority.id
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
  synchronous.receipt.runId !== "00000000-0000-4000-8000-000000000199"
  || synchronous.output === null
) throw new Error("synchronous invocation did not return its validated live envelope");

const asynchronous = await invokeCapability(request);
if (asynchronous.receipt.auth.id !== authority.id || asynchronous.output === null) {
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
