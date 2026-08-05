import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { canonicalJson, sha256 } from "./canonical-json";
import type { OmniViewRequest, OmniViewV1 } from "./omni-client-types";

type SyncResponse = {
  readonly status: number;
  readonly stdout: unknown;
  readonly stderr?: unknown;
};
type WaitForAbortResponse = { readonly waitForAbort: true };
type LiveResponse = string | WaitForAbortResponse;

type FixtureIdentity = Readonly<{
  invocationDigest: string;
  requestDigest: string;
  sourceSetDigest: string;
}>;

function fixtureIdentity(
  invocation: string,
  sourceCharacter: string,
): FixtureIdentity {
  const request = JSON.parse(invocation) as {
    page?: { cursor?: string; limit: number };
    [key: string]: unknown;
  };
  if (request.page !== undefined) delete request.page.cursor;
  return Object.freeze({
    invocationDigest: sha256(invocation),
    requestDigest: sha256(canonicalJson(request)),
    sourceSetDigest: sourceCharacter.repeat(64),
  });
}
const exactDataRevision = "e".repeat(64);
const timestamp = "2026-08-01T12:00:00.000Z";
const emptyInputHash = sha256(canonicalJson({}));

function localCursor(byte: number): string {
  return `smn1.${Buffer.alloc(29, byte).toString("base64url")}`;
}

function view(viewRevisionCharacter: string, body: string) {
  const semantic = Object.freeze({
    kind: "notification" as const,
    providerId: "notice-1",
    providerRevision: "provider-revision-1",
    orderedAt: timestamp,
    actor: null,
    subject: "Fixture notification",
    body,
    unread: true,
    context: "inbox",
    id: "f".repeat(64),
    source: Object.freeze({
      surfaceId: "reddit",
      authId: "reddit-main",
      providerId: "notice-1",
    }),
    conversationId: null,
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    viewRevision: viewRevisionCharacter.repeat(64),
    entities: Object.freeze([Object.freeze({
      ...semantic,
      revision: sha256(canonicalJson(semantic)),
    })]),
    nextCursor: null,
    sources: Object.freeze([Object.freeze({
      adapterId: "reddit-web",
      operationId: "messaging.list" as const,
      authId: "reddit-main",
      requestInputHash: emptyInputHash,
      projectionInputHash: emptyInputHash,
      normalizationDataRevision: "9".repeat(64),
      surfaceId: "reddit",
      exact: Object.freeze({
        state: "hit" as const,
        key: "2".repeat(64),
        dataRevision: exactDataRevision,
        validatedAt: timestamp,
        ageMs: 0,
        freshness: Object.freeze({
          state: "unclassified" as const,
          freshForMs: null,
        }),
      }),
      normalization: Object.freeze({
        state: "current" as const,
        exactQueryKey: "2".repeat(64),
        exactDataRevision,
        lastGoodAt: timestamp,
      }),
      coverage: Object.freeze({
        state: "observed" as const,
        kind: "complete" as const,
        continuation: "none" as const,
        reason: null,
      }),
    })]),
  });
}

function messageView(
  viewRevisionCharacter: string,
  bodyTruncated?: boolean,
) {
  const base = view(viewRevisionCharacter, "unused notification body");
  const semantic = Object.freeze({
    kind: "message" as const,
    providerId: "message-1",
    providerRevision: "provider-revision-1",
    orderedAt: timestamp,
    conversationProviderId: null,
    sender: null,
    recipients: Object.freeze([]),
    direction: "unknown" as const,
    subject: null,
    body: "bounded body",
    ...(bodyTruncated === undefined ? {} : { bodyTruncated }),
    unread: false,
    replyToProviderId: null,
    state: "active" as const,
    attachments: Object.freeze([]),
    id: "f".repeat(64),
    source: Object.freeze({
      surfaceId: "reddit",
      authId: "reddit-main",
      providerId: "message-1",
    }),
    conversationId: null,
  });
  return Object.freeze({
    ...base,
    entities: Object.freeze([Object.freeze({
      ...semantic,
      revision: sha256(canonicalJson(semantic)),
    })]),
  });
}

function envelope(
  source: "omni-cache" | "omni-live" | "omni-exact-cache",
  identity: FixtureIdentity,
  resultView: OmniViewV1 = view("3", "cached"),
): string {
  return JSON.stringify({
    ok: true,
    schemaVersion: 1,
    source,
    identity,
    view: resultView,
  });
}

function identityEnvelope(identity: FixtureIdentity): string {
  return JSON.stringify({
    ok: true,
    schemaVersion: 1,
    source: "omni-identity",
    identity,
    view: null,
  });
}

let responseCloseCount = 0;
let abortCloseCount = 0;
const childKillSignals: Array<NodeJS.Signals | number | undefined> = [];

function responseChild(
  response: string,
  code = 0,
  error = "",
): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals | number) => {
      childKillSignals.push(signal);
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  queueMicrotask(() => {
    stdout.end(response);
    stderr.end(error);
    queueMicrotask(() => {
      responseCloseCount += 1;
      child.emit("close", code, null);
    });
  });
  return child;
}

function abortableChild(): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: (signal?: NodeJS.Signals | number) => {
      childKillSignals.push(signal);
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        abortCloseCount += 1;
        child.emit("close", null, signal ?? "SIGTERM");
      });
      return true;
    },
  }) as unknown as ChildProcessWithoutNullStreams;
  return child;
}

const cacheResponses: SyncResponse[] = [];
const identityResponses: Array<SyncResponse | WaitForAbortResponse> = [];
const liveResponses: LiveResponse[] = [];
const cacheArguments: (readonly string[])[] = [];
const identityArguments: (readonly string[])[] = [];
const liveArguments: (readonly string[])[] = [];
const cacheInputs: string[] = [];
const identityInputs: string[] = [];
const liveInputs: string[] = [];

await mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync: ((
    _command: string,
    arguments_: readonly string[],
    options: { readonly input?: string },
  ) => {
    if (arguments_.includes("--identity-only")) {
      identityArguments.push(arguments_);
      identityInputs.push(options.input ?? "");
      const response = identityResponses.shift();
      if (response === undefined || "waitForAbort" in response) {
        throw new Error("missing synchronous identity fixture response");
      }
      return {
        status: response.status,
        stdout: response.stdout,
        stderr: response.stderr ?? "",
      };
    }
    if (!arguments_.includes("--cache-only")) {
      throw new Error(`unexpected synchronous command: ${JSON.stringify(arguments_)}`);
    }
    cacheArguments.push(arguments_);
    cacheInputs.push(options.input ?? "");
    const response = cacheResponses.shift();
    if (response === undefined) throw new Error("missing cache fixture response");
    return {
      status: response.status,
      stdout: response.stdout,
      stderr: response.stderr ?? "",
    };
  }) as unknown as typeof childProcess.spawnSync,
  spawn: ((
    _command: string,
    arguments_: readonly string[],
  ) => {
    let inputSink: string[];
    let child: ChildProcessWithoutNullStreams;
    if (arguments_.includes("--identity-only")) {
      identityArguments.push(arguments_);
      inputSink = identityInputs;
      const response = identityResponses.shift();
      if (response === undefined) {
        throw new Error("missing asynchronous identity fixture response");
      }
      if ("waitForAbort" in response) {
        child = abortableChild();
      } else {
        if (typeof response.stdout !== "string") {
          throw new Error("malformed asynchronous identity fixture response");
        }
        child = responseChild(
          response.stdout,
          response.status,
          typeof response.stderr === "string" ? response.stderr : "",
        );
      }
    } else if (arguments_.includes("--cache-only")) {
      cacheArguments.push(arguments_);
      inputSink = cacheInputs;
      const response = cacheResponses.shift();
      if (response === undefined || typeof response.stdout !== "string") {
        throw new Error("missing asynchronous cache fixture response");
      }
      child = responseChild(
        response.stdout,
        response.status,
        typeof response.stderr === "string" ? response.stderr : "",
      );
    } else {
      liveArguments.push(arguments_);
      inputSink = liveInputs;
      const response = liveResponses.shift();
      if (response === undefined) throw new Error("missing live fixture response");
      child = typeof response === "string"
        ? responseChild(response)
        : abortableChild();
    }
    const chunks: Buffer[] = [];
    let inputCaptured = false;
    const captureInput = () => {
      if (inputCaptured) return;
      inputCaptured = true;
      inputSink.push(Buffer.concat(chunks).toString("utf8"));
    };
    child.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stdin.on("finish", captureInput);
    child.on("close", captureInput);
    return child;
  }) as unknown as typeof childProcess.spawn,
}));

const {
  readCachedOmniView,
  revalidateOmniView,
  staleWhileRevalidateOmniView,
} = await import("./omni-client");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function syncError(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a synchronous failure");
}

async function asyncError(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected an asynchronous failure");
}

async function advanceUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 32 && !predicate(); attempt += 1) {
    await Promise.resolve();
  }
}

const fixtureSourceRequest = Object.freeze({
  adapterId: "reddit-web",
  operationId: "messaging.list" as const,
  authId: "reddit-main",
});
const request: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest],
  filter: { kinds: ["notification", "message"] },
  page: {},
};
const expectedRequest = canonicalJson({
  schemaVersion: 1,
  sources: [{
    adapterId: "reddit-web",
    operationId: "messaging.list",
    authId: "reddit-main",
    input: {},
  }],
  filter: { kinds: ["message", "notification"] },
  page: { limit: 100 },
});
const requestIdentityA = fixtureIdentity(expectedRequest, "b");
const requestIdentityB = fixtureIdentity(expectedRequest, "d");

cacheResponses.push({ status: 0, stdout: envelope("omni-cache", requestIdentityA) });
const cached = readCachedOmniView(request);
assert(cached.source === "omni-cache", "cache result lost its source");
assert(cached.view.entities[0]?.kind === "notification", "cache entity was not parsed");
const firstCacheArguments = cacheArguments[0];
assert(firstCacheArguments !== undefined, "cache command was not recorded");
assert(
  JSON.stringify(firstCacheArguments.slice(1)) === JSON.stringify([
    "omni",
    "read",
    "--input",
    "-",
    "--cache-only",
    "--json",
  ]),
  `cache command was wrong: ${JSON.stringify(firstCacheArguments)}`,
);
assert(cacheInputs.at(-1) === expectedRequest, "cache request was not sent over stdin");

cacheResponses.push({
  status: 0,
  stdout: envelope(
    "omni-cache",
    requestIdentityA,
    messageView("4", true),
  ),
});
const declaredMessage = readCachedOmniView(request).view.entities[0];
assert(
  declaredMessage?.kind === "message" && declaredMessage.bodyTruncated === true,
  "cache parser lost declared body truncation evidence",
);

cacheResponses.push({
  status: 0,
  stdout: envelope(
    "omni-cache",
    requestIdentityA,
    messageView("5"),
  ),
});
const legacyMessage = readCachedOmniView(request).view.entities[0];
assert(
  legacyMessage?.kind === "message"
  && !Object.hasOwn(legacyMessage, "bodyTruncated"),
  "cache parser forged body truncation evidence for a legacy entity",
);

cacheResponses.push({
  status: 0,
  stdout: envelope("omni-cache", Object.freeze({
    ...requestIdentityA,
    invocationDigest: "9".repeat(64),
  })),
});
assert(
  syncError(() => readCachedOmniView(request)).includes("exact canonical invocation"),
  "cache parser accepted a response for another full invocation",
);

cacheResponses.push({ status: 0, stdout: envelope("omni-cache", requestIdentityA) });
assert(
  syncError(() => readCachedOmniView({
    ...request,
    page: { cursor: localCursor(1) },
  })).includes("exact canonical invocation"),
  "cache parser accepted an envelope bound to another local cursor",
);

cacheResponses.push({
  status: 0,
  stdout: envelope("omni-cache", Object.freeze({
    ...requestIdentityA,
    requestDigest: "7".repeat(64),
  })),
});
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "cursor-independent canonical request",
  ),
  "cache parser accepted a forged semantic request digest",
);

const wrongSourceEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: { sources: Array<{ authId: string }> };
};
wrongSourceEnvelope.view.sources[0]!.authId = "another-account";
cacheResponses.push({ status: 0, stdout: JSON.stringify(wrongSourceEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes("requested source coordinates"),
  "cache parser accepted source status for another request coordinate",
);

const wrongRequestInputEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: { sources: Array<{ requestInputHash: string }> };
};
wrongRequestInputEnvelope.view.sources[0]!.requestInputHash = "6".repeat(64);
cacheResponses.push({ status: 0, stdout: JSON.stringify(wrongRequestInputEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes("requested source coordinates"),
  "cache parser accepted source status for another raw request input",
);

const normalizedInputEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: { sources: Array<{ projectionInputHash: string }> };
};
normalizedInputEnvelope.view.sources[0]!.projectionInputHash = "5".repeat(64);
cacheResponses.push({ status: 0, stdout: JSON.stringify(normalizedInputEnvelope) });
assert(
  readCachedOmniView(request).view.sources[0]?.projectionInputHash === "5".repeat(64),
  "cache parser confused provider-normalized input identity with request identity",
);

const wrongEntitySourceEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: {
    entities: Array<{
      revision: string;
      source: { surfaceId: string };
      [key: string]: unknown;
    }>;
  };
};
const wrongSourceEntity = wrongEntitySourceEnvelope.view.entities[0]!;
wrongSourceEntity.source.surfaceId = "another-surface";
wrongSourceEntity.revision = sha256(canonicalJson(Object.fromEntries(
  Object.entries(wrongSourceEntity).filter(([key]) => key !== "revision"),
)));
cacheResponses.push({ status: 0, stdout: JSON.stringify(wrongEntitySourceEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must belong to one returned requested source",
  ),
  "cache parser accepted an entity attributed to no returned source",
);

const malformedCoverageEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: {
    sources: Array<{ coverage: Record<string, unknown> }>;
  };
};
malformedCoverageEnvelope.view.sources[0]!.coverage = {
  state: "observed",
  kind: "first-page-only",
  continuation: "pending",
  reason: null,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(malformedCoverageEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must mark first-page-only continuation unavailable",
  ),
  "cache parser accepted executable continuation for first-page-only coverage",
);

const pendingCurrentEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ coverage: Record<string, unknown> }> };
};
pendingCurrentEnvelope.view.sources[0]!.coverage = {
  state: "observed",
  kind: "page",
  continuation: "pending",
  reason: "another private page is expected",
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(pendingCurrentEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "cannot be pending for current normalized state",
  ),
  "cache parser accepted pending coverage for current normalization",
);

const contradictoryFreshnessEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ exact: Record<string, unknown> }> };
};
contradictoryFreshnessEnvelope.view.sources[0]!.exact.ageMs = 1_000;
contradictoryFreshnessEnvelope.view.sources[0]!.exact.freshness = {
  state: "fresh",
  freshForMs: 0,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(contradictoryFreshnessEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "does not match the returned cache age",
  ),
  "cache parser accepted freshness that contradicted the returned age",
);

const exposedCursorEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: {
    sources: Array<{ coverage: Record<string, unknown> }>;
  };
};
exposedCursorEnvelope.view.sources[0]!.coverage.providerCursor = "secret-cursor";
cacheResponses.push({ status: 0, stdout: JSON.stringify(exposedCursorEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes("is not reviewed"),
  "cache parser accepted a provider cursor in the public coverage status",
);

const misorderedEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: {
    entities: Array<{
      id: string;
      providerId: string;
      orderedAt: string;
      revision: string;
      source: { providerId: string };
      [key: string]: unknown;
    }>;
  };
};
const olderEntity = misorderedEnvelope.view.entities[0]!;
const newerEntity = structuredClone(olderEntity);
newerEntity.id = "1".repeat(64);
newerEntity.providerId = "notice-2";
newerEntity.source.providerId = "notice-2";
newerEntity.orderedAt = "2026-08-02T12:00:00.000Z";
newerEntity.revision = sha256(canonicalJson(Object.fromEntries(
  Object.entries(newerEntity).filter(([key]) => key !== "revision"),
)));
misorderedEnvelope.view.entities.push(newerEntity);
cacheResponses.push({ status: 0, stdout: JSON.stringify(misorderedEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must use deterministic newest-first order",
  ),
  "cache parser accepted entities in non-canonical order",
);

const messageOnlyRequest: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest],
  filter: { kinds: ["message"] },
};
const messageOnlyInvocation = canonicalJson({
  schemaVersion: 1,
  sources: [{ ...fixtureSourceRequest, input: {} }],
  filter: { kinds: ["message"] },
});
cacheResponses.push({
  status: 0,
  stdout: envelope(
    "omni-cache",
    fixtureIdentity(messageOnlyInvocation, "b"),
  ),
});
assert(
  syncError(() => readCachedOmniView(messageOnlyRequest)).includes(
    "contains a kind excluded by the request",
  ),
  "cache parser accepted an entity excluded by the requested kind filter",
);

const conversationFilter = "c".repeat(64);
const conversationRequest: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest],
  filter: { conversationId: conversationFilter },
};
const conversationInvocation = canonicalJson({
  schemaVersion: 1,
  sources: [{ ...fixtureSourceRequest, input: {} }],
  filter: { conversationId: conversationFilter },
});
cacheResponses.push({
  status: 0,
  stdout: envelope(
    "omni-cache",
    fixtureIdentity(conversationInvocation, "b"),
  ),
});
assert(
  syncError(() => readCachedOmniView(conversationRequest)).includes(
    "outside the requested conversation",
  ),
  "cache parser accepted an entity excluded by the conversation filter",
);

const readRequest: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest],
  filter: { unread: false },
};
const readInvocation = canonicalJson({
  schemaVersion: 1,
  sources: [{ ...fixtureSourceRequest, input: {} }],
  filter: { unread: false },
});
cacheResponses.push({
  status: 0,
  stdout: envelope("omni-cache", fixtureIdentity(readInvocation, "b")),
});
assert(
  syncError(() => readCachedOmniView(readRequest)).includes(
    "outside the requested unread state",
  ),
  "cache parser accepted an entity excluded by the unread filter",
);

const oneEntityRequest: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest],
  page: { limit: 1 },
};
const oneEntityInvocation = canonicalJson({
  schemaVersion: 1,
  sources: [{ ...fixtureSourceRequest, input: {} }],
  page: { limit: 1 },
});
const tooManyEntities = structuredClone(view("8", "first")) as unknown as {
  entities: Array<{
    id: string;
    providerId: string;
    orderedAt: string;
    revision: string;
    source: { providerId: string };
    [key: string]: unknown;
  }>;
};
const secondEntity = structuredClone(tooManyEntities.entities[0]!);
secondEntity.id = "1".repeat(64);
secondEntity.providerId = "notice-2";
secondEntity.source.providerId = "notice-2";
secondEntity.orderedAt = "2026-07-31T12:00:00.000Z";
secondEntity.revision = sha256(canonicalJson(Object.fromEntries(
  Object.entries(secondEntity).filter(([key]) => key !== "revision"),
)));
tooManyEntities.entities.push(secondEntity);
cacheResponses.push({
  status: 0,
  stdout: envelope(
    "omni-cache",
    fixtureIdentity(oneEntityInvocation, "b"),
    tooManyEntities as never,
  ),
});
assert(
  syncError(() => readCachedOmniView(oneEntityRequest)).includes(
    "exceeds the requested page limit",
  ),
  "cache parser accepted more entities than the requested page limit",
);

const twoEntityRequest: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest],
  page: { limit: 2 },
};
const twoEntityInvocation = canonicalJson({
  schemaVersion: 1,
  sources: [{ ...fixtureSourceRequest, input: {} }],
  page: { limit: 2 },
});
const shortCursorView = structuredClone(view("8", "only")) as {
  nextCursor: string | null;
};
shortCursorView.nextCursor = localCursor(2);
cacheResponses.push({
  status: 0,
  stdout: envelope(
    "omni-cache",
    fixtureIdentity(twoEntityInvocation, "b"),
    shortCursorView as never,
  ),
});
assert(
  syncError(() => readCachedOmniView(twoEntityRequest)).includes(
    "requires a full requested page",
  ),
  "cache parser accepted a continuation cursor for a short page",
);

