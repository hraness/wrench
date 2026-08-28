import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth, saveAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import { parseRuntimeManifest, type InputSchema, type OperationInput } from "./model";
import type { OperationDeadlineClock } from "./operation-deadline";
import {
  discoverMessagingRoutesInternal,
  previewMessagingTurnInternal,
  readMessagingContextInternal,
  resolveMessagingRouteInternal,
  showMessagingRunInternal,
} from "./messaging-runtime";
import type { ProviderMessageV1, ProviderMaterializedPageV1 } from "./omni-model";
import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
  type ProviderPluginMessagingDefinitionV1,
  type ProviderPluginMessagingActionExecutorV1,
  type ProviderPluginMessagingExpectedOwnPrefixV1,
  type ProviderPluginMessagingExpectedOwnPrefixProofV1,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import { createProviderPluginRegistry } from "./provider-plugin-registry";
import { confirmMessagingInvocation } from "./runtime";
import { installManifest } from "./storage";

const roots: string[] = [];
let sharedRoot: string | null = null;
const sourceUrl = new URL("./provider-plugin-test-fixture.ts", import.meta.url);
const roomId = "synthetic-room";
const participant = Object.freeze({
  providerId: "synthetic-recipient",
  displayName: "Synthetic Recipient",
  handle: "synthetic-recipient",
});
const participants = Object.freeze([participant]);
const participantFingerprint = sha256(canonicalJson(participants));
let activePage: ((limit: number) => ProviderMaterializedPageV1) | null = null;
let activePartExecutor: ProviderPluginMessagingActionExecutorV1 | null = null;
let activePrefixProof = proveExactSuffix;
let activeRouteParticipantFingerprint = participantFingerprint;
let activeAfterContextRead: (() => void) | null = null;
let confirmationReadsActive = false;
let cachedRegistry: ReturnType<typeof createProviderPluginRegistry> | null = null;

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  sharedRoot = null;
});

type Behavior =
  | "success"
  | "fail-before-fence"
  | "fail-after-fence"
  | "malformed-after-fence"
  | "private-outcome-before-fence"
  | "private-outcome-after-fence"
  | "invalid-private-outcome-after-fence"
  | "omit-fence"
  | "double-fence"
  | "expire-before-fence"
  | "expire-after-fence"
  | "capture-fence";

type HarnessOptions = {
  readonly behavior?: (attempt: number) => Behavior;
  readonly afterMutation?: (messages: ProviderMessageV1[], attempt: number) => void;
  readonly prefixProof?: (
    proof: ProviderPluginMessagingExpectedOwnPrefixV1,
  ) => ProviderPluginMessagingExpectedOwnPrefixProofV1;
  readonly afterContextRead?: () => void;
  readonly beforeFence?: () => void;
  readonly afterFence?: () => void;
  readonly contextLimit?: number;
  readonly privateOutcomeCode?: string;
};

class ManualDeadlineClock implements OperationDeadlineClock {
  #nowMs = 0;
  #nextId = 1;
  readonly #scheduled = new Map<number, {
    readonly at: number;
    readonly callback: () => void;
  }>();

  readonly now = (): number => this.#nowMs;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#scheduled.set(id, { at: this.#nowMs + delayMs, callback });
    return () => {
      this.#scheduled.delete(id);
    };
  };

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, scheduled]) => scheduled.at <= this.#nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }
}

function message(
  providerId: string,
  body: string,
  orderedAt: string,
  overrides: Partial<ProviderMessageV1> = {},
): ProviderMessageV1 {
  return Object.freeze({
    kind: "message",
    providerId,
    providerRevision: `revision-${providerId}`,
    orderedAt,
    conversationProviderId: roomId,
    sender: participant,
    recipients: participants,
    direction: "outgoing",
    subject: null,
    body,
    bodyTruncated: false,
    unread: false,
    replyToProviderId: null,
    state: "active",
    attachments: Object.freeze([]),
    ...overrides,
  });
}

function baseMessage(message_: ProviderMessageV1) {
  return Object.freeze({
    providerMessageId: message_.providerId,
    providerRevision: message_.providerRevision,
    orderedAt: message_.orderedAt,
    messageSha256: sha256(canonicalJson(message_)),
  });
}

