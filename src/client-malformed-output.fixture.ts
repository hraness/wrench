import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const cacheMiss = JSON.stringify({
  ok: false,
  source: "cache",
  status: "cache-miss",
  projection: { key: "a".repeat(64) },
});

function projectionIdentityEnvelope(
  key: string,
  validatedInputHash = inputHash("{}"),
  authHash = key,
  authIdentity = authHash,
): string {
  return JSON.stringify({
    ok: true,
    source: "projection-identity",
    status: "ready",
    authIdentity,
    authHash,
    inputHash: validatedInputHash,
    projection: { key },
  });
}

function unboundProjectionIdentityEnvelope(
  authIdentity: string,
  validatedInputHash = inputHash("{}"),
  authHash = digest,
): string {
  return JSON.stringify({
    ok: true,
    source: "projection-identity",
    status: "unbound",
    authIdentity,
    authHash,
    inputHash: validatedInputHash,
  });
}

function cachedEnvelope(
  key: string,
  account: string,
  metadata: {
    readonly dataRevision?: string;
    readonly validatedAt?: string;
    readonly runId?: string;
    readonly ageMs?: number;
    readonly freshness?: {
      readonly state: "fresh" | "stale" | "unclassified";
      readonly freshForMs: number | null;
    };
  } = {},
): string {
  return JSON.stringify({
    ok: true,
    source: "cache",
    status: "cached",
    projection: {
      key,
      dataRevision: metadata.dataRevision ?? key,
      createdAt: "2026-07-31T12:00:00.000Z",
      dataChangedAt: "2026-07-31T12:00:00.000Z",
      validatedAt: metadata.validatedAt ?? "2026-07-31T12:00:01.000Z",
      runId: metadata.runId ?? runId,
      ageMs: metadata.ageMs ?? 0,
      freshness: metadata.freshness
        ?? { state: "unclassified", freshForMs: null },
    },
    output: { account },
  });
}

function responseChild(
  response: string,
  observeInput: (input: string) => void,
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  const input: Buffer[] = [];
  stdin.on("data", (chunkValue: Buffer | string) => {
    input.push(Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue));
  });
  stdin.once("finish", () => {
    observeInput(Buffer.concat(input).toString("utf8"));
    stdout.end(response);
    stderr.end();
    queueMicrotask(() => child.emit("close", 0, null));
  });
  return child;
}

const runId = "00000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);
const inputHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex");
const commonReceipt = {
  runId,
  planDigest: null,
  adapter: { id: "x", version: "1.0.0", hash: digest },
  operation: "messaging.list",
  risk: "R1",
  inputHash: inputHash("{}"),
  auth: { id: "x-main", hash: digest, kind: "oauth-token-file" },
  status: "succeeded",
  dispatchStarted: false,
  dispatch: { planned: 0, started: 0, verified: 0 },
  startedAt: "2026-07-31T12:00:00.000Z",
  finishedAt: "2026-07-31T12:00:01.000Z",
  finalOrigin: "https://api.x.com",
  error: null,
} as const;
const portablePluginContract = {
  pluginId: "example-web",
  pluginVersion: "1.0.0",
  hostApiVersion: 1,
  bundleSha256: digest,
  manifestSha256: digest,
  adapterId: "x",
  transport: "provider-api",
  surfaceId: "x",
  operation: "messaging.list",
  contractVersion: 1,
  descriptorSha256: digest,
} as const;

function liveEnvelope(
  receipt: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    ok: receipt.status === "succeeded",
    source: "live",
    status: receipt.status,
    runId: receipt.runId,
    replayed: false,
    receipt,
    output: {},
    cache: receipt.status === "succeeded"
      ? { status: "error", message: "fixture cache unavailable" }
      : { status: "retained", reason: "live-read-failed" },
    ...overrides,
  });
}

function storedCacheOutcome(key: string): Record<string, unknown> {
  return {
    status: "stored",
    publication: {
      key,
      dataRevision: key,
      validatedAt: "2026-07-31T12:00:01.000Z",
      dataChangedAt: "2026-07-31T12:00:00.000Z",
      disposition: "changed",
    },
  };
}

const validReceipts: readonly Record<string, unknown>[] = [
  { ...commonReceipt, schemaVersion: 2, transport: "browser" },
  {
    ...commonReceipt,
    schemaVersion: 3,
    transport: "provider-api",
    providerContractHash: digest,
  },
  {
    ...commonReceipt,
    schemaVersion: 4,
    transport: "web-session-api",
    webSessionContractHash: digest,
  },
  {
    ...commonReceipt,
    schemaVersion: 5,
    transport: "reviewed-template-api",
    reviewedTemplateContractHash: digest,
  },
  {
    ...commonReceipt,
    schemaVersion: 6,
    transport: "portable-provider-plugin",
    portablePluginContract,
  },
];

function executionPreviewEnvelope(
  receipt: Record<string, unknown>,
): string {
  const adapter = receipt.adapter as typeof commonReceipt.adapter;
  const auth = receipt.auth as typeof commonReceipt.auth;
  const transport = receipt.transport;
  return JSON.stringify({
    ok: true,
    status: "preview",
    requiresConfirmation: false,
    adapter,
    operation: receipt.operation,
    risk: "R1",
    sideEffect: "read",
    input: {},
    auth: {
      id: auth.id,
      kind: auth.kind,
      realmFingerprint: auth.hash.slice(0, 16),
    },
    identityBinding: {
      status: "account-subject",
      subject: "12345",
      accountActor: "12345",
      requestedActor: null,
    },
    transport,
    ...(transport === "portable-provider-plugin"
      ? { portablePluginContract: receipt.portablePluginContract }
      : {}),
  });
}

function executionCatalogEnvelope(
  receipt: Record<string, unknown>,
): string {
  const adapter = receipt.adapter as typeof commonReceipt.adapter;
  const transport = receipt.transport;
  const operation = {
    id: receipt.operation,
    description: "Fixture read",
    risk: "R1",
    sideEffect: "read",
    idempotency: "safe",
    dedupeWindowMs: 0,
    transport,
    input: {},
    ...(transport === "provider-api"
      ? {
          provider: "x",
          providerAction: receipt.operation,
          providerContractVersion: 1,
          providerContractHash: receipt.providerContractHash,
          requiredScopeSets: [],
          coverage: "complete",
          implementation: "Fixture provider read",
        }
      : {}),
    ...(transport === "web-session-api"
      ? {
          site: "x",
          webSessionAction: receipt.operation,
          webSessionContractVersion: 1,
          webSessionContractHash: receipt.webSessionContractHash,
          state: "implemented",
          implementation: "Fixture web-session read",
        }
      : {}),
    ...(transport === "reviewed-template-api"
      ? {
          state: "implemented",
          reviewedTemplateContractVersion: 1,
          reviewedTemplateContractHash: receipt.reviewedTemplateContractHash,
          reviewedAt: "2026-07-31T12:00:00.000Z",
          evidenceSha256: digest,
          origin: "https://x.com",
        }
      : {}),
  };
  return JSON.stringify({
    ok: true,
    adapters: [{
      id: adapter.id,
      version: adapter.version,
      displayName: "Fixture adapter",
      surfaceId: transport === "reviewed-template-api" ? null : "x",
      origins: ["https://x.com"],
      manifestHash: adapter.hash,
      operations: [operation],
    }],
  });
}

