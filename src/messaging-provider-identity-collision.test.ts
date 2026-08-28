import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth, saveAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import { parseRuntimeManifest, type InputSchema, type OperationInput } from "./model";
import {
  previewMessagingTurnInternal,
  readMessagingContextInternal,
  resolveMessagingRouteInternal,
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
let cachedRegistry: ReturnType<typeof createProviderPluginRegistry> | null = null;

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Behavior =
  | "success"
  | "fail-before-fence"
  | "fail-after-fence"
  | "malformed-after-fence"
  | "omit-fence"
  | "double-fence";

type HarnessOptions = {
  readonly behavior?: (attempt: number) => Behavior;
  readonly afterMutation?: (messages: ProviderMessageV1[], attempt: number) => void;
  readonly contextLimit?: number;
  readonly acceptedId?: (attempt: number) => string;
};

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
    ...(send || name === "conversations.read" ? {} : {
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
  const root = mkdtempSync(join(tmpdir(), "wrench-messaging-identity-"));
  chmodSync(root, 0o700);
  roots.push(root);
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
    const pendingId = options.acceptedId?.(index) ?? `accepted-${index + 1}`;
    if (behavior === "fail-before-fence") throw new Error("synthetic pre-dispatch failure");
    if (behavior === "omit-fence") return { pendingId };
    await attempt.beforeExternalBegin();
    dispatches += 1;
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
          conversation_id: roomId,
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
          participantFingerprint,
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
      proveExpectedOwnPrefix: proveExactSuffix,
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
          execute: (_manifest, _recipe, input) => {
            if (activePage === null) throw new Error("synthetic page harness is unavailable");
            return Promise.resolve({
              status: "succeeded" as const,
              output: activePage(typeof input.limit === "number" ? input.limit : 3),
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
  installManifest(parsed.value, { force: false, environment, registry });
  saveAuth(createAuth("synthetic-fourth-auth", {
    source: "chrome",
    subject: "synthetic-fourth:account",
  }), environment);
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
  if (context.binding === null) {
    throw new Error("synthetic actionable context lost its binding");
  }
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
  return Object.freeze({
    root,
    environment,
    registry,
    preview,
    observation,
    messages,
    attempts: () => attempts,
    dispatches: () => dispatches,
  });
}


describe("messaging accepted provider identity binding", () => {
  test("treats reuse of a preview-base identity after the provider fence as indeterminate", async () => {
    const setup = await harness(1, { acceptedId: () => "base-1" });
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
    await expect(confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    })).rejects.toThrow();
    expect(setup.dispatches()).toBe(1);
  });

  test("treats reuse of an earlier accepted identity after the next fence as indeterminate", async () => {
    const setup = await harness(2, {
      acceptedId: () => "accepted-1",
    });
    const result = await confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    });
    expect(result.run).toMatchObject({
      state: "indeterminate",
      provenPartCount: 1,
      possibleSubmittedPartIndex: 1,
      terminalReason: "provider-result-indeterminate",
    });
    expect(result.run.parts[0]?.providerMessageId).toBe("accepted-1");
    expect(setup.dispatches()).toBe(2);
    await expect(confirmMessagingInvocation(setup.preview.planDigest, {
      environment: setup.environment,
      registry: setup.registry,
      now: setup.observation,
    })).rejects.toThrow();
    expect(setup.dispatches()).toBe(2);
  });
});