function proveExactSuffix(
  proof: ProviderPluginMessagingExpectedOwnPrefixV1,
): ProviderPluginMessagingExpectedOwnPrefixProofV1 {
  const { base, current, accepted } = proof;
  if (current.messages.length > base.contextLimit || accepted.length > current.messages.length) {
    return Object.freeze({ state: "drift" as const });
  }
  const suffixStart = current.messages.length - accepted.length;
  const visibleBase = current.messages.slice(0, suffixStart);
  const evictedBaseCount = base.messages.length - visibleBase.length;
  if (
    evictedBaseCount < 0
    || evictedBaseCount > 0 && current.messages.length !== base.contextLimit
  ) return Object.freeze({ state: "drift" as const });
  if (visibleBase.some((candidate, index) =>
    canonicalJson(baseMessage(candidate))
      !== canonicalJson(base.messages[evictedBaseCount + index]))) {
    return Object.freeze({ state: "drift" as const });
  }
  const visibleAccepted = current.messages.slice(suffixStart);
  if (visibleAccepted.some((candidate, index) => {
    const expected = accepted[index]!;
    return candidate.providerId !== expected.providerMessageId
      || candidate.providerRevision !== expected.providerRevision
      || candidate.direction !== "outgoing"
      || candidate.replyToProviderId !== expected.replyToProviderId
      || candidate.body === null
      || candidate.bodyTruncated === true
      || candidate.state !== "active"
      || sha256(candidate.body) !== expected.bodySha256;
  })) return Object.freeze({ state: "drift" as const });
  return Object.freeze({
    state: "proven" as const,
    matchedAcceptedPrefixCount: accepted.length,
  });
}

function proveLagTolerantPrefix(
  proof: ProviderPluginMessagingExpectedOwnPrefixV1,
): ProviderPluginMessagingExpectedOwnPrefixProofV1 {
  const { base, current, accepted } = proof;
  const baseIds = base.messages.map((candidate) => candidate.providerMessageId);
  const acceptedIds = accepted.map((candidate) => candidate.providerMessageId);
  const currentIds = current.messages.map((candidate) => candidate.providerId);
  if (
    base.contextLimit < 1
    || base.messages.length > base.contextLimit
    || new Set([...baseIds, ...acceptedIds]).size !== baseIds.length + acceptedIds.length
    || new Set(currentIds).size !== currentIds.length
  ) return Object.freeze({ state: "drift" as const });
  const baseById = new Map(base.messages.map((candidate) => [
    candidate.providerMessageId,
    candidate,
  ]));
  const acceptedById = new Map(accepted.map((candidate) => [
    candidate.providerMessageId,
    candidate,
  ]));
  const exactMessage = (candidate: ProviderMessageV1): boolean => {
    const baseCandidate = baseById.get(candidate.providerId);
    if (baseCandidate !== undefined) {
      return canonicalJson(baseMessage(candidate)) === canonicalJson(baseCandidate);
    }
    const acceptedCandidate = acceptedById.get(candidate.providerId);
    return acceptedCandidate !== undefined
      && candidate.providerRevision === acceptedCandidate.providerRevision
      && candidate.direction === "outgoing"
      && candidate.replyToProviderId === acceptedCandidate.replyToProviderId
      && candidate.body !== null
      && candidate.bodyTruncated !== true
      && candidate.state === "active"
      && sha256(candidate.body) === acceptedCandidate.bodySha256;
  };
  if (
    currentIds.length === baseIds.length
    && currentIds.every((id, index) => id === baseIds[index])
    && current.messages.every(exactMessage)
    && current.exactDataRevision === base.exactDataRevision
    && current.latestMessageRevision === base.latestMessageRevision
  ) return Object.freeze({
    state: "proven" as const,
    matchedAcceptedPrefixCount: 0,
  });
  for (let count = 1; count <= accepted.length; count += 1) {
    const expectedWindow = [...baseIds, ...acceptedIds.slice(0, count)].slice(
      -base.contextLimit,
    );
    if (
      currentIds.length === expectedWindow.length
      && currentIds.every((id, index) => id === expectedWindow[index])
      && current.messages.every(exactMessage)
    ) return Object.freeze({
      state: "proven" as const,
      matchedAcceptedPrefixCount: count,
    });
  }
  return Object.freeze({ state: "drift" as const });
}

function inputSchema(
  name:
    | "messaging.list"
    | "messaging.read"
    | "messaging.send"
    | "conversations.read",
): InputSchema {
  return Object.freeze({
    properties: Object.freeze({
      account_id: Object.freeze({
        type: "string" as const,
        description: "Exact synthetic account",
        minLength: 1,
        maxLength: 64,
      }),
      conversation_id: Object.freeze({
        type: "string" as const,
        description: "Exact synthetic conversation",
        minLength: 1,
        maxLength: 128,
      }),
      limit: Object.freeze({
        type: "number" as const,
        description: "Bounded page size",
        minimum: 1,
        maximum: 200,
      }),
      text: Object.freeze({
        type: "string" as const,
        description: "Exact message body",
        minLength: 1,
        maxLength: 65_536,
      }),
      reply_to: Object.freeze({
        type: "string" as const,
        description: "Exact provider reply target",
        minLength: 1,
        maxLength: 128,
      }),
    }),
    required: Object.freeze(name === "messaging.list"
      ? ["account_id", "limit"]
      : name === "messaging.read" || name === "conversations.read"
        ? ["account_id", "conversation_id", "limit"]
        : ["account_id", "conversation_id", "text"]),
  });
}