const providerCursorView = structuredClone(view("8", "only")) as {
  nextCursor: string | null;
};
providerCursorView.nextCursor = "provider-secret-cursor";
cacheResponses.push({
  status: 0,
  stdout: envelope(
    "omni-cache",
    fixtureIdentity(oneEntityInvocation, "b"),
    providerCursorView as never,
  ),
});
assert(
  syncError(() => readCachedOmniView(oneEntityRequest)).includes(
    "must be an authenticated local omni cursor",
  ),
  "cache parser accepted a provider cursor as a public local cursor",
);

const cacheCallsBeforeProviderCursorInput = cacheArguments.length;
assert(
  syncError(() => readCachedOmniView({
    ...oneEntityRequest,
    page: { limit: 1, cursor: "provider-secret-cursor" },
  })).includes("must be an authenticated local omni cursor"),
  "client accepted a provider cursor as a local request cursor",
);
assert(
  cacheArguments.length === cacheCallsBeforeProviderCursorInput,
  "malformed provider cursor input reached the child process",
);

const driftEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: {
    entities: Array<{
      revision: string;
      source: { surfaceId: string; authId: string };
      [key: string]: unknown;
    }>;
    sources: Array<{
      adapterId: string;
      authId: string;
      surfaceId: string;
      exact: Record<string, unknown>;
      normalization: Record<string, unknown>;
    }>;
  };
};
const driftEntity = driftEnvelope.view.entities[0]!;
driftEntity.source.surfaceId = "Reddit Inbox/v2";
const driftSemantic = Object.fromEntries(
  Object.entries(driftEntity).filter(([key]) => key !== "revision"),
);
driftEntity.revision = sha256(canonicalJson(driftSemantic));
const driftStatus = driftEnvelope.view.sources[0]!;
driftStatus.surfaceId = "Reddit Inbox/v2";
driftStatus.exact = {
  state: "error",
  key: "2".repeat(64),
  reason: "exact cache is unreadable",
};
driftStatus.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "2".repeat(64),
  reason: "provider response changed shape",
  failedExactDataRevision: exactDataRevision,
  newerExactDataRevision: null,
  lastGoodExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(driftEnvelope) });
const retained = readCachedOmniView(request);
assert(
  retained.view.sources[0]?.exact.state === "error"
  && retained.view.sources[0]?.normalization.state === "retained-after-drift"
  && retained.view.sources[0]?.normalization.lastGoodAt === timestamp,
  "runtime exact-error and retained-drift unions did not round trip",
);
assert(
  retained.view.entities[0]?.source.surfaceId === "Reddit Inbox/v2",
  "bounded non-kebab provider identity was rejected or rewritten",
);

const initialRootDriftEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: {
    entities: unknown[];
    sources: Array<{
      normalization: Record<string, unknown>;
      coverage: Record<string, unknown>;
    }>;
  };
};
initialRootDriftEnvelope.view.entities = [];
initialRootDriftEnvelope.view.sources[0]!.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "2".repeat(64),
  reason: "reviewed first observation drift",
  failedExactDataRevision: exactDataRevision,
  newerExactDataRevision: null,
  lastGoodExactDataRevision: null,
  lastGoodAt: null,
};
initialRootDriftEnvelope.view.sources[0]!.coverage = {
  state: "unavailable",
  reason: "no reviewed normalized page is available",
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(initialRootDriftEnvelope) });
const initialRootDrift = readCachedOmniView(request);
assert(
  initialRootDrift.view.sources[0]?.normalization.state
    === "retained-after-drift"
  && initialRootDrift.view.sources[0].normalization.lastGoodAt === null
  && initialRootDrift.view.sources[0].coverage.state === "unavailable",
  "initial root drift without retained coverage did not round trip",
);

const continuationDriftEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ normalization: Record<string, unknown> }> };
};
continuationDriftEnvelope.view.sources[0]!.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "4".repeat(64),
  reason: "a provider continuation changed shape",
  failedExactDataRevision: "5".repeat(64),
  newerExactDataRevision: null,
  lastGoodExactDataRevision: "6".repeat(64),
  lastGoodAt: timestamp,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(continuationDriftEnvelope) });
assert(
  readCachedOmniView(request).view.sources[0]?.normalization.state
    === "retained-after-drift",
  "continuation drift was incorrectly forced to match the root exact revision",
);

const unavailableStaleEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: {
    sources: Array<{
      normalization: Record<string, unknown>;
      coverage: Record<string, unknown>;
    }>;
  };
};
unavailableStaleEnvelope.view.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "4".repeat(64),
  exactDataRevision: null,
  normalizedExactDataRevision: null,
  lastGoodAt: null,
  reason: "the stored continuation chain could not be observed",
};
unavailableStaleEnvelope.view.sources[0]!.coverage = {
  state: "unavailable",
  reason: "stored continuation coverage is unavailable",
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(unavailableStaleEnvelope) });
const unavailableStale = readCachedOmniView(request);
assert(
  unavailableStale.view.sources[0]?.normalization.state === "stale"
  && unavailableStale.view.sources[0].coverage.state === "unavailable",
  "unavailable stale chain observation did not round trip",
);

const staleEnvelope = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: { sources: Array<{ normalization: Record<string, unknown> }> };
};
staleEnvelope.view.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "2".repeat(64),
  exactDataRevision: null,
  normalizedExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
  reason: "the exact snapshot advanced while normalization was retained",
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(staleEnvelope) });
const stale = readCachedOmniView(request);
assert(
  stale.view.sources[0]?.normalization.state === "stale"
  && stale.view.sources[0].normalization.exactDataRevision === null
  && stale.view.sources[0].normalization.normalizedExactDataRevision === exactDataRevision,
  "stale normalization status did not round trip",
);

const unpairedRetainedEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ normalization: Record<string, unknown> }> };
};
unpairedRetainedEnvelope.view.sources[0]!.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "4".repeat(64),
  reason: "reviewed structural drift",
  failedExactDataRevision: "5".repeat(64),
  newerExactDataRevision: null,
  lastGoodExactDataRevision: "6".repeat(64),
  lastGoodAt: null,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(unpairedRetainedEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must pair last-good revision and observation time",
  ),
  "cache parser accepted unpaired retained last-good evidence",
);

const unpairedStaleEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ normalization: Record<string, unknown> }> };
};
unpairedStaleEnvelope.view.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "4".repeat(64),
  exactDataRevision: null,
  normalizedExactDataRevision: "6".repeat(64),
  lastGoodAt: null,
  reason: "reviewed stale evidence",
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(unpairedStaleEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must pair normalized revision and observation time",
  ),
  "cache parser accepted unpaired stale last-good evidence",
);

const nonRootCurrentEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ normalization: Record<string, unknown> }> };
};
nonRootCurrentEnvelope.view.sources[0]!.normalization = {
  state: "current",
  exactQueryKey: "4".repeat(64),
  exactDataRevision,
  lastGoodAt: timestamp,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(nonRootCurrentEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must name the root exact query",
  ),
  "cache parser accepted current normalization for a continuation query",
);

const impossibleNewerDriftEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: {
    sources: Array<{
      exact: Record<string, unknown>;
      normalization: Record<string, unknown>;
    }>;
  };
};
impossibleNewerDriftEnvelope.view.sources[0]!.exact = {
  state: "error",
  key: "2".repeat(64),
  reason: "exact cache is unavailable",
};
impossibleNewerDriftEnvelope.view.sources[0]!.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "2".repeat(64),
  reason: "reviewed structural drift",
  failedExactDataRevision: exactDataRevision,
  newerExactDataRevision: "7".repeat(64),
  lastGoodExactDataRevision: null,
  lastGoodAt: null,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(impossibleNewerDriftEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "cannot name a newer current revision without an exact hit",
  ),
  "cache parser accepted a newer root exact revision without a root exact hit",
);

const duplicateDriftRevisionEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ normalization: Record<string, unknown> }> };
};
duplicateDriftRevisionEnvelope.view.sources[0]!.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "4".repeat(64),
  reason: "reviewed structural drift",
  failedExactDataRevision: "5".repeat(64),
  newerExactDataRevision: "5".repeat(64),
  lastGoodExactDataRevision: null,
  lastGoodAt: null,
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(duplicateDriftRevisionEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must differ from the failed exact revision",
  ),
  "cache parser accepted equal failed and newer drift revisions",
);

const unavailableCurrentEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ coverage: Record<string, unknown> }> };
};
unavailableCurrentEnvelope.view.sources[0]!.coverage = {
  state: "unavailable",
  reason: "coverage unavailable",
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(unavailableCurrentEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "cannot be unavailable for current normalized state",
  ),
  "cache parser accepted unavailable coverage for current normalization",
);

const missingCurrentRevisionEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ normalizationDataRevision: string | null }> };
};
missingCurrentRevisionEnvelope.view.sources[0]!.normalizationDataRevision = null;
cacheResponses.push({ status: 0, stdout: JSON.stringify(missingCurrentRevisionEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "is required while normalization is current",
  ),
  "cache parser accepted current normalization without a durable state revision",
);

const versionedUnsupportedEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: {
    sources: Array<{
      normalization: Record<string, unknown>;
      coverage: Record<string, unknown>;
    }>;
  };
};
versionedUnsupportedEnvelope.view.sources[0]!.normalization = {
  state: "unsupported",
  reason: "this operation has no reviewed materializer",
};
versionedUnsupportedEnvelope.view.sources[0]!.coverage = {
  state: "unavailable",
  reason: "this operation has no reviewed materializer",
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(versionedUnsupportedEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "must be null while normalization is unsupported",
  ),
  "cache parser accepted a durable normalized revision for unsupported state",
);

const observedMissingEnvelope = JSON.parse(envelope(
  "omni-cache",
  requestIdentityA,
)) as {
  view: { sources: Array<{ normalization: Record<string, unknown> }> };
};
observedMissingEnvelope.view.sources[0]!.normalization = { state: "missing" };
cacheResponses.push({ status: 0, stdout: JSON.stringify(observedMissingEnvelope) });
assert(
  syncError(() => readCachedOmniView(request)).includes(
    "cannot be observed while normalization is missing",
  ),
  "cache parser accepted observed coverage without normalized state",
);

const malformedExactError = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: { sources: Array<{ exact: Record<string, unknown> }> };
};
malformedExactError.view.sources[0]!.exact = {
  state: "error",
  key: "2".repeat(64),
};
cacheResponses.push({ status: 0, stdout: JSON.stringify(malformedExactError) });
assert(
  syncError(() => readCachedOmniView(request)).includes("must describe only the exact read error"),
  "cache parser accepted an exact error without its reason",
);

const swrRequest = {
  schemaVersion: 1 as const,
  sources: [{
    adapterId: "reddit-web",
    operationId: "messaging.list" as const,
    authId: "reddit-main",
  }],
};
const swrExpectedRequest = canonicalJson({
  schemaVersion: 1,
  sources: [{
    adapterId: "reddit-web",
    operationId: "messaging.list",
    authId: "reddit-main",
    input: {},
  }],
});
const swrIdentityA = fixtureIdentity(swrExpectedRequest, "b");
cacheResponses.push(
  { status: 0, stdout: envelope("omni-cache", swrIdentityA, view("4", "stable")) },
  { status: 0, stdout: envelope("omni-cache", swrIdentityA, view("4", "stable")) },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
);
const failedLiveView = JSON.parse(JSON.stringify(view("4", "stable"))) as {
  viewRevision: string;
  sources: Array<{ normalization: Record<string, unknown> }>;
};
failedLiveView.viewRevision = "4".repeat(64);
failedLiveView.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "2".repeat(64),
  exactDataRevision: null,
  normalizedExactDataRevision: exactDataRevision,
  reason: "provider revalidation failed",
  lastGoodAt: timestamp,
};
liveResponses.push(envelope("omni-live", swrIdentityA, failedLiveView as never));
const countsBeforeSWR = Object.freeze({
  cache: cacheArguments.length,
  identity: identityArguments.length,
  live: liveArguments.length,
});
const swr = staleWhileRevalidateOmniView(swrRequest);
assert(
  cacheArguments.length === countsBeforeSWR.cache + 1,
  "SWR did not synchronously run exactly one cache command",
);
assert(
  identityArguments.length === countsBeforeSWR.identity,
  "SWR ran an identity preflight before returning",
);
assert(
  liveArguments.length === countsBeforeSWR.live,
  "SWR ran a live command before returning",
);
swrRequest.sources[0]!.adapterId = "mutated-after-return";
const swrResult = await swr.revalidation;
assert(swrResult.current.source === "omni-live", "SWR did not retain live source status");
assert(
  swrResult.current.view.sources[0]?.normalization.state === "stale",
  "SWR current view hid the live provider failure status",
);
assert(
  identityArguments.slice(-2).every((arguments_) => arguments_[4] === "-")
  && liveArguments.at(-1)?.[4] === "-"
  && cacheArguments.slice(-2).every((arguments_) => arguments_[4] === "-")
  && identityInputs.slice(-2).every((input) => input === swrExpectedRequest)
  && liveInputs.at(-1) === swrExpectedRequest
  && cacheInputs.slice(-2).every((input) => input === swrExpectedRequest),
  `SWR request snapshot drifted after return: ${JSON.stringify({
    cacheArguments: cacheArguments.slice(-2),
    identityArguments: identityArguments.slice(-2),
    liveArguments: liveArguments.slice(-1),
    cacheInputs: cacheInputs.slice(-2),
    identityInputs: identityInputs.slice(-2),
    liveInputs: liveInputs.slice(-1),
    swrExpectedRequest,
  })}`,
);

