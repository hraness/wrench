import { describe, expect, test } from "bun:test";

import type { InputSchema, OperationInput } from "./model";
import type { MessagingRouteCoordinateV1 } from "./messaging-types";
import type { ProviderMaterializedPageV1 } from "./omni-model";
import {
  defineProviderPlugin,
  lazyWebSessionRuntime,
  type ProviderPluginMessagingDefinitionV1,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";

function operation(
  name: "messaging.list" | "messaging.read" | "messaging.send",
): WebSessionPluginOperationDefinitionV1 {
  const send = name === "messaging.send";
  const input = {
    properties: {
      account_id: { type: "string", description: "Exact account", minLength: 1, maxLength: 64 },
      conversation_id: { type: "string", description: "Exact conversation", minLength: 1, maxLength: 128 },
      limit: { type: "number", description: "Bound", minimum: 1, maximum: 200 },
      text: { type: "string", description: "Body", minLength: 1, maxLength: 65_536 },
      reply_to: { type: "string", description: "Exact reply", minLength: 1, maxLength: 128 },
    },
    required: name === "messaging.list"
      ? ["account_id", "limit"]
      : name === "messaging.read"
        ? ["account_id", "conversation_id", "limit"]
        : ["account_id", "conversation_id", "text"],
  } satisfies InputSchema;
  return Object.freeze({
    name,
    contractVersion: 1,
    risk: send ? "R3" : "R1",
    input,
    sideEffect: send ? "submits one synthetic message" : "none",
    idempotency: send ? "local-at-most-once" : "none",
    dedupeWindowMs: send ? 300_000 : 0,
    state: "observed",
    dispatch: send ? "single" : "none",
    implementation: `synthetic fourth-provider ${name}`,
    planDispatches: () => send
      ? [{ id: "messaging.send", description: "Submit one exact message" }]
      : [],
    validateInput: () => [],
    ...(send
      ? {}
      : {
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

function target(value: unknown): Readonly<Record<string, string>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== "accountId,conversationId"
  ) throw new Error("synthetic target is malformed");
  const source = value as Record<string, unknown>;
  if (typeof source.accountId !== "string" || typeof source.conversationId !== "string") {
    throw new Error("synthetic target is malformed");
  }
  return Object.freeze({
    accountId: source.accountId,
    conversationId: source.conversationId,
  });
}

const messaging = Object.freeze({
  schemaVersion: 1,
  contractId: "wrench.provider-messaging.synthetic-fourth.v1",
  network: "synthetic-fourth",
  contextLiveness: "fresh-as-of-live-preflight",
  listOperation: "messaging.list",
  contextOperation: "messaging.read",
  coordinateKind: "whatsappJid",
  enumerateRoutes: (input: OperationInput, page: ProviderMaterializedPageV1) =>
    Object.freeze(page.entities.map((entity) => {
      if (entity.kind !== "conversation" || typeof input.account_id !== "string") {
        throw new Error("synthetic list projection changed");
      }
      return Object.freeze({
        target: Object.freeze({ accountId: input.account_id, conversationId: entity.providerId }),
        conversationProviderId: entity.providerId,
        conversationKind: "unknown" as const,
        title: entity.title,
        participants: entity.participants,
        providerRevision: entity.providerRevision,
      });
    })),
  resolveRoute: Object.freeze({
    operation: "messaging.read",
    input: (input: OperationInput, coordinate: MessagingRouteCoordinateV1) => {
      if (coordinate.kind !== "whatsappJid") throw new Error("wrong coordinate kind");
      return Object.freeze({
        account_id: input.account_id as string,
        conversation_id: coordinate.jid,
        limit: 1,
      });
    },
    candidates: (input: OperationInput, coordinate: MessagingRouteCoordinateV1) => {
      if (coordinate.kind !== "whatsappJid") throw new Error("wrong coordinate kind");
      return Object.freeze([
        Object.freeze({
          target: Object.freeze({
            accountId: input.account_id as string,
            conversationId: coordinate.jid,
          }),
          conversationProviderId: coordinate.jid,
          conversationKind: "unknown" as const,
          title: null,
          participants: Object.freeze([]),
          providerRevision: null,
        }),
      ]);
    },
  }),
  parseTarget: target,
  contextInput: (value, limit) => {
    const parsed = target(value);
    return Object.freeze({
      account_id: parsed.accountId!,
      conversation_id: parsed.conversationId!,
      limit,
    });
  },
  action: Object.freeze({
    state: "supported",
    operation: "messaging.send",
    reply: "supported",
    compileTurnPart: (value, part) => {
      const parsed = target(value);
      return Object.freeze({
        account_id: parsed.accountId!,
        conversation_id: parsed.conversationId!,
        text: part.text,
        ...(part.replyToProviderId === null ? {} : { reply_to: part.replyToProviderId }),
      });
    },
    mapAcceptedResult: (output: unknown) => {
      if (
        typeof output !== "object"
        || output === null
        || !("pendingId" in output)
        || typeof output.pendingId !== "string"
      ) throw new Error("synthetic acceptance changed");
      return Object.freeze({ state: "submitted" as const, providerMessageId: output.pendingId });
    },
    reconciliation: (value, accepted) => {
      const parsed = target(value);
      return Object.freeze({
        operation: "messaging.read",
        input: Object.freeze({
          account_id: parsed.accountId!,
          conversation_id: parsed.conversationId!,
          limit: 1,
          accepted_id: accepted.providerMessageId,
        }),
      });
    },
  }),
} satisfies ProviderPluginMessagingDefinitionV1);

describe("provider messaging SPI conformance", () => {
  test("conforms a synthetic fourth provider without kernel provider branching", () => {
    const plugin = defineProviderPlugin({
      apiVersion: 1,
      id: "synthetic-fourth-messaging",
      version: "1.0.0",
      displayName: "Synthetic Fourth Messaging",
      sourceKind: "source",
      implementationSources: [{
        label: "plugin.ts",
        url: new URL("./provider-plugin-test-fixture.ts", import.meta.url),
      }],
      bindings: [{
        transport: "web-session-api",
        surfaceId: "synthetic-fourth",
        origin: "https://synthetic-fourth.example",
        authKinds: ["cookie-source"],
        operations: [
          operation("messaging.list"),
          operation("messaging.read"),
          operation("messaging.send"),
        ],
        messaging,
        subject: {
          format: "synthetic-fourth:<id>",
          matches: (value) => value === "synthetic-fourth:account",
        },
        runtime: lazyWebSessionRuntime(() => Promise.resolve({
          probe: () => Promise.resolve("synthetic-fourth:account"),
          execute: () => Promise.resolve({
            status: "failed" as const,
            output: null,
            finalUrl: "https://synthetic-fourth.example",
            dispatchStarted: false,
            dispatch: { planned: 0, started: 0, verified: 0 },
          }),
        })),
      }],
    });
    const conformed = plugin.bindings[0]!.messaging;
    expect(conformed?.contractId).toBe(messaging.contractId);
    expect(conformed?.coordinateKind).toBe("whatsappJid");
    expect(conformed?.resolveRoute.input(
      { account_id: "acct", limit: 25 },
      { kind: "whatsappJid", jid: "room@example.test" },
    )).toEqual({ account_id: "acct", conversation_id: "room@example.test", limit: 1 });
    expect(() => conformed?.resolveRoute.input(
      { account_id: "acct", limit: 25 },
      { kind: "beeperConversation", network: "test", conversationId: "room" },
    )).toThrow("wrong coordinate kind");
    const exactTarget = conformed!.parseTarget({ accountId: "acct", conversationId: "room" });
    expect(conformed!.contextInput(exactTarget, 25)).toEqual({
      account_id: "acct",
      conversation_id: "room",
      limit: 25,
    });
    if (conformed!.action.state !== "supported") throw new Error("expected supported action");
    const submitted = conformed!.action.mapAcceptedResult({ pendingId: "pending-1" });
    expect(submitted).toEqual({ state: "submitted", providerMessageId: "pending-1" });
    expect(conformed!.action.reconciliation(exactTarget, submitted).operation)
      .toBe("messaging.read");
  });
});