function operation(
  name:
    | "messaging.list"
    | "messaging.read"
    | "messaging.send"
    | "conversations.read",
): WebSessionPluginOperationDefinitionV1 {
  const send = name === "messaging.send";
  return Object.freeze({
    name,
    contractVersion: 1,
    risk: send ? "R3" : "R1",
    input: inputSchema(name),
    sideEffect: send ? "submits one synthetic message" : "none",
    idempotency: send ? "local-at-most-once" : "none",
    dedupeWindowMs: send ? 300_000 : 0,
    state: "observed",
    dispatch: send ? "single" : "none",
    implementation: `synthetic fourth-provider ${name}`,
    planDispatches: () => send
      ? [{ id: "messaging.send", description: "Submit one exact synthetic message" }]
      : [],
    validateInput: () => [],
    ...(send ? {} : {
      omni: Object.freeze({
        state: "supported" as const,
        schemaVersion: 1 as const,
        materializerId: `synthetic-fourth-${name.replace(".", "-")}`,
        materializerVersion: 1,
        materialize: (_input: OperationInput, output: unknown) => output,
      }),
    }),
  });
}

function manifest() {
  const operations = [
    "messaging.list",
    "messaging.read",
    "conversations.read",
    "messaging.send",
  ] as const;
  return {
    schemaVersion: 4,
    id: "synthetic-fourth-adapter",
    version: "1.0.0",
    displayName: "Synthetic Fourth Adapter",
    surfaceId: "synthetic-fourth",
    origins: ["https://synthetic-fourth.example"],
    browserDomains: ["synthetic-fourth.example"],
    operations: Object.fromEntries(operations.map((name) => {
      const definition = operation(name);
      return [name, {
        description: definition.implementation,
        risk: definition.risk,
        sideEffect: definition.sideEffect,
        idempotency: definition.idempotency,
        dedupeWindowMs: definition.dedupeWindowMs,
        input: definition.input,
        webSession: {
          site: "synthetic-fourth",
          action: name,
          contractVersion: 1,
          timeoutMs: 60_000,
          maxOutputBytes: 1_048_576,
        },
      }];
    })),
  };
}