const exactBoundaryReceipt = {
  ...validReceipts[1],
  status: "failed",
  error: "é".repeat(6_144),
};
const invalidReceipts: Record<string, unknown>[] = [
  { ...exactBoundaryReceipt, error: `${exactBoundaryReceipt.error}x` },
  { ...validReceipts[1], dispatchStarted: true },
  { ...validReceipts[1], dispatch: { planned: 1, started: 0, verified: 0 } },
  { ...validReceipts[1], risk: "R2" },
  { ...validReceipts[1], planDigest: digest },
  { ...validReceipts[1], status: "pending" },
  { ...validReceipts[1], schemaVersion: 2 },
  { ...validReceipts[1], schemaVersion: 8 },
  { ...validReceipts[1], providerContractHash: "bad" },
  { ...validReceipts[2], webSessionContractHash: "bad" },
  { ...validReceipts[3], reviewedTemplateContractHash: "bad" },
  {
    ...validReceipts[4],
    portablePluginContract: { ...portablePluginContract, descriptorSha256: "bad" },
  },
  {
    ...validReceipts[4],
    portablePluginContract: { ...portablePluginContract, adapterId: "other" },
  },
  {
    ...validReceipts[4],
    portablePluginContract: { ...portablePluginContract, operation: "posts.read" },
  },
  {
    ...validReceipts[1],
    adapter: { ...commonReceipt.adapter, id: "other" },
  },
  { ...validReceipts[1], operation: "posts.read" },
  {
    ...validReceipts[1],
    auth: { ...commonReceipt.auth, id: "other" },
  },
  { ...validReceipts[1], inputHash: "b".repeat(64) },
  { ...validReceipts[1], unexpected: true },
  {
    ...validReceipts[1],
    adapter: { ...commonReceipt.adapter, unexpected: true },
  },
  {
    ...validReceipts[1],
    auth: { ...commonReceipt.auth, unexpected: true },
  },
  {
    ...validReceipts[1],
    dispatch: { ...commonReceipt.dispatch, unexpected: true },
  },
];
for (const key of [
  "runId",
  "planDigest",
  "adapter",
  "operation",
  "risk",
  "inputHash",
  "auth",
  "status",
  "dispatchStarted",
  "dispatch",
  "startedAt",
  "finishedAt",
  "finalOrigin",
  "error",
] as const) {
  const missing: Record<string, unknown> = { ...validReceipts[1] };
  delete missing[key];
  invalidReceipts.push(missing);
}

const invalidLiveResponses = [
  ...invalidReceipts.map((receipt) => liveEnvelope(receipt)),
  liveEnvelope(validReceipts[1]!, { ok: false }),
  liveEnvelope(validReceipts[1]!, { status: "failed" }),
  liveEnvelope(validReceipts[1]!, {
    runId: "00000000-0000-4000-8000-000000000002",
  }),
  liveEnvelope(validReceipts[1]!, { unexpected: true }),
  liveEnvelope(validReceipts[1]!, { output: undefined }),
] as const;
const driftReceipt = {
  ...validReceipts[1],
  inputHash: inputHash('{"sequence":7}'),
};
type FixtureEnvironment = Readonly<Record<string, string | undefined>>;
type LiveResponse = string | ((environment: FixtureEnvironment) => string);
type CacheResponse = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr?: string;
};

const liveResponses: LiveResponse[] = [
  "{",
  liveEnvelope({ status: "succeeded", runId }),
  ...validReceipts.map((receipt) => liveEnvelope(receipt)),
  liveEnvelope(exactBoundaryReceipt),
  ...invalidLiveResponses,
  liveEnvelope(driftReceipt),
  liveEnvelope(driftReceipt),
];
let liveResponseIndex = 0;
const executionIdentityOverrides = new Map<number, Record<string, unknown>>(
  validReceipts.map((receipt, index) => [index + 2, receipt] as const),
);
const cacheInputs: string[] = [];
const identityInputs: string[] = [];
const previewInputs: string[] = [];
const liveInputs: string[] = [];
const cacheArguments: (readonly string[])[] = [];
const identityArguments: (readonly string[])[] = [];
const previewArguments: (readonly string[])[] = [];
const catalogArguments: (readonly string[])[] = [];
const liveArguments: (readonly string[])[] = [];
const cacheCwds: string[] = [];
const identityCwds: string[] = [];
const liveCwds: string[] = [];
const liveSignals: Array<AbortSignal | undefined> = [];
const cacheResponseOverrides: Array<
  CacheResponse | ((environment: FixtureEnvironment) => CacheResponse)
> = [];
const identityResponseOverrides: Array<
  CacheResponse | ((environment: FixtureEnvironment) => CacheResponse)
> = [];
const previewResponseOverrides: CacheResponse[] = [];

await mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: ((
    _command: string,
    arguments_: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: FixtureEnvironment;
      readonly signal?: AbortSignal;
    },
  ) => {
    liveArguments.push(arguments_);
    liveCwds.push(options.cwd ?? "");
    liveSignals.push(options.signal);
    const next = liveResponses[liveResponseIndex++] ?? liveResponses.at(-1)!;
    return responseChild(
      typeof next === "function" ? next(options.env ?? {}) : next,
      (input) => liveInputs.push(input),
    );
  }) as unknown as typeof childProcess.spawn,
  spawnSync: ((
    _command: string,
    arguments_: readonly string[],
    options: {
      readonly cwd?: string;
      readonly env?: FixtureEnvironment;
      readonly input?: unknown;
    },
  ) => {
    if (typeof options.input !== "string") {
      throw new Error("synchronous command did not receive string input");
    }
    const executionReceipt = executionIdentityOverrides.get(liveResponseIndex)
      ?? validReceipts[1]!;
    if (arguments_.includes("--preview")) {
      previewArguments.push(arguments_);
      previewInputs.push(options.input);
      const override = previewResponseOverrides.shift();
      return {
        status: override?.status ?? 0,
        stdout: override?.stdout
          ?? executionPreviewEnvelope(executionReceipt),
        stderr: override?.stderr ?? "",
      };
    }
    if (arguments_[1] === "capabilities") {
      catalogArguments.push(arguments_);
      return {
        status: 0,
        stdout: executionCatalogEnvelope(executionReceipt),
        stderr: "",
      };
    }
    if (arguments_.includes("--projection-identity-only")) {
      identityArguments.push(arguments_);
      identityCwds.push(options.cwd ?? "");
      identityInputs.push(options.input);
      const next = identityResponseOverrides.shift();
      const override = typeof next === "function"
        ? next(options.env ?? {})
        : next;
      return {
        status: override?.status ?? 0,
        stdout: override?.stdout
          ?? projectionIdentityEnvelope(digest, inputHash(options.input)),
        stderr: "",
      };
    }
    cacheArguments.push(arguments_);
    cacheCwds.push(options.cwd ?? "");
    cacheInputs.push(options.input);
    const next = cacheResponseOverrides.shift();
    const override = typeof next === "function"
      ? next(options.env ?? {})
      : next;
    return {
      status: override?.status ?? 3,
      stdout: override?.stdout ?? cacheMiss,
      stderr: "",
    };
  }) as unknown as typeof childProcess.spawnSync,
}));