const concurrentBeforeView = view("6", "concurrent");
const concurrentRequest: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest],
};
const concurrentAfterView = JSON.parse(JSON.stringify(concurrentBeforeView)) as {
  sources: Array<{
    exact: Record<string, unknown>;
    normalization: Record<string, unknown>;
    normalizationDataRevision: string | null;
  }>;
};
concurrentAfterView.sources[0]!.normalizationDataRevision = "8".repeat(64);
concurrentAfterView.sources[0]!.exact = {
  state: "error",
  key: "2".repeat(64),
  reason: "exact cache became unavailable",
};
concurrentAfterView.sources[0]!.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "2".repeat(64),
  reason: "reviewed concurrent structural drift",
  failedExactDataRevision: exactDataRevision,
  newerExactDataRevision: null,
  lastGoodExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
};
cacheResponses.push(
  {
    status: 0,
    stdout: envelope("omni-cache", swrIdentityA, concurrentBeforeView),
  },
  {
    status: 0,
    stdout: envelope(
      "omni-cache",
      swrIdentityA,
      concurrentAfterView as never,
    ),
  },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
);
liveResponses.push(envelope("omni-live", swrIdentityA, concurrentBeforeView));
const concurrentResult = await revalidateOmniView(concurrentRequest);
assert(
  concurrentResult.current.source === "omni-cache"
  && concurrentResult.current.view.sources[0]?.normalization.state
    === "retained-after-drift",
  "SWR current view ignored a later validated status with unchanged entities",
);

const whatsAppSourceRequest = Object.freeze({
  adapterId: "whatsapp-web",
  operationId: "messaging.list" as const,
  authId: "whatsapp-main",
});
const twoSourceRequest: OmniViewRequest = {
  schemaVersion: 1,
  sources: [fixtureSourceRequest, whatsAppSourceRequest],
};
const twoSourceInvocation = canonicalJson({
  schemaVersion: 1,
  sources: [
    { ...fixtureSourceRequest, input: {} },
    { ...whatsAppSourceRequest, input: {} },
  ],
});
const twoSourceIdentity = fixtureIdentity(twoSourceInvocation, "b");
const twoSourceBefore = structuredClone(view("1", "reddit-current")) as unknown as {
  entities: Array<{
    id: string;
    providerId: string;
    orderedAt: string;
    revision: string;
    source: { authId: string; providerId: string; surfaceId: string };
    [key: string]: unknown;
  }>;
  sources: Array<{
    adapterId: string;
    authId: string;
    exact: Record<string, unknown>;
    normalization: Record<string, unknown>;
    normalizationDataRevision: string | null;
    surfaceId: string;
  }>;
};
const whatsAppEntity = structuredClone(twoSourceBefore.entities[0]!);
whatsAppEntity.id = "0".repeat(64);
whatsAppEntity.providerId = "whatsapp-notice-1";
whatsAppEntity.orderedAt = "2026-07-31T12:00:00.000Z";
whatsAppEntity.source = {
  authId: "whatsapp-main",
  providerId: "whatsapp-notice-1",
  surfaceId: "whatsapp",
};
whatsAppEntity.revision = sha256(canonicalJson(Object.fromEntries(
  Object.entries(whatsAppEntity).filter(([key]) => key !== "revision"),
)));
twoSourceBefore.entities.push(whatsAppEntity);
const whatsAppStatus = structuredClone(twoSourceBefore.sources[0]!);
whatsAppStatus.adapterId = "whatsapp-web";
whatsAppStatus.authId = "whatsapp-main";
whatsAppStatus.surfaceId = "whatsapp";
whatsAppStatus.exact = {
  ...(whatsAppStatus.exact as { [key: string]: unknown }),
  key: "3".repeat(64),
};
whatsAppStatus.normalizationDataRevision = "6".repeat(64);
whatsAppStatus.normalization = {
  ...(whatsAppStatus.normalization as { [key: string]: unknown }),
  exactQueryKey: "3".repeat(64),
};
twoSourceBefore.sources.push(whatsAppStatus);
const twoSourceLive = structuredClone(twoSourceBefore);
twoSourceLive.sources[1]!.normalization = {
  state: "stale",
  exactQueryKey: "3".repeat(64),
  exactDataRevision: null,
  normalizedExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
  reason: "provider read failed before the normalized source could be refreshed",
};
const twoSourceAfter = structuredClone(twoSourceBefore);
twoSourceAfter.sources[0]!.exact = {
  state: "error",
  key: "2".repeat(64),
  reason: "exact provider snapshot could not be read",
};
twoSourceAfter.sources[0]!.normalizationDataRevision = "8".repeat(64);
twoSourceAfter.sources[0]!.normalization = {
  state: "retained-after-drift",
  exactQueryKey: "2".repeat(64),
  reason: "reddit messaging.list materializer reddit-inbox@1 rejected the exact provider shape",
  failedExactDataRevision: exactDataRevision,
  newerExactDataRevision: null,
  lastGoodExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
};
cacheResponses.push(
  {
    status: 0,
    stdout: envelope("omni-cache", twoSourceIdentity, twoSourceBefore as never),
  },
  {
    status: 0,
    stdout: envelope("omni-cache", twoSourceIdentity, twoSourceAfter as never),
  },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(twoSourceIdentity) },
  { status: 0, stdout: identityEnvelope(twoSourceIdentity) },
);
liveResponses.push(envelope(
  "omni-live",
  twoSourceIdentity,
  twoSourceLive as never,
));
const twoSourceResult = await revalidateOmniView(twoSourceRequest);
assert(
  twoSourceResult.current.source === "omni-merged"
  && twoSourceResult.current.view.sources[0]?.normalization.state
    === "retained-after-drift"
  && twoSourceResult.current.view.sources[1]?.normalization.state === "stale",
  "SWR erased one source's transient live failure while adopting another source's later head",
);

const threePageBefore = view("2", "three-page-current");
const threePageLive = structuredClone(threePageBefore) as unknown as {
  sources: Array<{ normalization: Record<string, unknown> }>;
};
threePageLive.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "4".repeat(64),
  exactDataRevision: null,
  normalizedExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
  reason: "the second provider page failed during live revalidation",
};
const threePageAfter = structuredClone(threePageBefore) as unknown as {
  sources: Array<{
    normalization: Record<string, unknown>;
    normalizationDataRevision: string | null;
  }>;
};
threePageAfter.sources[0]!.normalizationDataRevision = "8".repeat(64);
threePageAfter.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "5".repeat(64),
  exactDataRevision: "7".repeat(64),
  normalizedExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
  reason: "the third provider page exact snapshot advanced",
};
cacheResponses.push(
  { status: 0, stdout: envelope("omni-cache", swrIdentityA, threePageBefore) },
  {
    status: 0,
    stdout: envelope("omni-cache", swrIdentityA, threePageAfter as never),
  },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
);
liveResponses.push(envelope("omni-live", swrIdentityA, threePageLive as never));
const threePageResult = await revalidateOmniView(concurrentRequest);
assert(
  threePageResult.current.source === "omni-merged"
  && threePageResult.current.view.sources[0]?.normalization.state === "stale"
  && threePageResult.current.view.sources[0]?.normalization.exactQueryKey
    === "4".repeat(64),
  "SWR let one continuation's exact advance erase another continuation's live failure",
);