async function harness(partCount: number, options: HarnessOptions = {}) {
  const freshState = sharedRoot === null;
  const root = sharedRoot ?? mkdtempSync(join(tmpdir(), "wrench-messaging-execution-"));
  if (freshState) {
    chmodSync(root, 0o700);
    roots.push(root);
    sharedRoot = root;
  }
  const environment = Object.freeze({ WRENCH_STATE_HOME: root });
  const contextLimit = options.contextLimit ?? 3;
  const messages: ProviderMessageV1[] = [
    message("base-1", "older incoming", "2026-08-27T12:00:00.000Z", {
      direction: "incoming",
    }),
    message("base-2", "newer incoming", "2026-08-27T12:01:00.000Z", {
      direction: "incoming",
    }),
  ];
  let attempts = 0;
  let dispatches = 0;
  let capturedFence: (() => Promise<void>) | null = null;
  let resolveCapturedFence: ((fence: () => Promise<void>) => void) | null = null;
  const capturedFenceReady = new Promise<() => Promise<void>>((resolve) => {
    resolveCapturedFence = resolve;
  });
  activePrefixProof = options.prefixProof ?? proveExactSuffix;
  activeRouteParticipantFingerprint = participantFingerprint;
  activeAfterContextRead = options.afterContextRead ?? null;
  confirmationReadsActive = false;

  const page = (limit: number): ProviderMaterializedPageV1 => Object.freeze({
    schemaVersion: 1,
    partition: roomId,
    completeness: Object.freeze({ kind: "complete", reason: "synthetic exact page" }),
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: Object.freeze(messages.slice(-limit)),
    tombstones: Object.freeze([]),
  });
  activePage = page;
  activePartExecutor = async (_operation, input, _auth, attempt) => {
    const index = attempts;
    attempts += 1;
    const behavior = options.behavior?.(index) ?? "success";
    const pendingId = `accepted-${index + 1}`;
    if (behavior === "fail-before-fence") throw new Error("synthetic pre-dispatch failure");
    if (behavior === "private-outcome-before-fence") {
      await attempt.recordPrivateIndeterminateOutcome("still_in_flight");
    }
    if (behavior === "omit-fence") return { pendingId };
    if (behavior === "capture-fence") {
      capturedFence = attempt.beforeExternalBegin;
      resolveCapturedFence?.(attempt.beforeExternalBegin);
      return new Promise<never>(() => undefined);
    }
    if (behavior === "expire-before-fence") options.beforeFence?.();
    await attempt.beforeExternalBegin();
    dispatches += 1;
    if (behavior === "expire-after-fence") options.afterFence?.();
    const acceptedMessage = message(
      pendingId,
      input.text as string,
      `2026-08-27T12:${String(index + 2).padStart(2, "0")}:00.000Z`,
      {
        replyToProviderId: typeof input.reply_to === "string" ? input.reply_to : null,
      },
    );
    messages.push(acceptedMessage);
    options.afterMutation?.(messages, index);
    if (behavior === "private-outcome-after-fence") {
      await attempt.recordPrivateIndeterminateOutcome(
        options.privateOutcomeCode ?? "still_in_flight",
      );
    }
    if (behavior === "invalid-private-outcome-after-fence") {
      await attempt.recordPrivateIndeterminateOutcome("private body must not fit");
    }
    if (behavior === "double-fence") await attempt.beforeExternalBegin();
    if (behavior === "fail-after-fence") throw new Error("synthetic post-dispatch failure");
    if (behavior === "malformed-after-fence") return { pendingId: null };
    return { pendingId };
  };
  const messaging = Object.freeze({
    schemaVersion: 1,
    contractId: "wrench.provider-messaging.synthetic-fourth.v1",
    network: "synthetic-fourth",
    contextLiveness: "fresh-as-of-live-preflight",
    listOperation: "messaging.list",
    contextOperation: "messaging.read",
    coordinateKind: "beeperConversation",
    enumerateRoutes: () => Object.freeze([]),
    resolveRoute: Object.freeze({
      operation: "conversations.read",
      input: (input: OperationInput) => Object.freeze({
        account_id: input.account_id as string,
        conversation_id: roomId,
        limit: contextLimit,
      }),
      candidates: () => Object.freeze([Object.freeze({
        target: Object.freeze({ accountId: "account", conversationId: roomId }),
        conversationProviderId: roomId,
        conversationKind: "single" as const,
        title: "Private Synthetic Recipient",
        participants,
        providerRevision: "route-revision-1",
      })]),
      sourceConversationCoordinate: () => Object.freeze({
        contractId: "wrench.message-like-me.source-conversation-coordinate.v1" as const,
        schemaVersion: 1 as const,
        sha256: "b".repeat(64),
      }),
    }),
    parseTarget: (value: unknown) => {
      if (
        typeof value !== "object"
        || value === null
        || Array.isArray(value)
        || (value as { accountId?: unknown }).accountId !== "account"
        || (value as { conversationId?: unknown }).conversationId !== roomId
      ) throw new Error("synthetic target is malformed");
      return Object.freeze({ accountId: "account", conversationId: roomId });
    },
    contextInput: (_target: Readonly<Record<string, string>>, limit: number) => Object.freeze({
      account_id: "account",
      conversation_id: roomId,
      limit,
    }),
    action: Object.freeze({
      state: "supported",
      operation: "messaging.send",
      reply: "supported",
      livePreflight: Object.freeze({
        operation: "conversations.read",
        input: () => Object.freeze({
          account_id: "account",
          limit: contextLimit,
        }),
        snapshot: () => Object.freeze({
          conversationProviderId: roomId,
          network: "synthetic-fourth",
          conversation: Object.freeze({
            kind: "single" as const,
            title: "Private Synthetic Recipient",
            participantCount: participants.length,
          }),
          sourceConversationCoordinate: Object.freeze({
            contractId: "wrench.message-like-me.source-conversation-coordinate.v1" as const,
            schemaVersion: 1 as const,
            sha256: "b".repeat(64),
          }),
          participantFingerprint: activeRouteParticipantFingerprint,
          providerRevision: "route-revision-1",
        }),
      }),
      compileTurnPart: (_target: Readonly<Record<string, string>>, part: {
        readonly text: string;
        readonly replyToProviderId: string | null;
      }) => Object.freeze({
        account_id: "account",
        conversation_id: roomId,
        text: part.text,
        ...(part.replyToProviderId === null ? {} : { reply_to: part.replyToProviderId }),
      }),
      mapAcceptedResult: (output: unknown) => {
        if (
          typeof output !== "object"
          || output === null
          || typeof (output as { pendingId?: unknown }).pendingId !== "string"
        ) throw new Error("synthetic acceptance is malformed");
        return Object.freeze({
          state: "submitted" as const,
          providerMessageId: (output as { pendingId: string }).pendingId,
          providerRevision: `revision-${(output as { pendingId: string }).pendingId}`,
        });
      },
      proveExpectedOwnPrefix: (
        proof: ProviderPluginMessagingExpectedOwnPrefixV1,
      ) => activePrefixProof(proof),
      reconciliation: () => Object.freeze({
        operation: "messaging.read",
        input: Object.freeze({ account_id: "account", conversation_id: roomId, limit: contextLimit }),
      }),
    }),
  }) satisfies ProviderPluginMessagingDefinitionV1;

  const registry = cachedRegistry ?? (() => {
    const plugin = defineProviderPlugin({
      apiVersion: 1,
      id: "synthetic-fourth-messaging-execution",
      version: "1.0.0",
      displayName: "Synthetic Fourth Messaging Execution",
      sourceKind: "source",
      implementationSources: [{ label: "plugin.ts", url: sourceUrl }],
      bindings: [{
        transport: "web-session-api",
        surfaceId: "synthetic-fourth",
        origin: "https://synthetic-fourth.example",
        authKinds: ["cookie-source"],
        operations: [
          operation("messaging.list"),
          operation("messaging.read"),
          operation("conversations.read"),
          operation("messaging.send"),
        ],
        messaging,
        subject: {
          format: "synthetic-fourth:<id>",
          matches: (value) => value === "synthetic-fourth:account",
        },
        runtime: lazyWebSessionRuntime(() => Promise.resolve({
          probe: () => Promise.resolve("synthetic-fourth:account"),
          execute: (_manifest, recipe, input) => {
            if (activePage === null) throw new Error("synthetic page harness is unavailable");
            const output = activePage(typeof input.limit === "number" ? input.limit : 3);
            if (confirmationReadsActive && recipe.action === "messaging.read") {
              activeAfterContextRead?.();
            }
            return Promise.resolve({
              status: "succeeded" as const,
              output,
              finalUrl: "https://synthetic-fourth.example/messages",
              dispatchStarted: false,
              dispatch: { planned: 0, started: 0, verified: 0 },
            });
          },
          executeMessagingPart: (...arguments_) => {
            if (activePartExecutor === null) {
              throw new Error("synthetic action harness is unavailable");
            }
            return activePartExecutor(...arguments_);
          },
        })),
      }],
    });
    cachedRegistry = createProviderPluginRegistry([plugin]);
    return cachedRegistry;
  })();
  const parsed = parseRuntimeManifest(manifest(), registry);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  if (freshState) {
    installManifest(parsed.value, { force: false, environment, registry });
    saveAuth(createAuth("synthetic-fourth-auth", {
      source: "chrome",
      subject: "synthetic-fourth:account",
    }), environment);
  }
  const observation = new Date();
  const route = await resolveMessagingRouteInternal({
    schemaVersion: 1,
    format: "wrench.messaging-route-resolve-request",
    source: {
      adapterId: parsed.value.id,
      authId: "synthetic-fourth-auth",
      listInput: { account_id: "account", limit: contextLimit },
    },
    candidate: {
      coordinate: {
        kind: "beeperConversation",
        network: "synthetic-fourth",
        conversationId: roomId,
      },
    },
  }, { environment, registry, now: observation });
  const context = await readMessagingContextInternal({
    schemaVersion: 1,
    format: "wrench.messaging-context-request",
    routeRef: route.routeRef,
    limit: contextLimit,
  }, { environment, registry, now: observation });
  const preview = await previewMessagingTurnInternal({
    schemaVersion: 1,
    format: "wrench.messaging-turn",
    clientIntentSha256: "a".repeat(64),
    routeRef: route.routeRef,
    contextRef: context.binding.contextRef,
    parts: Array.from({ length: partCount }, (_unused, index) => ({
      partId: `part-${index + 1}`,
      text: `private bubble ${index + 1}`,
      replyRef: null,
    })),
  }, { environment, registry, now: observation });
  confirmationReadsActive = true;
  return Object.freeze({
    root,
    environment,
    registry,
    preview,
    observation,
    messages,
    attempts: () => attempts,
    dispatches: () => dispatches,
    capturedFence: () => capturedFence,
    capturedFenceReady,
  });
}