const {
  readCachedCapability,
  revalidateCapability,
  staleWhileRevalidateCapability,
} = await import("./client");
async function invocationOutcome(): Promise<{
  readonly status: "resolved" | "rejected" | "timed-out";
  readonly message: string;
}> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    revalidateCapability({
      adapterId: "x",
      operationId: "messaging.list",
      authId: "x-main",
    }).then(
      () => ({ status: "resolved" as const, message: "" }),
      (error: unknown) => ({
        status: "rejected" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    new Promise<{ readonly status: "timed-out"; readonly message: string }>(
      (resolve) => {
        deadline = setTimeout(
          () => resolve({ status: "timed-out", message: "" }),
          1_000,
        );
      },
    ),
  ]);
  if (deadline !== undefined) clearTimeout(deadline);
  return outcome;
}

const outcome = await invocationOutcome();
if (
  outcome.status !== "rejected"
  || outcome.message !== "Wrench live response is malformed"
) {
  throw new Error(`unexpected malformed-output outcome: ${JSON.stringify(outcome)}`);
}

const malformedReceiptOutcome = await invocationOutcome();
if (
  malformedReceiptOutcome.status !== "rejected"
  || malformedReceiptOutcome.message
    !== "Wrench live receipt schema and transport are malformed"
) {
  throw new Error(
    `unexpected malformed-receipt outcome: ${JSON.stringify(malformedReceiptOutcome)}`,
  );
}

for (let index = 0; index < validReceipts.length + 1; index += 1) {
  const validOutcome = await invocationOutcome();
  if (validOutcome.status !== "resolved") {
    throw new Error(
      `unexpected valid-receipt outcome ${String(index)}: ${JSON.stringify(validOutcome)}`,
    );
  }
}

for (let index = 0; index < invalidLiveResponses.length; index += 1) {
  const invalidOutcome = await invocationOutcome();
  if (invalidOutcome.status !== "rejected") {
    throw new Error(
      `unexpected invalid-receipt outcome ${String(index)}: ${JSON.stringify(invalidOutcome)}`,
    );
  }
}

const snapshottedRequest = {
  adapterId: "x",
  operationId: "messaging.list",
  authId: "x-main",
  input: { sequence: 7 },
};
readCachedCapability(snapshottedRequest);
await revalidateCapability(snapshottedRequest);
const stale = staleWhileRevalidateCapability(snapshottedRequest);
await stale.revalidation;
const finalCacheInputs = cacheInputs.slice(-5);
const finalIdentityInputs = identityInputs.slice(-4);
const finalLiveInputs = liveInputs.slice(-2);
if (
  finalCacheInputs.some((input) => input !== '{"sequence":7}')
  || finalIdentityInputs.some((input) => input !== '{"sequence":7}')
  || finalLiveInputs.some((input) => input !== '{"sequence":7}')
) {
  throw new Error(`request snapshot drifted: ${JSON.stringify({ finalCacheInputs, finalIdentityInputs, finalLiveInputs })}`);
}
const commandRoute = (arguments_: readonly string[]): string =>
  JSON.stringify({
    adapterId: arguments_[2],
    operationId: arguments_[3],
    authId: arguments_[7],
  });
const finalCacheRoutes = cacheArguments.slice(-5).map(commandRoute);
const finalIdentityRoutes = identityArguments.slice(-4).map(commandRoute);
const finalLiveRoutes = liveArguments.slice(-2).map(commandRoute);
const expectedRoute = JSON.stringify({
  adapterId: "x",
  operationId: "messaging.list",
  authId: "x-main",
});
if (
  finalCacheRoutes.some((route) => route !== expectedRoute)
  || finalIdentityRoutes.some((route) => route !== expectedRoute)
  || finalLiveRoutes.some((route) => route !== expectedRoute)
) {
  throw new Error(`request route drifted: ${JSON.stringify({ finalCacheRoutes, finalIdentityRoutes, finalLiveRoutes })}`);
}

if (liveResponseIndex !== liveResponses.length) {
  throw new Error("live response fixture sequence did not settle before the account-swap checks");
}

const matrixFailedReceipt = {
  ...validReceipts[1],
  status: "failed",
  error: "fixture live failure",
};
const legalReceiptCachePairs = [
  {
    label: "succeeded/stored",
    response: liveEnvelope(validReceipts[1]!, {
      cache: storedCacheOutcome(digest),
    }),
  },
  {
    label: "succeeded/error",
    response: liveEnvelope(validReceipts[1]!, {
      cache: { status: "error", message: "cache unavailable" },
    }),
  },
  {
    label: "succeeded/skipped",
    response: liveEnvelope(validReceipts[1]!, {
      cache: { status: "skipped", reason: "auth-subject-unbound" },
    }),
  },
  {
    label: "failed/retained",
    response: liveEnvelope(matrixFailedReceipt, {
      cache: { status: "retained", reason: "live-read-failed" },
    }),
  },
  {
    label: "failed/miss",
    response: liveEnvelope(matrixFailedReceipt, {
      cache: { status: "miss", reason: "no-cached-snapshot" },
    }),
  },
  {
    label: "failed/error",
    response: liveEnvelope(matrixFailedReceipt, {
      cache: { status: "error", message: "cache unavailable" },
    }),
  },
  {
    label: "failed/skipped",
    response: liveEnvelope(matrixFailedReceipt, {
      cache: { status: "skipped", reason: "auth-subject-unbound" },
    }),
  },
] as const;
const stableUnboundAuthIdentity = "f".repeat(64);
for (const pair of legalReceiptCachePairs) {
  if (pair.label.endsWith("/skipped")) {
    identityResponseOverrides.push(
      {
        status: 0,
        stdout: unboundProjectionIdentityEnvelope(
          stableUnboundAuthIdentity,
        ),
      },
      {
        status: 0,
        stdout: unboundProjectionIdentityEnvelope(
          stableUnboundAuthIdentity,
        ),
      },
    );
  }
  liveResponses.push(pair.response);
  const pairOutcome = await invocationOutcome();
  if (pairOutcome.status !== "resolved") {
    throw new Error(
      `legal receipt/cache pair ${pair.label} was rejected: ${JSON.stringify(pairOutcome)}`,
    );
  }
}