const advancedExactRevision = "a".repeat(64);
const advancedTimestamp = "2026-08-02T12:00:00.000Z";
const advancedRootBefore = view("a", "advanced-root");
const advancedRootLive = JSON.parse(JSON.stringify(advancedRootBefore)) as {
  sources: Array<{
    exact: Record<string, unknown>;
    normalization: Record<string, unknown>;
    normalizationDataRevision: string | null;
  }>;
};
advancedRootLive.sources[0]!.exact = {
  state: "hit",
  key: "2".repeat(64),
  dataRevision: advancedExactRevision,
  validatedAt: advancedTimestamp,
  ageMs: 0,
  freshness: { state: "unclassified", freshForMs: null },
};
advancedRootLive.sources[0]!.normalizationDataRevision = "7".repeat(64);
advancedRootLive.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "2".repeat(64),
  exactDataRevision: advancedExactRevision,
  normalizedExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
  reason: "a continuation failed after the root exact snapshot advanced",
};
const advancedRootAfter = structuredClone(advancedRootLive);
advancedRootAfter.sources[0]!.normalization = {
  state: "current",
  exactQueryKey: "2".repeat(64),
  exactDataRevision: advancedExactRevision,
  lastGoodAt: advancedTimestamp,
};
cacheResponses.push(
  { status: 0, stdout: envelope("omni-cache", swrIdentityA, advancedRootBefore) },
  {
    status: 0,
    stdout: envelope("omni-cache", swrIdentityA, advancedRootAfter as never),
  },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
);
liveResponses.push(envelope(
  "omni-live",
  swrIdentityA,
  advancedRootLive as never,
));
const advancedRootResult = await revalidateOmniView(concurrentRequest);
assert(
  advancedRootResult.current.source === "omni-live"
  && advancedRootResult.current.view.sources[0]?.normalization.state === "stale",
  "SWR hid a partial live failure behind the same durable advanced root head",
);

const exactErrorBefore = view("b", "exact-error-after");
const exactErrorAfter = JSON.parse(JSON.stringify(exactErrorBefore)) as {
  sources: Array<{
    exact: Record<string, unknown>;
    normalization: Record<string, unknown>;
  }>;
};
exactErrorAfter.sources[0]!.exact = {
  state: "error",
  key: "2".repeat(64),
  reason: "exact provider snapshot could not be read",
};
exactErrorAfter.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "2".repeat(64),
  exactDataRevision: null,
  normalizedExactDataRevision: exactDataRevision,
  lastGoodAt: timestamp,
  reason: "exact provider snapshot could not be read",
};
cacheResponses.push(
  { status: 0, stdout: envelope("omni-cache", swrIdentityA, exactErrorBefore) },
  {
    status: 0,
    stdout: envelope("omni-cache", swrIdentityA, exactErrorAfter as never),
  },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
);
liveResponses.push(envelope("omni-live", swrIdentityA, exactErrorBefore));
const exactErrorResult = await revalidateOmniView(concurrentRequest);
assert(
  exactErrorResult.current.source === "omni-live"
  && exactErrorResult.current.view.sources[0]?.exact.state === "hit",
  "SWR treated a cache-after exact read error as a later positive head",
);

const continuationBefore = view("c", "continuation-head");
const continuationAfter = JSON.parse(JSON.stringify(continuationBefore)) as {
  sources: Array<{ normalization: Record<string, unknown> }>;
};
continuationAfter.sources[0]!.normalization = {
  state: "stale",
  exactQueryKey: "4".repeat(64),
  exactDataRevision: "7".repeat(64),
  normalizedExactDataRevision: "6".repeat(64),
  lastGoodAt: timestamp,
  reason: "a provider continuation exact snapshot advanced",
};
cacheResponses.push(
  { status: 0, stdout: envelope("omni-cache", swrIdentityA, continuationBefore) },
  {
    status: 0,
    stdout: envelope("omni-cache", swrIdentityA, continuationAfter as never),
  },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
);
liveResponses.push(envelope("omni-live", swrIdentityA, continuationBefore));
const continuationResult = await revalidateOmniView(concurrentRequest);
assert(
  continuationResult.current.source === "omni-cache"
  && continuationResult.current.view.sources[0]?.normalization.state === "stale",
  "SWR ignored a later continuation exact head with unchanged root entities",
);

cacheResponses.push(
  { status: 1, stdout: "", stderr: "cache miss" },
  {
    status: 0,
    stdout: envelope("omni-cache", swrIdentityA, continuationAfter as never),
  },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
  { status: 0, stdout: identityEnvelope(swrIdentityA) },
);
liveResponses.push(envelope("omni-live", swrIdentityA, continuationBefore));
const initialMissResult = await revalidateOmniView(concurrentRequest);
assert(
  initialMissResult.cachedBefore === null
  && initialMissResult.current.source === "omni-cache",
  "SWR ignored a later positive exact head after an initial cache miss",
);

const pagedIdentity = fixtureIdentity(oneEntityInvocation, "b");
const pagedBefore = structuredClone(view("d", "paged")) as {
  nextCursor: string | null;
};
pagedBefore.nextCursor = localCursor(3);
const pagedAfter = structuredClone(pagedBefore) as {
  nextCursor: string | null;
  viewRevision: string;
};
pagedAfter.viewRevision = "f".repeat(64);
pagedAfter.nextCursor = localCursor(4);
cacheResponses.push(
  { status: 0, stdout: envelope("omni-cache", pagedIdentity, pagedBefore as never) },
  { status: 0, stdout: envelope("omni-cache", pagedIdentity, pagedAfter as never) },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(pagedIdentity) },
  { status: 0, stdout: identityEnvelope(pagedIdentity) },
);
liveResponses.push(envelope("omni-live", pagedIdentity, pagedBefore as never));
const pagedResult = await revalidateOmniView(oneEntityRequest);
assert(
  pagedResult.current.source === "omni-cache"
  && pagedResult.current.view.viewRevision === "f".repeat(64)
  && pagedResult.current.view.nextCursor === localCursor(4),
  "SWR ignored a later full-view revision outside the returned page",
);