describe("generic messaging composite execution", () => {
  test("keeps list candidates non-actionable until exact coordinate resolution", async () => {
    const setup = await harness(1);
    const routes = await discoverMessagingRoutesInternal({
      schemaVersion: 1,
      format: "wrench.messaging-routes-request",
      source: {
        adapterId: "synthetic-fourth-adapter",
        authId: "synthetic-fourth-auth",
        listInput: { account_id: "account", limit: 3 },
      },
    }, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    });
    expect(routes.routes[0]?.readiness).toMatchObject({
      context: "resolution-required",
      turn: "unavailable",
      reply: "unsupported",
    });
    await expect(readMessagingContextInternal({
      schemaVersion: 1,
      format: "wrench.messaging-context-request",
      routeRef: routes.routes[0]!.routeRef,
      limit: 3,
    }, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    })).rejects.toThrow("requires exact conversations.read resolution");
  });

  for (const partCount of [1, 2, 3]) {
    test(`submits ${partCount} bubble${partCount === 1 ? "" : "s"} under one run with one dispatch each`, async () => {
      const setup = await harness(partCount);
      const result = await confirmMessagingInvocation(setup.preview.planDigest, {
        environment: setup.environment,
        registry: setup.registry,
        now: setup.observation,
      });
      expect(result.run).toMatchObject({
        state: "submitted",
        partCount,
        provenPartCount: partCount,
        observedAcceptedPrefixCount: Math.max(0, partCount - 1),
      });
      expect(new Set(result.run.parts.map((part) => part.providerMessageId)).size).toBe(partCount);
      expect(setup.attempts()).toBe(partCount);
      expect(setup.dispatches()).toBe(partCount);

      const publicBytes = canonicalJson({
        receipt: result.receipt,
        receiptBinding: result.receiptBinding,
        ordinaryReceipt: result.ordinaryReceipt,
      });
      expect(publicBytes).not.toContain("observedAcceptedPrefixCount");
      for (let index = 1; index <= partCount; index += 1) {
        expect(publicBytes).not.toContain(`private bubble ${index}`);
        expect(publicBytes).not.toContain(`accepted-${index}`);
      }
      const encrypted = readFileSync(
        join(setup.root, "messaging", "runs", `${result.run.runId}.json`),
        "utf8",
      );
      expect(encrypted).not.toContain("private bubble");
      expect(encrypted).not.toContain("accepted-");
    });
  }

  test("allows initial provider lag before any accepted prefix has been observed", async () => {
    const setup = await harness(2, {
      prefixProof: proveLagTolerantPrefix,
      afterMutation: (messages, index) => {
        if (index === 0) messages.pop();
      },
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    });
    expect(result.run).toMatchObject({
      state: "submitted",
      provenPartCount: 2,
      observedAcceptedPrefixCount: 0,
    });
    expect(setup.dispatches()).toBe(2);
  });

  test("stops when a previously observed accepted prefix regresses", async () => {
    const setup = await harness(3, {
      prefixProof: proveLagTolerantPrefix,
      afterMutation: (messages, index) => {
        if (index === 1) messages.splice(2);
      },
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    });
    expect(result.run).toMatchObject({
      state: "partial",
      provenPartCount: 2,
      observedAcceptedPrefixCount: 1,
      terminalReason: "context-drift",
    });
    expect(setup.dispatches()).toBe(2);
  });

  test("rejects malformed accepted-prefix proof counts before dispatch", async () => {
    const setup = await harness(1, {
      prefixProof: () => ({
        state: "proven",
        matchedAcceptedPrefixCount: "invalid",
      } as unknown as ProviderPluginMessagingExpectedOwnPrefixProofV1),
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    });
    expect(result.run).toMatchObject({
      state: "failed",
      provenPartCount: 0,
      observedAcceptedPrefixCount: 0,
      terminalReason: "prefix-freshness-unproven",
    });
    expect(setup.dispatches()).toBe(0);
  });

  test("rechecks route participants after reading the current context", async () => {
    const setup = await harness(1, {
      afterContextRead: () => {
        activeRouteParticipantFingerprint = "f".repeat(64);
      },
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    });
    expect(result.run).toMatchObject({
      state: "failed",
      provenPartCount: 0,
      terminalReason: "prefix-freshness-unproven",
    });
    expect(setup.dispatches()).toBe(0);
  });

  for (const [name, mutate] of [
    ["incoming suffix", (messages: ProviderMessageV1[]) => messages.push(message(
      "foreign-incoming",
      "foreign body",
      "2026-08-27T12:10:00.000Z",
      { direction: "incoming" },
    ))],
    ["edited accepted message", (messages: ProviderMessageV1[]) => {
      const last = messages.at(-1)!;
      messages[messages.length - 1] = message(
        last.providerId,
        "edited body",
        last.orderedAt!,
        { providerRevision: "edited-revision" },
      );
    }],
    ["deleted accepted message", (messages: ProviderMessageV1[]) => {
      messages.pop();
    }],
    ["extra outgoing suffix", (messages: ProviderMessageV1[]) => messages.push(message(
      "foreign-outgoing",
      "foreign body",
      "2026-08-27T12:10:00.000Z",
    ))],
    ["reordered window", (messages: ProviderMessageV1[]) => messages.reverse()],
  ] as const) {
    test(`stops the remaining suffix after ${name}`, async () => {
      const setup = await harness(2, {
        afterMutation: (messages, index) => {
          if (index === 0) mutate(messages);
        },
      });
      const result = await confirmMessagingInvocation(setup.preview.planDigest, {
        environment: setup.environment,
        registry: setup.registry,
        now: setup.observation,
      });
      expect(result.run).toMatchObject({
        state: "partial",
        provenPartCount: 1,
        terminalReason: "context-drift",
      });
      expect(setup.dispatches()).toBe(1);
    });
  }

  test("stops before the third bubble when the bounded window evicts the accepted prefix", async () => {
    const setup = await harness(3, {
      afterMutation: (messages, index) => {
        if (index !== 1) return;
        messages.push(message("foreign-1", "foreign", "2026-08-27T12:20:00.000Z", {
          direction: "incoming",
        }));
        messages.push(message("foreign-2", "foreign", "2026-08-27T12:21:00.000Z", {
          direction: "incoming",
        }));
      },
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    });
    expect(result.run).toMatchObject({
      state: "partial",
      provenPartCount: 2,
      terminalReason: "context-drift",
    });
    expect(setup.dispatches()).toBe(2);
  });

  test("classifies failures before the durable fence as failed or partial", async () => {
    const failed = await harness(2, {
      behavior: (attempt) => attempt === 0 ? "fail-before-fence" : "success",
    });
    const failedResult = await confirmMessagingInvocation(failed.preview.planDigest, {
      environment: failed.environment,
      registry: failed.registry,
      now: failed.observation,
    });
    expect(failedResult.run).toMatchObject({
      state: "failed",
      provenPartCount: 0,
      terminalReason: "provider-failed-before-dispatch",
    });
    expect(failed.dispatches()).toBe(0);

    const partial = await harness(3, {
      behavior: (attempt) => attempt === 1 ? "fail-before-fence" : "success",
    });
    const partialResult = await confirmMessagingInvocation(partial.preview.planDigest, {
      environment: partial.environment,
      registry: partial.registry,
      now: partial.observation,
    });
    expect(partialResult.run).toMatchObject({
      state: "partial",
      provenPartCount: 1,
      terminalReason: "provider-failed-before-dispatch",
    });
    expect(partial.dispatches()).toBe(1);
  });

  for (const behavior of ["fail-after-fence", "malformed-after-fence"] as const) {
    test(`classifies ${behavior} as indeterminate`, async () => {
      const setup = await harness(2, { behavior: () => behavior });
      const result = await confirmMessagingInvocation(setup.preview.planDigest, {
        environment: setup.environment,
        registry: setup.registry,
        now: setup.observation,
      });
      expect(result.run).toMatchObject({
        state: "indeterminate",
        provenPartCount: 0,
        possibleSubmittedPartIndex: 0,
        terminalReason: "provider-result-indeterminate",
      });
      expect(setup.dispatches()).toBe(1);
    });
  }

  for (const code of [
    "not_started",
    "may_have_completed",
    "still_in_flight",
    "unknown_post_dispatch",
  ] as const) {
    test(`keeps ${code} encrypted, out of ordinary receipts, and unretriable`, async () => {
      const setup = await harness(1, {
        behavior: () => "private-outcome-after-fence",
        privateOutcomeCode: code,
      });
      const result = await confirmMessagingInvocation(setup.preview.planDigest, {
        environment: setup.environment,
        registry: setup.registry,
        now: setup.observation,
      });
      expect(result.run).toMatchObject({
        state: "indeterminate",
        provenPartCount: 0,
        possibleSubmittedPartIndex: 0,
        terminalReason: "provider-result-indeterminate",
        privateProviderOutcome: {
          schemaVersion: 1,
          messagingContractId: "wrench.provider-messaging.synthetic-fourth.v1",
          code,
        },
      });
      expect(setup.dispatches()).toBe(1);
      expect(setup.attempts()).toBe(1);

      const publicBytes = canonicalJson({
        receipt: result.receipt,
        receiptBinding: result.receiptBinding,
        ordinaryReceipt: result.ordinaryReceipt,
      });
      expect(publicBytes).not.toContain(code);
      expect(publicBytes).not.toContain("synthetic-fourth.v1");
      const encrypted = readFileSync(
        join(setup.root, "messaging", "runs", `${result.run.runId}.json`),
        "utf8",
      );
      expect(encrypted).not.toContain(code);
      expect(encrypted).not.toContain("synthetic-fourth.v1");

      await expect(confirmMessagingInvocation(setup.preview.planDigest, {
        environment: setup.environment,
        registry: setup.registry,
        now: setup.observation,
      })).rejects.toThrow();
      expect(setup.dispatches()).toBe(1);
    });
  }

  test("rejects pre-fence or non-symbolic private outcomes without enabling retry", async () => {
    const beforeFence = await harness(1, {
      behavior: () => "private-outcome-before-fence",
    });
    const beforeFenceResult = await confirmMessagingInvocation(
      beforeFence.preview.planDigest,
      {
        environment: beforeFence.environment,
        registry: beforeFence.registry,
        now: beforeFence.observation,
      },
    );
    expect(beforeFenceResult.run).toMatchObject({
      state: "failed",
      terminalReason: "provider-failed-before-dispatch",
      privateProviderOutcome: null,
    });
    expect(beforeFence.dispatches()).toBe(0);

    const invalid = await harness(1, {
      behavior: () => "invalid-private-outcome-after-fence",
    });
    const invalidResult = await confirmMessagingInvocation(invalid.preview.planDigest, {
      environment: invalid.environment,
      registry: invalid.registry,
      now: invalid.observation,
    });
    expect(invalidResult.run).toMatchObject({
      state: "indeterminate",
      terminalReason: "provider-result-indeterminate",
      privateProviderOutcome: null,
    });
    expect(invalid.dispatches()).toBe(1);
    await expect(confirmMessagingInvocation(invalid.preview.planDigest, {
      environment: invalid.environment,
      registry: invalid.registry,
      now: invalid.observation,
    })).rejects.toThrow();
    expect(invalid.dispatches()).toBe(1);
  });

  test("requires exactly one durable provider fence", async () => {
    const omitted = await harness(1, { behavior: () => "omit-fence" });
    const omittedResult = await confirmMessagingInvocation(omitted.preview.planDigest, {
      environment: omitted.environment,
      registry: omitted.registry,
      now: omitted.observation,
    });
    expect(omittedResult.run).toMatchObject({
      state: "failed",
      terminalReason: "provider-failed-before-dispatch",
    });
    expect(omitted.dispatches()).toBe(0);

    const doubled = await harness(1, { behavior: () => "double-fence" });
    const doubledResult = await confirmMessagingInvocation(doubled.preview.planDigest, {
      environment: doubled.environment,
      registry: doubled.registry,
      now: doubled.observation,
    });
    expect(doubledResult.run).toMatchObject({
      state: "indeterminate",
      terminalReason: "provider-result-indeterminate",
    });
    expect(doubled.dispatches()).toBe(1);
  });

  test("uses one total deadline across preflight and effect and expires before the fence", async () => {
    const clock = new ManualDeadlineClock();
    let contextReads = 0;
    let effectReached = false;
    const setup = await harness(1, {
      behavior: () => "expire-before-fence",
      afterContextRead: () => {
        contextReads += 1;
        clock.advance(30_000);
      },
      beforeFence: () => {
        effectReached = true;
        clock.advance(30_000);
      },
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
      deadlineClock: clock,
    });
    expect(result.run).toMatchObject({
      state: "failed",
      provenPartCount: 0,
      terminalReason: "provider-failed-before-dispatch",
    });
    expect(contextReads).toBe(1);
    expect(effectReached).toBeTrue();
    expect(setup.attempts()).toBe(1);
    expect(setup.dispatches()).toBe(0);
  });

  test("classifies expiry after the durable fence as indeterminate", async () => {
    const clock = new ManualDeadlineClock();
    const setup = await harness(1, {
      behavior: () => "expire-after-fence",
      afterFence: () => clock.advance(60_000),
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
      deadlineClock: clock,
    });
    expect(result.run).toMatchObject({
      state: "indeterminate",
      provenPartCount: 0,
      possibleSubmittedPartIndex: 0,
      terminalReason: "provider-result-indeterminate",
    });
    expect(setup.attempts()).toBe(1);
    expect(setup.dispatches()).toBe(1);
  });

  test("rejects a captured fence after expiry terminalizes the run", async () => {
    const clock = new ManualDeadlineClock();
    const setup = await harness(1, { behavior: () => "capture-fence" });
    const confirmation = confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
      deadlineClock: clock,
    });
    const capturedFence = await setup.capturedFenceReady;
    expect(setup.capturedFence()).toBe(capturedFence);
    clock.advance(60_000);
    const result = await confirmation;
    expect(result.run).toMatchObject({
      state: "failed",
      provenPartCount: 0,
      terminalReason: "provider-failed-before-dispatch",
    });
    await expect(capturedFence()).rejects.toThrow();
    expect(setup.dispatches()).toBe(0);
    expect(showMessagingRunInternal(result.run.runId, {
      environment: setup.environment,
    }).run).toEqual(result.run);
  });

  test("racing confirmations cannot duplicate any provider mutation", async () => {
    const setup = await harness(3);
    const results = await Promise.allSettled([
      confirmMessagingInvocation(setup.preview.planDigest, {
        environment: setup.environment,
        registry: setup.registry,
        now: setup.observation,
      }),
      confirmMessagingInvocation(setup.preview.planDigest, {
        environment: setup.environment,
        registry: setup.registry,
        now: setup.observation,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(setup.dispatches()).toBe(3);
    expect(setup.attempts()).toBe(3);
  });
});