const cacheCommandsBeforeStableUnbound = cacheArguments.length;
identityResponseOverrides.push(
  {
    status: 0,
    stdout: unboundProjectionIdentityEnvelope(stableUnboundAuthIdentity),
  },
  {
    status: 0,
    stdout: unboundProjectionIdentityEnvelope(stableUnboundAuthIdentity),
  },
);
liveResponses.push(liveEnvelope(validReceipts[1]!, {
  output: { account: "unbound-live" },
  cache: { status: "skipped", reason: "auth-subject-unbound" },
}));
const stableUnbound = await revalidateCapability({
  adapterId: "x",
  operationId: "messaging.list",
  authId: "x-main",
});
if (
  stableUnbound.cachedBefore !== null
  || stableUnbound.cachedAfter !== null
  || stableUnbound.cache.status !== "skipped"
  || stableUnbound.current?.source !== "live"
  || (stableUnbound.current.output as { readonly account?: unknown }).account
    !== "unbound-live"
  || cacheArguments.length !== cacheCommandsBeforeStableUnbound
) {
  throw new Error(
    `stable unbound live read crossed the projection cache: ${JSON.stringify(stableUnbound)}`,
  );
}

identityResponseOverrides.push(
  {
    status: 0,
    stdout: unboundProjectionIdentityEnvelope("1".repeat(64)),
  },
  {
    status: 0,
    stdout: unboundProjectionIdentityEnvelope("2".repeat(64)),
  },
);
liveResponses.push(liveEnvelope(validReceipts[1]!, {
  cache: { status: "skipped", reason: "auth-subject-unbound" },
}));
const swappedUnbound = await invocationOutcome();
if (
  swappedUnbound.status !== "rejected"
  || swappedUnbound.message
    !== "Wrench projection identity changed while revalidation was running; the live result was discarded"
) {
  throw new Error(
    `unbound auth incarnation drift was accepted: ${JSON.stringify(swappedUnbound)}`,
  );
}

const transformedRawInput = '{"attachment":"asset:one"}';
const transformedValidatedInputHash = inputHash(
  '{"attachment":{"kind":"file","reference":"asset:one"}}',
);
identityResponseOverrides.push(
  {
    status: 0,
    stdout: projectionIdentityEnvelope(
      digest,
      transformedValidatedInputHash,
    ),
  },
  {
    status: 0,
    stdout: projectionIdentityEnvelope(
      digest,
      transformedValidatedInputHash,
    ),
  },
);
liveResponses.push(liveEnvelope({
  ...validReceipts[1],
  inputHash: transformedValidatedInputHash,
}));
const transformedInputResult = await revalidateCapability({
  adapterId: "x",
  operationId: "messaging.list",
  authId: "x-main",
  input: { attachment: "asset:one" },
});
if (
  transformedInputResult.live.receipt.inputHash
    !== transformedValidatedInputHash
  || identityInputs.slice(-2).some((input) => input !== transformedRawInput)
  || cacheInputs.slice(-2).some((input) => input !== transformedRawInput)
  || liveInputs.at(-1) !== transformedRawInput
) {
  throw new Error(
    `validated file input hash was not bound to the raw request: ${JSON.stringify(transformedInputResult)}`,
  );
}

const illegalReceiptCachePairs = [
  {
    label: "succeeded/retained",
    response: liveEnvelope(validReceipts[1]!, {
      cache: { status: "retained", reason: "live-read-failed" },
    }),
  },
  {
    label: "succeeded/miss",
    response: liveEnvelope(validReceipts[1]!, {
      cache: { status: "miss", reason: "no-cached-snapshot" },
    }),
  },
  {
    label: "failed/stored",
    response: liveEnvelope(matrixFailedReceipt, {
      cache: storedCacheOutcome(digest),
    }),
  },
] as const;
for (const pair of illegalReceiptCachePairs) {
  liveResponses.push(pair.response);
  const pairOutcome = await invocationOutcome();
  if (
    pairOutcome.status !== "rejected"
    || pairOutcome.message
      !== "Wrench live cache outcome is inconsistent with its receipt"
  ) {
    throw new Error(
      `illegal receipt/cache pair ${pair.label} was accepted: ${JSON.stringify(pairOutcome)}`,
    );
  }
}

const accountAKey = "b".repeat(64);
const accountBKey = "c".repeat(64);
liveResponses.push(liveEnvelope({
  ...validReceipts[1],
  auth: { ...commonReceipt.auth, hash: accountAKey },
}, {
  output: { account: "A" },
  cache: storedCacheOutcome(accountAKey),
}));
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
);
cacheResponseOverrides.push(
  { status: 0, stdout: cachedEnvelope(accountAKey, "A") },
  { status: 0, stdout: cachedEnvelope(accountAKey, "A") },
);
const stableRevalidation = await invocationOutcome();
if (stableRevalidation.status !== "resolved") {
  throw new Error(
    `stable cross-process projection identity was rejected: ${JSON.stringify(stableRevalidation)}`,
  );
}

const accountBFailedReceipt = {
  ...validReceipts[1],
  auth: { ...commonReceipt.auth, hash: accountBKey },
  status: "failed",
  error: "provider unavailable",
};
liveResponses.push(liveEnvelope(accountBFailedReceipt));
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountBKey) },
);
cacheResponseOverrides.push(
  { status: 0, stdout: cachedEnvelope(accountAKey, "A") },
);
const swappedRevalidation = await invocationOutcome();
if (
  swappedRevalidation.status !== "rejected"
  || swappedRevalidation.message
    !== "Wrench projection identity changed while revalidation was running; the live result was discarded"
) {
  throw new Error(
    `cross-process revalidation mixed account identities: ${JSON.stringify(swappedRevalidation)}`,
  );
}

liveResponses.push(liveEnvelope(accountBFailedReceipt));
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
);
cacheResponseOverrides.push(
  { status: 0, stdout: cachedEnvelope(accountAKey, "A") },
);
const abaRevalidation = await invocationOutcome();
if (
  abaRevalidation.status !== "rejected"
  || abaRevalidation.message
    !== "Wrench projection identity changed while revalidation was running; the live result was discarded"
) {
  throw new Error(
    `cross-process A-to-B-to-A auth drift was accepted: ${JSON.stringify(abaRevalidation)}`,
  );
}

