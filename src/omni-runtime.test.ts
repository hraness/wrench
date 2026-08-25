import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth, saveAuth } from "./auth";
import {
  canonicalJson,
  manifestHash,
  sha256,
  type WrenchManifest,
} from "./model";
import {
  createOmniContinuationGuard,
  readCachedOmniViewInternal,
  rebuildOmniViewFromExactCache,
  revalidateOmniViewInternal,
} from "./omni-runtime";
import { providerPluginRegistry } from "./provider-plugins";
import {
  createReadProjectionQueryForInvocation,
  prepareInvocation,
  type InvocationResult,
  type PreparedInvocation,
} from "./runtime";
import { publishReadProjection } from "./read-projections";
import { installManifest } from "./storage";

function state(): {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const directory = mkdtempSync(join(tmpdir(), "wrench-omni-runtime-"));
  chmodSync(directory, 0o700);
  return Object.freeze({
    directory,
    environment: Object.freeze({ WRENCH_STATE_HOME: directory }),
  });
}

const redditMessage = Object.freeze({
  kind: "message",
  id: "t4_msg123",
  author: "sender",
  recipient: "viewer",
  subject: "Hello",
  body: "Legacy private message",
  createdUtc: 1_700_000_002,
  unread: true,
  parentId: null,
  context: "https://www.reddit.com/message/messages/msg123",
});

const redditNotification = Object.freeze({
  kind: "notification",
  id: "t1_comment123",
  author: "commenter",
  recipient: "viewer",
  subject: "comment reply",
  body: "A reply",
  createdUtc: 1_700_000_003,
  unread: false,
  parentId: "t3_post123",
  context: "https://www.reddit.com/r/wrench/comments/post123/topic/comment123/",
});

function request(cursor?: string) {
  return {
    schemaVersion: 1,
    sources: [{
      adapterId: "reddit-web",
      operationId: "messaging.list",
      authId: "reddit-main",
      input: { folder: "inbox", limit: 25 },
    }],
    page: { limit: 1, ...(cursor === undefined ? {} : { cursor }) },
  } as const;
}

function setupExact(
  environment: Readonly<Record<string, string | undefined>>,
): ReturnType<typeof createReadProjectionQueryForInvocation> {
  const manifest = JSON.parse(readFileSync(
    new URL("./assets/adapters/reddit/wrench-web-adapter.json", import.meta.url),
    "utf8",
  )) as WrenchManifest;
  installManifest(manifest, {
    force: false,
    environment,
    registry: providerPluginRegistry,
  });
  saveAuth(createAuth("reddit-main", {
    source: "chrome",
    subject: "reddit:t2_account",
  }), environment);
  const invocation = prepareInvocation(
    "reddit-web",
    "messaging.list",
    { folder: "inbox", limit: 25 },
    "reddit-main",
    environment,
    providerPluginRegistry,
  );
  return createReadProjectionQueryForInvocation(
    invocation,
    environment,
    providerPluginRegistry,
  );
}

function webSessionResult(
  invocation: PreparedInvocation,
  output: unknown,
  sequence: number,
  status: "succeeded" | "failed" = "succeeded",
  failureReason = "synthetic continuation failure",
): InvocationResult {
  const suffix = String(sequence).padStart(12, "0");
  const second = String(sequence * 2).padStart(2, "0");
  return Object.freeze({
    receipt: Object.freeze({
      schemaVersion: 4 as const,
      transport: "web-session-api" as const,
      runId: `00000000-0000-4000-8000-${suffix}`,
      planDigest: null,
      adapter: Object.freeze({
        id: invocation.manifest.id,
        version: invocation.manifest.version,
        hash: manifestHash(invocation.manifest),
      }),
      operation: invocation.operationId,
      risk: "R1" as const,
      inputHash: sha256(canonicalJson(invocation.input)),
      auth: Object.freeze({
        id: invocation.auth.id,
        hash: sha256(canonicalJson(invocation.auth)),
        kind: invocation.auth.kind,
      }),
      status,
      dispatchStarted: true,
      dispatch: Object.freeze({
        planned: 1,
        started: 1,
        verified: status === "succeeded" ? 1 : 0,
      }),
      startedAt: `2026-08-01T12:20:${second}.000Z`,
      finishedAt: `2026-08-01T12:20:${String(sequence * 2 + 1).padStart(2, "0")}.000Z`,
      finalOrigin: "https://www.reddit.com",
      error: status === "failed" ? failureReason : null,
      webSessionContractHash: "a".repeat(64),
    }),
    output,
    replayed: false,
  });
}