cacheResponses.push(
  { status: 0, stdout: envelope("omni-cache", requestIdentityA, view("6", "before")) },
  { status: 0, stdout: envelope("omni-cache", requestIdentityA, view("7", "after")) },
);
identityResponses.push(
  { status: 0, stdout: identityEnvelope(requestIdentityA) },
  { status: 0, stdout: identityEnvelope(requestIdentityA) },
);
liveResponses.push(envelope("omni-live", requestIdentityA, view("7", "after")));
const countsBeforeRevalidation = Object.freeze({
  cache: cacheArguments.length,
  identity: identityArguments.length,
  live: liveArguments.length,
});
const revalidation = revalidateOmniView(request);
assert(
  cacheArguments.length === countsBeforeRevalidation.cache
  && identityArguments.length === countsBeforeRevalidation.identity
  && liveArguments.length === countsBeforeRevalidation.live,
  "revalidateOmniView ran a subprocess before returning its promise",
);
const revalidated = await revalidation;
assert(revalidated.current.source === "omni-live", "revalidation did not retain live source status");
assert(revalidated.cachedBefore !== null, "revalidation omitted its cache-before observation");

cacheResponses.push({
  status: 0,
  stdout: JSON.stringify({
    ...JSON.parse(envelope("omni-cache", requestIdentityA)) as Record<string, unknown>,
    unexpected: true,
  }),
});
assert(
  syncError(() => readCachedOmniView(request)).includes("is not reviewed"),
  "cache parser accepted an extra envelope field",
);

const forged = JSON.parse(envelope("omni-cache", requestIdentityA)) as {
  view: { entities: Array<{ revision: string }> };
};
forged.view.entities[0]!.revision = "0".repeat(64);
cacheResponses.push({ status: 0, stdout: JSON.stringify(forged) });
assert(
  syncError(() => readCachedOmniView(request)).includes("does not authenticate"),
  "cache parser accepted a forged entity revision",
);

let proxyTrapCalls = 0;
const proxyOutput = new Proxy({}, {
  get() {
    proxyTrapCalls += 1;
    return undefined;
  },
  getPrototypeOf() {
    proxyTrapCalls += 1;
    return Object.prototype;
  },
});
cacheResponses.push({ status: 0, stdout: proxyOutput });
assert(
  syncError(() => readCachedOmniView(request)).includes("must not be a proxy"),
  "cache parser accepted proxy output",
);
assert(proxyTrapCalls === 0, "cache output proxy trap was executed");

const oversizedOutput = "x".repeat(20 * 1024 * 1024 + 1);
cacheResponses.push({ status: 0, stdout: oversizedOutput });
assert(
  syncError(() => readCachedOmniView(request)).includes("byte bound"),
  "cache parser accepted oversized output",
);

// A -> B: both the live envelope and postflight expose the replacement.
identityResponses.push(
  { status: 0, stdout: identityEnvelope(requestIdentityA) },
  { status: 0, stdout: identityEnvelope(requestIdentityB) },
);
cacheResponses.push({ status: 0, stdout: envelope("omni-cache", requestIdentityA) });
liveResponses.push(envelope("omni-live", requestIdentityB));
assert(
  (await asyncError(revalidateOmniView(request))).includes("identity changed"),
  "A-to-B identity replacement was not fenced",
);

// A -> B -> A: the postflight returns A, but the live envelope proves B.
identityResponses.push(
  { status: 0, stdout: identityEnvelope(requestIdentityA) },
  { status: 0, stdout: identityEnvelope(requestIdentityA) },
);
cacheResponses.push({ status: 0, stdout: envelope("omni-cache", requestIdentityA) });
liveResponses.push(envelope("omni-live", requestIdentityB));
assert(
  (await asyncError(revalidateOmniView(request))).includes("identity changed"),
  "A-to-B-to-A identity replacement was not fenced",
);

identityResponses.push({ status: 0, stdout: identityEnvelope(requestIdentityA) });
cacheResponses.push({ status: 0, stdout: envelope("omni-cache", requestIdentityA) });
liveResponses.push({ waitForAbort: true });
const controller = new AbortController();
const abortCounts = Object.freeze({
  identity: identityArguments.length,
  live: liveArguments.length,
});
const aborted = revalidateOmniView(request, { signal: controller.signal });
await advanceUntil(() => liveArguments.length === abortCounts.live + 1);
assert(
  identityArguments.length === abortCounts.identity + 1
  && liveArguments.length === abortCounts.live + 1,
  "abort fixture did not reach the live child",
);
const closeCountBeforeAbort = abortCloseCount;
controller.abort();
assert(
  (await asyncError(aborted)).toLowerCase().includes("abort"),
  "live abort did not reject revalidation",
);
assert(
  childKillSignals.at(-1) === "SIGTERM"
  && abortCloseCount === closeCountBeforeAbort + 1,
  "abort did not terminate and join the live child before rejection",
);

const preflightController = new AbortController();
identityResponses.push({ waitForAbort: true });
const countsBeforePreflightAbort = Object.freeze({
  identity: identityArguments.length,
  cache: cacheArguments.length,
  live: liveArguments.length,
  close: abortCloseCount,
});
const abortedPreflight = revalidateOmniView(request, {
  signal: preflightController.signal,
});
await advanceUntil(() =>
  identityArguments.length === countsBeforePreflightAbort.identity + 1);
preflightController.abort();
assert(
  (await asyncError(abortedPreflight)).toLowerCase().includes("abort"),
  "identity preflight abort did not reject revalidation",
);
assert(
  cacheArguments.length === countsBeforePreflightAbort.cache
  && liveArguments.length === countsBeforePreflightAbort.live
  && childKillSignals.at(-1) === "SIGTERM"
  && abortCloseCount === countsBeforePreflightAbort.close + 1,
  "identity preflight was not abortable and joined before later phases",
);

identityResponses.push({ status: 0, stdout: identityEnvelope(requestIdentityA) });
cacheResponses.push({ status: 0, stdout: envelope("omni-cache", requestIdentityA) });
liveResponses.push(oversizedOutput);
const responseClosesBeforeOversize = responseCloseCount;
assert(
  (await asyncError(revalidateOmniView(request))).includes("byte bound"),
  "live runner accepted oversized output",
);
assert(
  childKillSignals.at(-1) === "SIGTERM"
  && responseCloseCount === responseClosesBeforeOversize + 3,
  "oversized live output did not terminate and join its child",
);

identityResponses.push({ status: 0, stdout: identityEnvelope(requestIdentityA) });
cacheResponses.push({ status: 0, stdout: envelope("omni-cache", requestIdentityA) });
liveResponses.push("{");
assert(
  (await asyncError(revalidateOmniView(request))).includes("malformed JSON"),
  "live parser accepted malformed child JSON",
);

assert(cacheResponses.length === 0, "unused cache fixture responses remain");
assert(identityResponses.length === 0, "unused identity fixture responses remain");
assert(liveResponses.length === 0, "unused live fixture responses remain");