const accountBSucceededReceipt = {
  ...validReceipts[1],
  auth: { ...commonReceipt.auth, hash: accountBKey },
};
liveResponses.push(liveEnvelope(accountBSucceededReceipt, {
  output: { account: "B" },
  cache: storedCacheOutcome(accountBKey),
}));
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountBKey) },
);
cacheResponseOverrides.push(
  { status: 0, stdout: cachedEnvelope(accountAKey, "A") },
);
const swappedSWR = staleWhileRevalidateCapability({
  adapterId: "x",
  operationId: "messaging.list",
  authId: "x-main",
});
if (
  swappedSWR.cached?.status !== "hit"
  || (swappedSWR.cached.output as { readonly account?: unknown }).account !== "A"
) {
  throw new Error(`SWR did not expose the expected account-A snapshot: ${JSON.stringify(swappedSWR.cached)}`);
}
const swappedSWROutcome = await swappedSWR.revalidation.then(
  () => ({ status: "resolved" as const, message: "" }),
  (error: unknown) => ({
    status: "rejected" as const,
    message: error instanceof Error ? error.message : String(error),
  }),
);
if (
  swappedSWROutcome.status !== "rejected"
  || swappedSWROutcome.message
    !== "Wrench projection identity changed while revalidation was running; the live result was discarded"
) {
  throw new Error(
    `cross-process SWR mixed account identities: ${JSON.stringify(swappedSWROutcome)}`,
  );
}

const stateHomeA = "/tmp/wrench-client-environment-a";
const stateHomeB = "/tmp/wrench-client-environment-b";
const mutableEnvironment: Record<string, string | undefined> = {
  WRENCH_STATE_HOME: stateHomeA,
};
const firstAbort = new AbortController();
const secondAbort = new AbortController();
const mutableOptions = {
  environment: mutableEnvironment,
  freshForMs: 1_000,
  headed: false,
  now: new Date("2026-07-31T12:00:02.000Z"),
  signal: firstAbort.signal,
};
const accountAFailedReceipt = {
  ...validReceipts[1],
  auth: { ...commonReceipt.auth, hash: accountAKey },
  status: "failed",
  error: "account A provider unavailable",
};
liveResponses.push((environment) => {
  const observedStateHome = environment.WRENCH_STATE_HOME;
  mutableEnvironment.WRENCH_STATE_HOME = stateHomeA;
  if (observedStateHome === stateHomeA) {
    return liveEnvelope(accountAFailedReceipt);
  }
  if (observedStateHome === stateHomeB) {
    return liveEnvelope(accountBFailedReceipt);
  }
  throw new Error(`live process received an unexpected state home: ${String(observedStateHome)}`);
});
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
);
cacheResponseOverrides.push(
  (environment) => {
    if (environment.WRENCH_STATE_HOME !== stateHomeA) {
      throw new Error("pre-cache process did not receive account A's state home");
    }
    mutableEnvironment.WRENCH_STATE_HOME = stateHomeB;
    mutableOptions.freshForMs = 0;
    mutableOptions.headed = true;
    mutableOptions.now.setTime(new Date("2026-07-31T12:01:01.000Z").getTime());
    mutableOptions.signal = secondAbort.signal;
    return { status: 0, stdout: cachedEnvelope(accountAKey, "A") };
  },
  (environment) => {
    if (environment.WRENCH_STATE_HOME !== stateHomeA) {
      throw new Error("post-cache process did not retain account A's state home");
    }
    return { status: 0, stdout: cachedEnvelope(accountAKey, "A") };
  },
);
const environmentBound = await revalidateCapability({
  adapterId: "x",
  operationId: "messaging.list",
  authId: "x-main",
}, mutableOptions);
if (
  environmentBound.cachedBefore?.status !== "hit"
  || (environmentBound.cachedBefore.output as { readonly account?: unknown }).account !== "A"
  || environmentBound.cachedBefore.ageMs !== 1_000
  || environmentBound.cachedBefore.freshness.freshForMs !== 1_000
  || environmentBound.live.receipt.auth.hash !== accountAKey
  || environmentBound.cache.status !== "retained"
  || liveArguments.at(-1)?.includes("--headed") === true
  || liveSignals.at(-1) !== firstAbort.signal
) {
  throw new Error(
    `A-to-B-to-A environment drift crossed the process boundary: ${JSON.stringify(environmentBound)}`,
  );
}

const originalCwd = process.cwd();
const cwdFixtureRoot = mkdtempSync(join(tmpdir(), "wrench-client-cwd-"));
const initialCwd = join(cwdFixtureRoot, "initial");
const changedCwd = join(cwdFixtureRoot, "changed");
mkdirSync(initialCwd);
mkdirSync(changedCwd);
try {
  process.chdir(initialCwd);
  const snapshottedCwd = process.cwd();
  identityResponseOverrides.push(
    { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
    { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  );
  cacheResponseOverrides.push(
    () => {
      process.chdir(changedCwd);
      return {
        status: 0,
        stdout: cachedEnvelope(accountAKey, "initial-cwd"),
      };
    },
    {
      status: 0,
      stdout: cachedEnvelope(accountAKey, "initial-cwd"),
    },
  );
  liveResponses.push(liveEnvelope(accountAFailedReceipt, {
    cache: { status: "retained", reason: "live-read-failed" },
  }));
  const cwdBound = await revalidateCapability({
    adapterId: "x",
    operationId: "messaging.list",
    authId: "x-main",
  }, {
    environment: { WRENCH_STATE_HOME: "relative-state" },
  });
  if (
    cwdBound.cache.status !== "retained"
    || identityCwds.slice(-2).some((cwd) => cwd !== snapshottedCwd)
    || cacheCwds.slice(-2).some((cwd) => cwd !== snapshottedCwd)
    || liveCwds.at(-1) !== snapshottedCwd
  ) {
    throw new Error(
      `caller cwd drift split child state: ${JSON.stringify({ cwdBound, identityCwds: identityCwds.slice(-2), cacheCwds: cacheCwds.slice(-2), liveCwd: liveCwds.at(-1) })}`,
    );
  }
} finally {
  process.chdir(originalCwd);
  rmSync(cwdFixtureRoot, { recursive: true, force: true });
}

const publicRequest = {
  adapterId: "x",
  operationId: "messaging.list",
  authId: "x-main",
} as const;
const accountASucceededReceipt = {
  ...validReceipts[1],
  auth: { ...commonReceipt.auth, hash: accountAKey },
};
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
);
cacheResponseOverrides.push(
  { status: 2, stdout: "" },
  { status: 0, stdout: cachedEnvelope(accountAKey, "repaired") },
);
liveResponses.push(liveEnvelope(accountASucceededReceipt, {
  output: { account: "repaired" },
  cache: storedCacheOutcome(accountAKey),
}));
const repaired = await revalidateCapability(publicRequest);
if (
  repaired.cachedBefore !== null
  || repaired.cachedAfter?.status !== "hit"
  || (repaired.cachedAfter.output as { readonly account?: unknown }).account
    !== "repaired"
  || repaired.current?.source !== "cache"
  || (repaired.current.output as { readonly account?: unknown }).account
    !== "repaired"
  || repaired.cache.status !== "stored"
) {
  throw new Error(
    `corrupt pre-cache state did not preserve fenced live repair: ${JSON.stringify(repaired)}`,
  );
}

identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
);
cacheResponseOverrides.push(
  { status: 0, stdout: cachedEnvelope(accountAKey, "last-good") },
  { status: 0, stdout: cachedEnvelope(accountAKey, "last-good") },
);
liveResponses.push(liveEnvelope(accountAFailedReceipt, {
  output: { account: "failed-live" },
  cache: { status: "retained", reason: "live-read-failed" },
}));
const failedRefresh = await revalidateCapability(publicRequest);
if (
  failedRefresh.live.receipt.status !== "failed"
  || failedRefresh.cachedAfter?.status !== "hit"
  || (failedRefresh.cachedAfter.output as { readonly account?: unknown }).account
    !== "last-good"
  || failedRefresh.current?.source !== "cache"
  || (failedRefresh.current.output as { readonly account?: unknown }).account
    !== "last-good"
  || failedRefresh.cache.status !== "retained"
) {
  throw new Error(
    `failed refresh did not return the verified last-good projection: ${JSON.stringify(failedRefresh)}`,
  );
}