async function setupSuccessfulPrivateContinuationBaseline(
  environment: Readonly<Record<string, string | undefined>>,
) {
  setupExact(environment);
  const liveRequest = {
    ...request(),
    page: { limit: 100 },
  } as const;
  const providerCursor = "t1_privatecursor777";
  let receiptSequence = 0;
  const nextReceiptSequence = () => {
    receiptSequence += 1;
    return receiptSequence;
  };
  const initial = await revalidateOmniViewInternal(liveRequest, {
    environment,
    registry: providerPluginRegistry,
    now: new Date("2026-08-01T12:20:30.000Z"),
    executeRead: (invocation) => Promise.resolve(webSessionResult(
      invocation,
      invocation.input.after === undefined
        ? {
            messages: [redditMessage],
            after: providerCursor,
            before: null,
            requested: null,
          }
        : {
            messages: [redditNotification],
            after: null,
            before: null,
            requested: null,
          },
      nextReceiptSequence(),
    )),
  });
  expect(initial.view?.entities).toHaveLength(2);

  const continuationInvocation = prepareInvocation(
    "reddit-web",
    "messaging.list",
    { folder: "inbox", after: providerCursor, limit: 25 },
    "reddit-main",
    environment,
    providerPluginRegistry,
  );
  const continuationQuery = createReadProjectionQueryForInvocation(
    continuationInvocation,
    environment,
    providerPluginRegistry,
  );
  return Object.freeze({
    continuationQuery,
    liveRequest,
    nextReceiptSequence,
    providerCursor,
  });
}