const currentDataRevision = "e".repeat(64);
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
);
cacheResponseOverrides.push(
  { status: 0, stdout: cachedEnvelope(accountAKey, "before") },
  { status: 0, stdout: cachedEnvelope(accountAKey, "newer-cache") },
);
liveResponses.push(liveEnvelope(accountASucceededReceipt, {
  output: { account: "older-live" },
  cache: {
    status: "stored",
    publication: {
      key: accountAKey,
      dataRevision: "d".repeat(64),
      validatedAt: "2026-07-31T12:00:01.000Z",
      dataChangedAt: "2026-07-31T12:00:00.000Z",
      disposition: "superseded",
      currentDataRevision,
    },
  },
}));
const laterStartWins = await revalidateCapability(publicRequest);
if (
  laterStartWins.cache.status !== "stored"
  || laterStartWins.cache.publication.disposition !== "superseded"
  || laterStartWins.cache.publication.currentDataRevision
    !== currentDataRevision
  || laterStartWins.cachedAfter?.status !== "hit"
  || (laterStartWins.cachedAfter.output as { readonly account?: unknown }).account
    !== "newer-cache"
  || laterStartWins.current?.source !== "cache"
  || (laterStartWins.current.output as { readonly account?: unknown }).account
    !== "newer-cache"
) {
  throw new Error(
    `superseded live completion hid the later-start projection: ${JSON.stringify(laterStartWins)}`,
  );
}

const concurrentRevision = "9".repeat(64);
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
);
cacheResponseOverrides.push(
  {
    status: 0,
    stdout: cachedEnvelope(accountAKey, "before-cache-error"),
  },
  {
    status: 0,
    stdout: cachedEnvelope(accountAKey, "concurrent-newer", {
      dataRevision: concurrentRevision,
      validatedAt: "2026-07-31T12:00:03.000Z",
      runId: "00000000-0000-4000-8000-000000000099",
    }),
  },
);
liveResponses.push(liveEnvelope(accountASucceededReceipt, {
  output: { account: "successful-live-with-cache-error" },
  cache: { status: "error", message: "publication unavailable" },
}));
const cacheErrorWithConcurrentAdvance = await revalidateCapability(
  publicRequest,
);
const beforeCacheError = cacheErrorWithConcurrentAdvance.cachedBefore;
const afterCacheError = cacheErrorWithConcurrentAdvance.cachedAfter;
const cacheAdvanced = beforeCacheError?.status === "hit"
  && afterCacheError?.status === "hit"
  && (
    afterCacheError.runId !== beforeCacheError.runId
    || afterCacheError.dataRevision !== beforeCacheError.dataRevision
    || afterCacheError.validatedAt !== beforeCacheError.validatedAt
  );
if (
  cacheErrorWithConcurrentAdvance.live.receipt.status !== "succeeded"
  || cacheErrorWithConcurrentAdvance.cache.status !== "error"
  || !cacheAdvanced
  || afterCacheError?.status !== "hit"
  || (afterCacheError.output as { readonly account?: unknown }).account
    !== "concurrent-newer"
  || cacheErrorWithConcurrentAdvance.current?.source !== "cache"
  || (
    cacheErrorWithConcurrentAdvance.current.output as {
      readonly account?: unknown;
    }
  ).account !== "concurrent-newer"
) {
  throw new Error(
    `cache-error refresh hid a concurrently advanced snapshot: ${JSON.stringify(cacheErrorWithConcurrentAdvance)}`,
  );
}

const liveCommandsBeforeCacheErrors = liveArguments.length;
const liveResponseIndexBeforeCacheErrors = liveResponseIndex;
const failingEnvironment: Record<string, string | undefined> = {
  WRENCH_STATE_HOME: stateHomeA,
};
const failBoundACache = (environment: FixtureEnvironment): CacheResponse => {
  if (environment.WRENCH_STATE_HOME !== stateHomeA) {
    throw new Error("failing pre-cache process was not bound to account A");
  }
  failingEnvironment.WRENCH_STATE_HOME = stateHomeB;
  return { status: 2, stdout: "" };
};
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountBKey) },
);
cacheResponseOverrides.push(failBoundACache);
liveResponses.push(liveEnvelope(accountBFailedReceipt));
let cacheErrorMessage = "";
try {
  await revalidateCapability(
    publicRequest,
    { environment: failingEnvironment },
  );
} catch (error) {
  cacheErrorMessage = error instanceof Error ? error.message : String(error);
}
if (
  cacheErrorMessage
    !== "Wrench projection identity changed while revalidation was running; the live result was discarded"
  || liveArguments.length !== liveCommandsBeforeCacheErrors + 1
  || liveResponseIndex !== liveResponseIndexBeforeCacheErrors + 1
) {
  throw new Error(
    `revalidation accepted bound-A cache failure with account-B live output: ${JSON.stringify({ cacheErrorMessage, liveCommands: liveArguments.length - liveCommandsBeforeCacheErrors, liveResponses: liveResponseIndex - liveResponseIndexBeforeCacheErrors })}`,
  );
}

failingEnvironment.WRENCH_STATE_HOME = stateHomeA;
identityResponseOverrides.push(
  { status: 0, stdout: projectionIdentityEnvelope(accountAKey) },
  { status: 0, stdout: projectionIdentityEnvelope(accountBKey) },
);
cacheResponseOverrides.push(failBoundACache);
liveResponses.push(liveEnvelope(accountBFailedReceipt));
const failedCacheSWR = staleWhileRevalidateCapability(
  publicRequest,
  { environment: failingEnvironment },
);
cacheErrorMessage = "";
try {
  await failedCacheSWR.revalidation;
} catch (error) {
  cacheErrorMessage = error instanceof Error ? error.message : String(error);
}
if (
  failedCacheSWR.cached !== null
  || cacheErrorMessage
    !== "Wrench projection identity changed while revalidation was running; the live result was discarded"
  || liveArguments.length !== liveCommandsBeforeCacheErrors + 2
  || liveResponseIndex !== liveResponseIndexBeforeCacheErrors + 2
) {
  throw new Error(
    `SWR accepted bound-A cache failure with account-B live output: ${JSON.stringify({ cacheErrorMessage, liveCommands: liveArguments.length - liveCommandsBeforeCacheErrors, liveResponses: liveResponseIndex - liveResponseIndexBeforeCacheErrors })}`,
  );
}

const executionFenceError =
  "Wrench execution identity changed while revalidation was running; the live result was discarded";
const stableExecutionAuthIdentity = "8".repeat(64);
const changedExecutionDigest = "7".repeat(64);
const providerExecutionIdentity = validReceipts[1]!;
const webSessionExecutionIdentity = validReceipts[2]!;
const reviewedTemplateExecutionIdentity = validReceipts[3]!;
const portableExecutionIdentity = validReceipts[4]!;
const executionFenceCases: readonly {
  readonly label: string;
  readonly expected: Record<string, unknown>;
  readonly receipt: Record<string, unknown>;
}[] = [
  {
    label: "adapter version",
    expected: providerExecutionIdentity,
    receipt: {
      ...providerExecutionIdentity,
      adapter: { ...commonReceipt.adapter, version: "2.0.0" },
    },
  },
  {
    label: "adapter hash",
    expected: providerExecutionIdentity,
    receipt: {
      ...providerExecutionIdentity,
      adapter: { ...commonReceipt.adapter, hash: changedExecutionDigest },
    },
  },
  {
    label: "receipt transport",
    expected: providerExecutionIdentity,
    receipt: webSessionExecutionIdentity,
  },
  {
    label: "provider contract",
    expected: providerExecutionIdentity,
    receipt: {
      ...providerExecutionIdentity,
      providerContractHash: changedExecutionDigest,
    },
  },
  {
    label: "web-session contract",
    expected: webSessionExecutionIdentity,
    receipt: {
      ...webSessionExecutionIdentity,
      webSessionContractHash: changedExecutionDigest,
    },
  },
  {
    label: "reviewed-template contract",
    expected: reviewedTemplateExecutionIdentity,
    receipt: {
      ...reviewedTemplateExecutionIdentity,
      reviewedTemplateContractHash: changedExecutionDigest,
    },
  },
  {
    label: "portable bundle contract",
    expected: portableExecutionIdentity,
    receipt: {
      ...portableExecutionIdentity,
      portablePluginContract: {
        ...portablePluginContract,
        bundleSha256: changedExecutionDigest,
      },
    },
  },
  {
    label: "portable descriptor contract",
    expected: portableExecutionIdentity,
    receipt: {
      ...portableExecutionIdentity,
      portablePluginContract: {
        ...portablePluginContract,
        descriptorSha256: changedExecutionDigest,
      },
    },
  },
];