describe("omni runtime", () => {
  test("bounds continuation admission and detects exact-query cycles", () => {
    const rootKey = "0".repeat(64);
    const firstContinuationKey = "1".repeat(64);
    const secondContinuationKey = "2".repeat(64);
    const bounded = createOmniContinuationGuard(rootKey, 3);
    expect(bounded.beforeNext()).toBeNull();
    expect(bounded.observe(firstContinuationKey)).toBeNull();
    expect(bounded.beforeNext()).toBeNull();
    expect(bounded.observe(secondContinuationKey)).toBeNull();
    expect(bounded.beforeNext()).toBe(
      "provider continuation exceeds the 3-page normalized capacity",
    );

    const schemaBounded = createOmniContinuationGuard("f".repeat(64));
    for (let page = 1; page < 256; page += 1) {
      expect(schemaBounded.beforeNext()).toBeNull();
      expect(schemaBounded.observe(page.toString(16).padStart(64, "0"))).toBeNull();
    }
    expect(schemaBounded.beforeNext()).toBe(
      "provider continuation exceeds the 256-page normalized capacity",
    );

    const cyclic = createOmniContinuationGuard(rootKey);
    expect(cyclic.beforeNext()).toBeNull();
    expect(cyclic.observe(rootKey)).toBe(
      "provider continuation repeated an exact page query",
    );
  });

  test("recovers a private provider continuation after retained drift", async () => {
    const testState = state();
    try {
      setupExact(testState.environment);
      const liveRequest = {
        ...request(),
        page: { limit: 100 },
      } as const;
      const providerCursor = "t1_cursor999";
      let receiptSequence = 0;
      const firstDrift = await revalidateOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:20:30.000Z"),
        executeRead: (invocation) => {
          receiptSequence += 1;
          return Promise.resolve(webSessionResult(
            invocation,
            invocation.input.after === undefined
              ? {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                }
              : {
                  messages: [redditNotification],
                  after: null,
                  before: null,
                  requested: null,
                  [providerCursor]: true,
                },
            receiptSequence,
          ));
        },
      });
      expect(firstDrift.view?.entities.map((entity) => entity.kind)).toEqual([
        "message",
      ]);
      expect(firstDrift.view?.sources[0]?.normalization).toMatchObject({
        state: "retained-after-drift",
        lastGoodAt: null,
      });
      if (
        firstDrift.view?.sources[0]?.normalization.state
        !== "retained-after-drift"
      ) throw new Error("expected first continuation drift to remain visible");
      expect(firstDrift.view.sources[0].normalization.reason).toBe(
        "reddit messaging.list materializer reddit-messaging-list@1 rejected the exact provider shape",
      );
      expect(JSON.stringify(firstDrift)).not.toContain(providerCursor);
      expect(firstDrift.view.sources[0].coverage).toMatchObject({
        state: "observed",
        continuation: "pending",
      });

      const observedInputs: unknown[] = [];
      const live = await revalidateOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:00.000Z"),
        freshForMs: 54_000,
        executeRead: (invocation) => {
          observedInputs.push(invocation.input);
          receiptSequence += 1;
          return Promise.resolve(webSessionResult(
            invocation,
            invocation.input.after === undefined
              ? {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                }
              : {
                  messages: [redditNotification],
                  after: null,
                  before: null,
                  requested: null,
                },
            receiptSequence,
          ));
        },
      });

      expect(observedInputs).toEqual([
        { folder: "inbox", limit: 25 },
        { folder: "inbox", after: providerCursor, limit: 25 },
      ]);
      expect(live.view?.entities.map((entity) => entity.kind)).toEqual([
        "notification",
        "message",
      ]);
      expect(live.view?.sources[0]?.coverage).toMatchObject({
        state: "observed",
        kind: "page",
        continuation: "none",
        reason: "the provider materializer declared page-scoped coverage",
      });
      expect(JSON.stringify(live)).not.toContain(providerCursor);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retains a complete provider continuation view after a partial refresh failure", async () => {
    const testState = state();
    try {
      const rootQuery = setupExact(testState.environment);
      const liveRequest = {
        ...request(),
        page: { limit: 100 },
      } as const;
      const providerCursor = "t1_cursor999";
      const continuationInvocation = prepareInvocation(
        "reddit-web",
        "messaging.list",
        { folder: "inbox", after: providerCursor, limit: 25 },
        "reddit-main",
        testState.environment,
        providerPluginRegistry,
      );
      const continuationQuery = createReadProjectionQueryForInvocation(
        continuationInvocation,
        testState.environment,
        providerPluginRegistry,
      );
      publishReadProjection(rootQuery, {
        messages: [redditMessage],
        after: providerCursor,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000001",
        startedAt: "2026-08-01T12:20:02.000Z",
        finishedAt: "2026-08-01T12:20:03.000Z",
      });
      publishReadProjection(continuationQuery, {
        messages: [redditNotification],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000002",
        startedAt: "2026-08-01T12:20:04.000Z",
        finishedAt: "2026-08-01T12:20:05.000Z",
      });
      const live = rebuildOmniViewFromExactCache(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:00.000Z"),
      });
      expect(live.view?.entities.map((entity) => entity.kind)).toEqual([
        "notification",
        "message",
      ]);

      let receiptSequence = 2;
      const failedInputs: unknown[] = [];
      const privateFailureReason = `provider receipt exposed ${providerCursor}`;
      const partial = await revalidateOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:10.000Z"),
        executeRead: (invocation) => {
          failedInputs.push(invocation.input);
          receiptSequence += 1;
          const continuation = invocation.input.after !== undefined;
          return Promise.resolve(webSessionResult(
            invocation,
            continuation
              ? null
              : {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                },
            receiptSequence,
            continuation ? "failed" : "succeeded",
            privateFailureReason,
          ));
        },
      });
      expect(failedInputs).toHaveLength(2);
      expect(partial.view?.entities).toEqual(live.view?.entities);
      expect(partial.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactDataRevision: null,
        reason: "provider read failed before the normalized source could be refreshed",
      });
      expect(partial.view?.sources[0]?.coverage).toMatchObject({
        state: "observed",
        continuation: "none",
      });
      expect(JSON.stringify(partial)).not.toContain(privateFailureReason);
      expect(JSON.stringify(partial)).not.toContain(providerCursor);

      expect(partial.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactQueryKey: continuationQuery.key,
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("serves a complete provider continuation crawl from normalized cache", async () => {
    const testState = state();
    try {
      setupExact(testState.environment);
      const liveRequest = {
        ...request(),
        page: { limit: 100 },
      } as const;
      const providerCursor = "t1_cachecursor999";
      let receiptSequence = 0;
      const live = await revalidateOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:00.000Z"),
        executeRead: (invocation) => {
          receiptSequence += 1;
          return Promise.resolve(webSessionResult(
            invocation,
            invocation.input.after === undefined
              ? {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                }
              : {
                  messages: [redditNotification],
                  after: null,
                  before: null,
                  requested: null,
                },
            receiptSequence,
          ));
        },
      });
      expect(live.view?.entities.map((entity) => entity.kind)).toEqual([
        "notification",
        "message",
      ]);

      const cached = readCachedOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:01.000Z"),
      });
      expect(cached.view?.entities).toEqual(live.view?.entities);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("rebuilds a newer continuation exact page without losing the prior normalized frontier", async () => {
    const testState = state();
    try {
      setupExact(testState.environment);
      const liveRequest = {
        ...request(),
        page: { limit: 100 },
      } as const;
      const providerCursor = "t1_cursor999";
      let receiptSequence = 0;
      const live = await revalidateOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:00.000Z"),
        executeRead: (invocation) => {
          receiptSequence += 1;
          return Promise.resolve(webSessionResult(
            invocation,
            invocation.input.after === undefined
              ? {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                }
              : {
                  messages: [redditNotification],
                  after: null,
                  before: null,
                  requested: null,
                },
            receiptSequence,
          ));
        },
      });
      expect(live.view?.entities.map((entity) => entity.kind)).toEqual([
        "notification",
        "message",
      ]);

      const continuationInvocation = prepareInvocation(
        "reddit-web",
        "messaging.list",
        { folder: "inbox", after: providerCursor, limit: 25 },
        "reddit-main",
        testState.environment,
        providerPluginRegistry,
      );
      const continuationQuery = createReadProjectionQueryForInvocation(
        continuationInvocation,
        testState.environment,
        providerPluginRegistry,
      );
      const newerContinuation = publishReadProjection(continuationQuery, {
        messages: [{ ...redditNotification, body: "Newer continuation body" }],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000031",
        startedAt: "2026-08-01T12:22:00.000Z",
        finishedAt: "2026-08-01T12:22:01.000Z",
      });
      const continuationStale = readCachedOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:22:02.000Z"),
      });
      expect(continuationStale.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactDataRevision: newerContinuation.dataRevision,
        reason: "a provider continuation exact snapshot is newer than its normalized frontier",
      });
      const oldContinuation = continuationStale.view?.entities.find((entity) =>
        entity.kind === "notification");
      expect(oldContinuation?.body).toBe("A reply");

      const continuationRebuilt = rebuildOmniViewFromExactCache(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:22:03.000Z"),
      });
      expect(continuationRebuilt.view?.sources[0]?.normalization).toMatchObject({
        state: "current",
      });
      const newContinuation = continuationRebuilt.view?.entities.find((entity) =>
        entity.kind === "notification");
      expect(newContinuation?.body).toBe("Newer continuation body");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("attributes private continuation executor rejection without leaking provider diagnostics", async () => {
    const testState = state();
    try {
      const baseline = await setupSuccessfulPrivateContinuationBaseline(
        testState.environment,
      );
      const executorSentinel = `private executor failure ${baseline.providerCursor}`;
      const executorFailure = await revalidateOmniViewInternal(
        baseline.liveRequest,
        {
          environment: testState.environment,
          registry: providerPluginRegistry,
          now: new Date("2026-08-01T12:21:00.000Z"),
          freshForMs: 54_000,
          executeRead: (invocation) => {
            const receiptSequence = baseline.nextReceiptSequence();
            if (invocation.input.after !== undefined) {
              return Promise.reject(new Error(executorSentinel));
            }
            return Promise.resolve(webSessionResult(invocation, {
              messages: [redditMessage],
              after: baseline.providerCursor,
              before: null,
              requested: null,
            }, receiptSequence));
          },
        },
      );
      expect(executorFailure.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactQueryKey: baseline.continuationQuery.key,
        reason: "provider read failed before the normalized source could be refreshed",
      });
      expect(executorFailure.view?.sources[0]?.exact).toMatchObject({
        state: "hit",
        freshness: { state: "fresh" },
      });
      expect(JSON.stringify(executorFailure)).not.toContain(executorSentinel);
      expect(JSON.stringify(executorFailure)).not.toContain(baseline.providerCursor);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("attributes a private provider AbortError without caller cancellation", async () => {
    const testState = state();
    try {
      const baseline = await setupSuccessfulPrivateContinuationBaseline(
        testState.environment,
      );
      const liveSignal = new AbortController();
      const providerAbortSentinel = `private provider abort ${baseline.providerCursor}`;
      const providerAbort = await revalidateOmniViewInternal(baseline.liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:20.000Z"),
        signal: liveSignal.signal,
        executeRead: (invocation) => {
          const receiptSequence = baseline.nextReceiptSequence();
          if (invocation.input.after !== undefined) {
            return Promise.reject(new DOMException(
              providerAbortSentinel,
              "AbortError",
            ));
          }
          return Promise.resolve(webSessionResult(invocation, {
            messages: [redditMessage],
            after: baseline.providerCursor,
            before: null,
            requested: null,
          }, receiptSequence));
        },
      });
      expect(liveSignal.signal.aborted).toBeFalse();
      expect(providerAbort.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactQueryKey: baseline.continuationQuery.key,
        reason: "provider read failed before the normalized source could be refreshed",
      });
      expect(JSON.stringify(providerAbort)).not.toContain(providerAbortSentinel);
      expect(JSON.stringify(providerAbort)).not.toContain(baseline.providerCursor);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("attributes an exact-cache publication failure without leaking provider diagnostics", async () => {
    const testState = state();
    try {
      const baseline = await setupSuccessfulPrivateContinuationBaseline(
        testState.environment,
      );
      const cacheSentinel = `private cache output ${baseline.providerCursor}`;
      let structurallyOversizedValue: unknown = cacheSentinel;
      for (let depth = 0; depth < 65; depth += 1) {
        structurallyOversizedValue = { next: structurallyOversizedValue };
      }
      const oversizedOutput = {
        messages: [redditMessage],
        after: null,
        before: null,
        requested: null,
        privateDiagnostic: structurallyOversizedValue,
      };
      const cacheFailure = await revalidateOmniViewInternal(baseline.liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:40.000Z"),
        executeRead: (invocation) => {
          return Promise.resolve(webSessionResult(
            invocation,
            invocation.input.after === undefined
              ? {
                  messages: [redditMessage],
                  after: baseline.providerCursor,
                  before: null,
                  requested: null,
                }
              : oversizedOutput,
            baseline.nextReceiptSequence(),
          ));
        },
      });
      expect(cacheFailure.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactQueryKey: baseline.continuationQuery.key,
        reason: "exact provider snapshot could not be published during omni revalidation",
      });
      expect(JSON.stringify(cacheFailure)).not.toContain(cacheSentinel);
      expect(JSON.stringify(cacheFailure)).not.toContain(baseline.providerCursor);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("keeps a failed continuation receipt ahead of rematerialization failure", async () => {
    const testState = state();
    try {
      const rootQuery = setupExact(testState.environment);
      const liveRequest = {
        ...request(),
        page: { limit: 100 },
      } as const;
      const providerCursor = "t1_privatecursor888";
      const continuationInvocation = prepareInvocation(
        "reddit-web",
        "messaging.list",
        { folder: "inbox", after: providerCursor, limit: 25 },
        "reddit-main",
        testState.environment,
        providerPluginRegistry,
      );
      const continuationQuery = createReadProjectionQueryForInvocation(
        continuationInvocation,
        testState.environment,
        providerPluginRegistry,
      );
      publishReadProjection(rootQuery, {
        messages: [redditMessage],
        after: providerCursor,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000001",
        startedAt: "2026-08-01T12:20:02.000Z",
        finishedAt: "2026-08-01T12:20:03.000Z",
      });
      publishReadProjection(continuationQuery, {
        messages: [redditNotification],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000002",
        startedAt: "2026-08-01T12:20:04.000Z",
        finishedAt: "2026-08-01T12:20:05.000Z",
      });
      const initial = rebuildOmniViewFromExactCache(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:20:30.000Z"),
      });
      expect(initial.view?.entities).toHaveLength(2);

      const continuationDirectory = join(
        testState.directory,
        "read-projections",
        continuationQuery.realmKey,
        continuationQuery.key,
      );
      const chunkName = readdirSync(continuationDirectory).find((name) =>
        name.startsWith("chunk--"));
      if (chunkName === undefined) {
        throw new Error("expected an encrypted continuation projection chunk");
      }
      const chunkPath = join(continuationDirectory, chunkName);
      const chunk = JSON.parse(
        readFileSync(chunkPath, "utf8"),
      ) as Record<string, unknown>;
      const ciphertext = String(chunk.ciphertext);
      chunk.ciphertext = `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`;
      writeFileSync(chunkPath, `${canonicalJson(chunk)}\n`, { mode: 0o600 });

      let receiptSequence = 2;
      const privateFailureReason = `private failed receipt ${providerCursor}`;
      const failed = await revalidateOmniViewInternal(liveRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:21:00.000Z"),
        executeRead: (invocation) => {
          receiptSequence += 1;
          const continuation = invocation.input.after !== undefined;
          return Promise.resolve(webSessionResult(
            invocation,
            continuation
              ? null
              : {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                },
            receiptSequence,
            continuation ? "failed" : "succeeded",
            privateFailureReason,
          ));
        },
      });

      expect(failed.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactQueryKey: continuationQuery.key,
        exactDataRevision: null,
        reason: "provider read failed before the normalized source could be refreshed",
      });
      expect(failed.view?.entities).toEqual(initial.view?.entities);
      expect(failed.view?.viewRevision).toBe(initial.view?.viewRevision);
      expect(JSON.stringify(failed)).not.toContain(privateFailureReason);
      expect(JSON.stringify(failed)).not.toContain(providerCursor);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("isolates one source's continuation failure while another source advances", async () => {
    const testState = state();
    try {
      setupExact(testState.environment);
      saveAuth(createAuth("reddit-other", {
        source: "chrome",
        subject: "reddit:t2_other",
      }), testState.environment);
      const multiSourceRequest = {
        schemaVersion: 1,
        sources: [
          {
            adapterId: "reddit-web",
            operationId: "messaging.list",
            authId: "reddit-main",
            input: { folder: "inbox", limit: 25 },
          },
          {
            adapterId: "reddit-web",
            operationId: "messaging.list",
            authId: "reddit-other",
            input: { folder: "sent", limit: 25 },
          },
        ],
        page: { limit: 100 },
      } as const;
      const providerCursor = "t1_privatecursor777";
      const otherBefore = Object.freeze({
        ...redditNotification,
        id: "t1_other123",
        body: "Other account before",
        context: "https://www.reddit.com/r/wrench/comments/other/topic/other123/",
      });
      const otherAfter = Object.freeze({
        ...otherBefore,
        body: "Other account advanced",
      });
      let receiptSequence = 0;
      const initial = await revalidateOmniViewInternal(multiSourceRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:22:00.000Z"),
        executeRead: (invocation) => {
          receiptSequence += 1;
          if (invocation.auth.id === "reddit-other") {
            return Promise.resolve(webSessionResult(invocation, {
              messages: [otherBefore],
              after: null,
              before: null,
              requested: null,
            }, receiptSequence));
          }
          return Promise.resolve(webSessionResult(
            invocation,
            invocation.input.after === undefined
              ? {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                }
              : {
                  messages: [redditNotification],
                  after: null,
                  before: null,
                  requested: null,
                },
            receiptSequence,
          ));
        },
      });
      expect(initial.view?.sources.map((source) => source.normalization.state))
        .toEqual(["current", "current"]);

      const failureSentinel = `private main continuation failure ${providerCursor}`;
      const refreshed = await revalidateOmniViewInternal(multiSourceRequest, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:23:00.000Z"),
        executeRead: (invocation) => {
          receiptSequence += 1;
          if (invocation.auth.id === "reddit-other") {
            return Promise.resolve(webSessionResult(invocation, {
              messages: [otherAfter],
              after: null,
              before: null,
              requested: null,
            }, receiptSequence));
          }
          if (invocation.input.after !== undefined) {
            return Promise.reject(new Error(failureSentinel));
          }
          return Promise.resolve(webSessionResult(invocation, {
            messages: [redditMessage],
            after: providerCursor,
            before: null,
            requested: null,
          }, receiptSequence));
        },
      });
      const mainStatus = refreshed.view?.sources.find((source) =>
        source.authId === "reddit-main");
      const otherStatus = refreshed.view?.sources.find((source) =>
        source.authId === "reddit-other");
      expect(mainStatus?.normalization.state).toBe("stale");
      expect(otherStatus?.normalization.state).toBe("current");
      expect(refreshed.view?.entities.some((entity) =>
        entity.kind !== "conversation"
        && entity.body === "Other account advanced")).toBeTrue();
      expect(refreshed.view?.entities.some((entity) =>
        entity.kind !== "conversation"
        && entity.body === redditNotification.body)).toBeTrue();
      expect(JSON.stringify(refreshed)).not.toContain(failureSentinel);
      expect(JSON.stringify(refreshed)).not.toContain(providerCursor);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("stops a cyclic provider continuation without leaking its cursor", async () => {
    const testState = state();
    try {
      setupExact(testState.environment);
      const providerCursor = "t1_privatecycle999";
      let providerCalls = 0;
      const observed = await revalidateOmniViewInternal({
        ...request(),
        page: { limit: 100 },
      }, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:24:00.000Z"),
        executeRead: (invocation) => {
          providerCalls += 1;
          return Promise.resolve(webSessionResult(
            invocation,
            invocation.input.after === undefined
              ? {
                  messages: [redditMessage],
                  after: providerCursor,
                  before: null,
                  requested: null,
                }
              : {
                  messages: [redditNotification],
                  after: providerCursor,
                  before: null,
                  requested: null,
                },
            providerCalls,
          ));
        },
      });
      expect(providerCalls).toBe(2);
      expect(observed.view?.sources[0]?.normalization).toMatchObject({
        state: "retained-after-drift",
        reason: "reddit messaging.list materializer reddit-messaging-list@1 rejected the exact provider shape",
      });
      expect(observed.view?.sources[0]?.coverage).toMatchObject({
        state: "observed",
        continuation: "pending",
      });
      expect(JSON.stringify(observed)).not.toContain(providerCursor);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("stops at the bounded provider page budget with generic status", async () => {
    const testState = state();
    try {
      setupExact(testState.environment);
      let providerCalls = 0;
      const observed = await revalidateOmniViewInternal({
        ...request(),
        page: { limit: 100 },
      }, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:25:00.000Z"),
        sourcePageLimit: 3,
        executeRead: (invocation) => {
          providerCalls += 1;
          const providerCursor = `t1_privatecapacity${String(providerCalls).padStart(3, "0")}`;
          return Promise.resolve(webSessionResult(invocation, {
            messages: [{
              ...redditNotification,
              id: `t1_capacitynotice${String(providerCalls).padStart(3, "0")}`,
              body: `Capacity page ${String(providerCalls)}`,
              context: `https://www.reddit.com/r/wrench/comments/capacity/topic/capacity${String(providerCalls)}/`,
            }],
            after: providerCursor,
            before: null,
            requested: null,
          }, providerCalls));
        },
      });
      expect(providerCalls).toBe(3);
      expect(observed.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        reason: "provider continuation exceeds the 3-page normalized capacity",
      });
      expect(observed.view?.sources[0]?.coverage).toMatchObject({
        state: "observed",
        continuation: "pending",
      });
      expect(JSON.stringify(observed)).not.toContain("t1_privatecapacity");

      let outOfRangeCalls = 0;
      let outOfRangeError: unknown = null;
      try {
        await revalidateOmniViewInternal(request(), {
          environment: testState.environment,
          registry: providerPluginRegistry,
          sourcePageLimit: 257,
          executeRead: () => {
            outOfRangeCalls += 1;
            return Promise.reject(new Error("unreachable provider call"));
          },
        });
      } catch (error) {
        outOfRangeError = error;
      }
      expect(outOfRangeError).toEqual(new Error(
        "omni source page limit must be an integer from 1 through 256",
      ));
      expect(outOfRangeCalls).toBe(0);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("propagates only authoritative caller cancellation", async () => {
    const testState = state();
    try {
      setupExact(testState.environment);
      const controller = new AbortController();
      const callerReason = new DOMException("caller cancelled omni", "AbortError");
      let observedError: unknown = null;
      try {
        await revalidateOmniViewInternal(request(), {
          environment: testState.environment,
          registry: providerPluginRegistry,
          signal: controller.signal,
          executeRead: () => {
            controller.abort(callerReason);
            return Promise.reject(new DOMException(
              "provider-local abort must not replace the caller reason",
              "AbortError",
            ));
          },
        });
      } catch (error) {
        observedError = error;
      }
      expect(observedError).toBe(callerReason);
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reports stale freshness on a retained continuation exact page", () => {
    const testState = state();
    try {
      const rootQuery = setupExact(testState.environment);
      const providerCursor = "t1_stalecursor888";
      const continuationInvocation = prepareInvocation(
        "reddit-web",
        "messaging.list",
        { folder: "inbox", after: providerCursor, limit: 25 },
        "reddit-main",
        testState.environment,
        providerPluginRegistry,
      );
      const continuationQuery = createReadProjectionQueryForInvocation(
        continuationInvocation,
        testState.environment,
        providerPluginRegistry,
      );
      const continuationPublication = publishReadProjection(continuationQuery, {
        messages: [redditNotification],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000041",
        startedAt: "2026-08-01T12:00:00.000Z",
        finishedAt: "2026-08-01T12:00:01.000Z",
      });
      publishReadProjection(rootQuery, {
        messages: [redditMessage],
        after: providerCursor,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000042",
        startedAt: "2026-08-01T12:10:00.000Z",
        finishedAt: "2026-08-01T12:10:01.000Z",
      });
      const rebuilt = rebuildOmniViewFromExactCache({
        ...request(),
        page: { limit: 100 },
      }, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:10:02.000Z"),
      });
      expect(rebuilt.view?.sources[0]?.normalization).toMatchObject({
        state: "current",
      });

      const stale = readCachedOmniViewInternal({
        ...request(),
        page: { limit: 100 },
      }, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:10:30.000Z"),
        freshForMs: 60_000,
      });
      expect(stale.view?.sources[0]?.exact).toMatchObject({
        state: "hit",
        freshness: { state: "fresh" },
      });
      expect(stale.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactQueryKey: continuationQuery.key,
        exactDataRevision: continuationPublication.dataRevision,
        normalizedExactDataRevision: continuationPublication.dataRevision,
        reason: "a provider continuation exact snapshot is stale",
      });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("materializes exact provider bytes, persists them, and pages locally", () => {
    const testState = state();
    try {
      const query = setupExact(testState.environment);
      publishReadProjection(query, {
        messages: [redditMessage, redditNotification],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000001",
        startedAt: "2026-08-01T12:00:00.000Z",
        finishedAt: "2026-08-01T12:00:01.000Z",
      });

      const rebuilt = rebuildOmniViewFromExactCache(request(), {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:00:02.000Z"),
      });
      expect(rebuilt.source).toBe("omni-exact-cache");
      expect(rebuilt.view?.entities.map((entity) => entity.kind)).toEqual([
        "notification",
      ]);
      expect(rebuilt.view?.sources[0]).toMatchObject({
        exact: { state: "hit" },
        normalization: { state: "current" },
      });
      expect(rebuilt.view?.nextCursor).toStartWith("smn1.");

      const cached = readCachedOmniViewInternal(request(), {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:00:03.000Z"),
      });
      expect(cached.view?.entities).toEqual(rebuilt.view?.entities);
      const second = readCachedOmniViewInternal(
        request(rebuilt.view?.nextCursor ?? undefined),
        {
          environment: testState.environment,
          registry: providerPluginRegistry,
          now: new Date("2026-08-01T12:00:03.000Z"),
        },
      );
      expect(second.view?.entities.map((entity) => entity.kind)).toEqual(["message"]);
      expect(second.view?.nextCursor).toBeNull();
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("retains the last good entities and names provider drift", () => {
    const testState = state();
    try {
      const query = setupExact(testState.environment);
      const valid = {
        messages: [redditMessage],
        after: null,
        before: null,
        requested: null,
      };
      publishReadProjection(query, valid, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000011",
        startedAt: "2026-08-01T12:10:00.000Z",
        finishedAt: "2026-08-01T12:10:01.000Z",
      });
      const good = rebuildOmniViewFromExactCache(request(), {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:10:02.000Z"),
      });
      expect(good.view?.entities).toHaveLength(1);

      publishReadProjection(query, { ...valid, oversized: "private sentinel" }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000012",
        startedAt: "2026-08-01T12:11:00.000Z",
        finishedAt: "2026-08-01T12:11:01.000Z",
      });
      const drift = rebuildOmniViewFromExactCache(request(), {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:11:02.000Z"),
      });
      expect(drift.view?.entities).toEqual(good.view?.entities);
      const normalization = drift.view?.sources[0]?.normalization;
      expect(normalization).toMatchObject({
        state: "retained-after-drift",
        lastGoodAt: "2026-08-01T12:10:01.000Z",
      });
      if (normalization?.state !== "retained-after-drift") {
        throw new Error("expected retained provider drift");
      }
      expect(normalization.reason).toBe(
        "reddit messaging.list materializer reddit-messaging-list@1 rejected the exact provider shape",
      );
      expect(JSON.stringify(drift)).not.toContain("private sentinel");
      expect(normalization.reason).not.toContain("capacity");
      expect(drift.view?.sources[0]?.exact).toMatchObject({ state: "hit" });
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reports the earliest chain issue ahead of a later retained drift", () => {
    const testState = state();
    try {
      const rootQuery = setupExact(testState.environment);
      const providerCursor = "t1_chainpriority777";
      const continuationInvocation = prepareInvocation(
        "reddit-web",
        "messaging.list",
        { folder: "inbox", after: providerCursor, limit: 25 },
        "reddit-main",
        testState.environment,
        providerPluginRegistry,
      );
      const continuationQuery = createReadProjectionQueryForInvocation(
        continuationInvocation,
        testState.environment,
        providerPluginRegistry,
      );
      publishReadProjection(rootQuery, {
        messages: [redditMessage],
        after: providerCursor,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000051",
        startedAt: "2026-08-01T12:00:00.000Z",
        finishedAt: "2026-08-01T12:00:01.000Z",
      });
      publishReadProjection(continuationQuery, {
        messages: [redditNotification],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000052",
        startedAt: "2026-08-01T12:01:00.000Z",
        finishedAt: "2026-08-01T12:01:01.000Z",
      });
      const initial = rebuildOmniViewFromExactCache({
        ...request(),
        page: { limit: 100 },
      }, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:01:02.000Z"),
      });
      expect(initial.view?.sources[0]?.normalization.state).toBe("current");

      publishReadProjection(continuationQuery, {
        messages: [redditNotification],
        after: null,
        before: null,
        requested: null,
        oversized: "private later drift",
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000053",
        startedAt: "2026-08-01T12:02:00.000Z",
        finishedAt: "2026-08-01T12:02:01.000Z",
      });
      const drifted = rebuildOmniViewFromExactCache({
        ...request(),
        page: { limit: 100 },
      }, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:02:02.000Z"),
      });
      expect(drifted.view?.sources[0]?.normalization).toMatchObject({
        state: "retained-after-drift",
        exactQueryKey: continuationQuery.key,
      });

      const newerRoot = publishReadProjection(rootQuery, {
        messages: [{ ...redditMessage, body: "Root exact advanced" }],
        after: providerCursor,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000054",
        startedAt: "2026-08-01T12:03:00.000Z",
        finishedAt: "2026-08-01T12:03:01.000Z",
      });
      const observed = readCachedOmniViewInternal({
        ...request(),
        page: { limit: 100 },
      }, {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:03:02.000Z"),
      });
      expect(observed.view?.sources[0]?.normalization).toMatchObject({
        state: "stale",
        exactQueryKey: rootQuery.key,
        exactDataRevision: newerRoot.dataRevision,
      });
      expect(JSON.stringify(observed)).not.toContain("private later drift");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });

  test("reports a newer exact head as stale until it is rebuilt", () => {
    const testState = state();
    try {
      const query = setupExact(testState.environment);
      publishReadProjection(query, {
        messages: [redditMessage],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000021",
        startedAt: "2026-08-01T12:30:00.000Z",
        finishedAt: "2026-08-01T12:30:01.000Z",
      });
      const initial = rebuildOmniViewFromExactCache(request(), {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:30:02.000Z"),
      });
      const initialNormalization = initial.view?.sources[0]?.normalization;
      if (initialNormalization?.state !== "current") {
        throw new Error("expected the initial normalized revision to be current");
      }

      publishReadProjection(query, {
        messages: [{ ...redditMessage, body: "Updated exact provider body" }],
        after: null,
        before: null,
        requested: null,
      }, {
        environment: testState.environment,
        runId: "00000000-0000-4000-8000-000000000022",
        startedAt: "2026-08-01T12:31:00.000Z",
        finishedAt: "2026-08-01T12:31:01.000Z",
      });
      const stale = readCachedOmniViewInternal(request(), {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:31:02.000Z"),
      });
      const staleNormalization = stale.view?.sources[0]?.normalization;
      expect(staleNormalization).toMatchObject({
        state: "stale",
        normalizedExactDataRevision: initialNormalization.exactDataRevision,
      });
      if (staleNormalization?.state !== "stale") {
        throw new Error("expected a stale normalized revision");
      }
      expect(staleNormalization.exactDataRevision).not.toBeNull();
      const staleEntity = stale.view?.entities[0];
      if (staleEntity?.kind !== "message") {
        throw new Error("expected the retained normalized entity to be a message");
      }
      expect(staleEntity.body).toBe("Legacy private message");

      const rebuilt = rebuildOmniViewFromExactCache(request(), {
        environment: testState.environment,
        registry: providerPluginRegistry,
        now: new Date("2026-08-01T12:31:03.000Z"),
      });
      expect(rebuilt.view?.sources[0]?.normalization).toMatchObject({
        state: "current",
        exactDataRevision: staleNormalization.exactDataRevision,
      });
      const rebuiltEntity = rebuilt.view?.entities[0];
      if (rebuiltEntity?.kind !== "message") {
        throw new Error("expected the rebuilt normalized entity to be a message");
      }
      expect(rebuiltEntity.body).toBe("Updated exact provider body");
    } finally {
      rmSync(testState.directory, { recursive: true, force: true });
    }
  });
});