for (const fixture of executionFenceCases) {
  const nextLiveIndex = liveResponses.length;
  executionIdentityOverrides.set(nextLiveIndex, fixture.expected);
  identityResponseOverrides.push(
    {
      status: 0,
      stdout: projectionIdentityEnvelope(
        accountAKey,
        inputHash("{}"),
        digest,
        stableExecutionAuthIdentity,
      ),
    },
    {
      status: 0,
      stdout: projectionIdentityEnvelope(
        accountAKey,
        inputHash("{}"),
        digest,
        stableExecutionAuthIdentity,
      ),
    },
  );
  cacheResponseOverrides.push({
    status: 0,
    stdout: cachedEnvelope(accountAKey, "cached-A"),
  });
  liveResponses.push(liveEnvelope(fixture.receipt, {
    output: { account: `private-B-${fixture.label}` },
    cache: { status: "error", message: "publication unavailable" },
  }));
  const cacheCommandsBefore = cacheArguments.length;
  const identityCommandsBefore = identityArguments.length;
  const liveCommandsBefore = liveArguments.length;
  let message = "";
  try {
    await revalidateCapability(publicRequest);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (
    message !== executionFenceError
    || cacheArguments.length !== cacheCommandsBefore + 1
    || identityArguments.length !== identityCommandsBefore + 2
    || liveArguments.length !== liveCommandsBefore + 1
  ) {
    throw new Error(
      `cache-error revalidation accepted ${fixture.label} B under A: ${JSON.stringify({ message, cacheCommands: cacheArguments.length - cacheCommandsBefore, identityCommands: identityArguments.length - identityCommandsBefore, liveCommands: liveArguments.length - liveCommandsBefore })}`,
    );
  }
}

const swrContractDriftReceipt = {
  ...providerExecutionIdentity,
  providerContractHash: changedExecutionDigest,
};
executionIdentityOverrides.set(
  liveResponses.length,
  providerExecutionIdentity,
);
identityResponseOverrides.push(
  {
    status: 0,
    stdout: projectionIdentityEnvelope(
      accountAKey,
      inputHash("{}"),
      digest,
      stableExecutionAuthIdentity,
    ),
  },
  {
    status: 0,
    stdout: projectionIdentityEnvelope(
      accountAKey,
      inputHash("{}"),
      digest,
      stableExecutionAuthIdentity,
    ),
  },
);
cacheResponseOverrides.push({
  status: 0,
  stdout: cachedEnvelope(accountAKey, "cached-A"),
});
liveResponses.push(liveEnvelope(swrContractDriftReceipt, {
  output: { account: "private-B-SWR" },
  cache: { status: "error", message: "publication unavailable" },
}));
const cacheCommandsBeforeExecutionSWR = cacheArguments.length;
const identityCommandsBeforeExecutionSWR = identityArguments.length;
const liveCommandsBeforeExecutionSWR = liveArguments.length;
const executionFencedSWR = staleWhileRevalidateCapability(publicRequest);
let executionSWRMessage = "";
try {
  await executionFencedSWR.revalidation;
} catch (error) {
  executionSWRMessage = error instanceof Error ? error.message : String(error);
}
if (
  executionFencedSWR.cached?.status !== "hit"
  || executionFencedSWR.cached.key !== accountAKey
  || (executionFencedSWR.cached.output as { readonly account?: unknown }).account
    !== "cached-A"
  || executionSWRMessage !== executionFenceError
  || cacheArguments.length !== cacheCommandsBeforeExecutionSWR + 1
  || identityArguments.length !== identityCommandsBeforeExecutionSWR + 2
  || liveArguments.length !== liveCommandsBeforeExecutionSWR + 1
) {
  throw new Error(
    `cache-error SWR accepted provider-contract B under A: ${JSON.stringify({ cached: executionFencedSWR.cached, executionSWRMessage, cacheCommands: cacheArguments.length - cacheCommandsBeforeExecutionSWR, identityCommands: identityArguments.length - identityCommandsBeforeExecutionSWR, liveCommands: liveArguments.length - liveCommandsBeforeExecutionSWR })}`,
  );
}

const deferredPreflightError = "fixture execution identity unavailable";
previewResponseOverrides.push({
  status: 3,
  stdout: "",
  stderr: deferredPreflightError,
});
cacheResponseOverrides.push({
  status: 0,
  stdout: cachedEnvelope(accountAKey, "immediate-cached-A"),
});
const cacheCommandsBeforeImmediateSWR = cacheArguments.length;
const previewCommandsBeforeImmediateSWR = previewArguments.length;
const catalogCommandsBeforeImmediateSWR = catalogArguments.length;
const identityCommandsBeforeImmediateSWR = identityArguments.length;
const liveCommandsBeforeImmediateSWR = liveArguments.length;
const immediateSWR = staleWhileRevalidateCapability(publicRequest);
if (
  immediateSWR.cached?.status !== "hit"
  || immediateSWR.cached.key !== accountAKey
  || (immediateSWR.cached.output as { readonly account?: unknown }).account
    !== "immediate-cached-A"
  || cacheArguments.length !== cacheCommandsBeforeImmediateSWR + 1
  || previewArguments.length !== previewCommandsBeforeImmediateSWR
  || catalogArguments.length !== catalogCommandsBeforeImmediateSWR
  || identityArguments.length !== identityCommandsBeforeImmediateSWR
  || liveArguments.length !== liveCommandsBeforeImmediateSWR
) {
  throw new Error(
    `SWR blocked its immediate cache result behind preflight: ${JSON.stringify({ cached: immediateSWR.cached, cacheCommands: cacheArguments.length - cacheCommandsBeforeImmediateSWR, previewCommands: previewArguments.length - previewCommandsBeforeImmediateSWR, catalogCommands: catalogArguments.length - catalogCommandsBeforeImmediateSWR, identityCommands: identityArguments.length - identityCommandsBeforeImmediateSWR, liveCommands: liveArguments.length - liveCommandsBeforeImmediateSWR })}`,
  );
}
let deferredPreflightMessage = "";
try {
  await immediateSWR.revalidation;
} catch (error) {
  deferredPreflightMessage = error instanceof Error
    ? error.message
    : String(error);
}
if (
  deferredPreflightMessage !== deferredPreflightError
  || immediateSWR.cached?.status !== "hit"
  || (immediateSWR.cached.output as { readonly account?: unknown }).account
    !== "immediate-cached-A"
  || previewArguments.length !== previewCommandsBeforeImmediateSWR + 1
  || catalogArguments.length !== catalogCommandsBeforeImmediateSWR
  || identityArguments.length !== identityCommandsBeforeImmediateSWR
  || liveArguments.length !== liveCommandsBeforeImmediateSWR
) {
  throw new Error(
    `SWR preflight failure suppressed its valid cache result: ${JSON.stringify({ deferredPreflightMessage, cached: immediateSWR.cached, previewCommands: previewArguments.length - previewCommandsBeforeImmediateSWR, catalogCommands: catalogArguments.length - catalogCommandsBeforeImmediateSWR, identityCommands: identityArguments.length - identityCommandsBeforeImmediateSWR, liveCommands: liveArguments.length - liveCommandsBeforeImmediateSWR })}`,
  );
}

previewResponseOverrides.push({
  status: 3,
  stdout: "",
  stderr: deferredPreflightError,
});
const cacheCommandsBeforeDeferredRevalidate = cacheArguments.length;
const previewCommandsBeforeDeferredRevalidate = previewArguments.length;
const identityCommandsBeforeDeferredRevalidate = identityArguments.length;
const liveCommandsBeforeDeferredRevalidate = liveArguments.length;
const deferredRevalidate = revalidateCapability(publicRequest);
if (
  cacheArguments.length !== cacheCommandsBeforeDeferredRevalidate
  || previewArguments.length !== previewCommandsBeforeDeferredRevalidate
  || identityArguments.length !== identityCommandsBeforeDeferredRevalidate
  || liveArguments.length !== liveCommandsBeforeDeferredRevalidate
) {
  throw new Error(
    "revalidateCapability ran a subprocess before returning its promise",
  );
}
let deferredRevalidateMessage = "";
try {
  await deferredRevalidate;
} catch (error) {
  deferredRevalidateMessage = error instanceof Error
    ? error.message
    : String(error);
}
if (
  deferredRevalidateMessage !== deferredPreflightError
  || cacheArguments.length !== cacheCommandsBeforeDeferredRevalidate
  || previewArguments.length !== previewCommandsBeforeDeferredRevalidate + 1
  || identityArguments.length !== identityCommandsBeforeDeferredRevalidate
  || liveArguments.length !== liveCommandsBeforeDeferredRevalidate
) {
  throw new Error(
    `revalidateCapability did not defer its failing preflight: ${JSON.stringify({ deferredRevalidateMessage, cacheCommands: cacheArguments.length - cacheCommandsBeforeDeferredRevalidate, previewCommands: previewArguments.length - previewCommandsBeforeDeferredRevalidate, identityCommands: identityArguments.length - identityCommandsBeforeDeferredRevalidate, liveCommands: liveArguments.length - liveCommandsBeforeDeferredRevalidate })}`,
  );
}

cacheResponseOverrides.push(() => ({
  status: 0,
  stdout: cachedEnvelope(accountAKey, "threshold-cache", {
    validatedAt: new Date().toISOString(),
    ageMs: 1,
    freshness: { state: "stale", freshForMs: 0 },
  }),
}));
const thresholdCache = readCachedCapability(publicRequest, {
  freshForMs: 0,
});
if (
  thresholdCache.status !== "hit"
  || thresholdCache.ageMs !== 1
  || thresholdCache.freshness.state !== "stale"
  || thresholdCache.freshness.freshForMs !== 0
) {
  throw new Error(
    `cache freshness disagreed with its returned age: ${JSON.stringify(thresholdCache)}`,
  );
}
