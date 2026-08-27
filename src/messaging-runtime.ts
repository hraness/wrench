import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { WrenchAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  MESSAGING_CONTEXT_BINDING_CONTRACT_HASH,
  MESSAGING_CONTEXT_BINDING_CONTRACT_ID,
  parseMessagingContextRequestV1,
  parseMessagingRouteResolveRequestV1,
  parseMessagingRoutesRequestV1,
  parseMessagingTurnV1,
  messagingTurnDigest,
  type MessagingContextBindingV1,
  type MessagingContextMessageV1,
  type MessagingContextV1,
  type MessagingPreviewV1,
  type MessagingRouteV1,
  type MessagingRoutesV1,
} from "./messaging-types";
import {
  loadMessagingContextRecord,
  loadMessagingRouteRecord,
  messagingRouteRecordHash,
  saveMessagingContextRecord,
  saveMessagingRouteRecord,
  type MessagingContextRecordV1,
  type MessagingRouteRecordV1,
} from "./messaging-store";
import {
  isLocalCliOperation,
  isProviderOperation,
  isWebSessionOperation,
  manifestHash,
  type OperationInput,
} from "./model";
import { parseMaterializedPageV1, type ProviderMaterializedPageV1, type ProviderMessageV1 } from "./omni-model";
import { withLocalCliProviderCleanupAdmission } from "./local-cli-admission";
import type {
  ProviderPluginBindingV1,
  ProviderPluginMessagingDefinitionV1,
} from "./provider-plugin";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import type {
  ProviderPluginOperationResolutionV1,
  ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  createAndSaveInvocationPlan,
  executeReadInvocation,
  prepareInvocation,
  type PreparedInvocation,
} from "./runtime";
import { writePrivateJson } from "./storage";

const ROUTE_TTL_MS = 15 * 60_000;
const CONTEXT_TTL_MS = 5 * 60_000;

type Environment = Readonly<Record<string, string | undefined>>;

export type MessagingRuntimeOptions = {
  readonly environment?: Environment;
  readonly registry?: ProviderPluginRegistry;
  readonly now?: Date;
  readonly signal?: AbortSignal;
};

type MessagingResolution = ProviderPluginOperationResolutionV1 & {
  readonly messaging: ProviderPluginMessagingDefinitionV1;
};

export type MessagingPrivateOutputReceiptV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-private-output-receipt";
  readonly artifactFormat: string;
  readonly artifactSha256: string;
  readonly itemCount: number;
  readonly generatedAt: string;
  readonly expiresAt: string | null;
};

function now(options: MessagingRuntimeOptions): Date {
  const value = options.now ?? new Date();
  if (!Number.isFinite(value.getTime())) throw new Error("messaging observation time is invalid");
  return value;
}

function opaque(prefix: "wmroute" | "wmcontext" | "wmreply"): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

function operationResolution(
  invocation: PreparedInvocation,
  registry: ProviderPluginRegistry,
): ProviderPluginOperationResolutionV1 {
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation === undefined) throw new Error("messaging operation disappeared");
  if (isLocalCliOperation(operation)) {
    return registry.requireOperationDefinition(
      "local-cli",
      operation.localCli.surface,
      operation.localCli.action,
      operation.localCli.contractVersion,
    );
  }
  if (isWebSessionOperation(operation)) {
    const binding = registry.requireSessionRoute(operation.webSession.site);
    return registry.requireOperationDefinition(
      binding.transport,
      operation.webSession.site,
      operation.webSession.action,
      operation.webSession.contractVersion,
    );
  }
  if (isProviderOperation(operation)) {
    return registry.requireOperationDefinition(
      "provider-api",
      operation.provider.provider,
      operation.provider.action,
      operation.provider.contractVersion,
    );
  }
  throw new Error("messaging requires one code-owned provider operation");
}

function messagingResolution(
  invocation: PreparedInvocation,
  registry: ProviderPluginRegistry,
  expected: "messaging.list" | "messaging.read" | "action",
): MessagingResolution {
  const resolution = operationResolution(invocation, registry);
  const messaging = resolution.binding.messaging;
  if (messaging === undefined) {
    throw new Error("selected provider does not expose the messaging SPI");
  }
  const expectedOperation = expected === "action"
    ? messaging.action.state === "supported"
      ? messaging.action.operation
      : null
    : expected === "messaging.list"
      ? messaging.listOperation
      : messaging.contextOperation;
  if (expectedOperation === null || resolution.operation.name !== expectedOperation) {
    throw new Error("selected operation does not match the provider messaging contract");
  }
  return Object.freeze({ ...resolution, messaging });
}

function requireBoundAuth(
  binding: ProviderPluginBindingV1,
  auth: PreparedInvocation["auth"],
): asserts auth is WrenchAuth & { readonly subject: string } {
  if (auth.kind === "public-web-session") {
    throw new Error("messaging requires one private account-bound auth realm");
  }
  requireProviderPluginAuth(binding, auth);
  if (auth.subject === undefined || !binding.subject.matches(auth.subject)) {
    throw new Error("messaging requires one current account-bound auth realm");
  }
}

async function requireRuntimeReady(
  binding: ProviderPluginBindingV1,
  auth: PreparedInvocation["auth"],
  environment: Environment,
  registry: ProviderPluginRegistry,
): Promise<void> {
  requireBoundAuth(binding, auth);
  if (binding.transport === "local-cli") {
    const status = await withLocalCliProviderCleanupAdmission(
      {
        registry,
        binding,
        auth: null,
        purpose: { kind: "inspect" },
        environment,
      },
      (registerCleanupBarrier) => binding.inspect(environment, {
        registerCleanupBarrier,
      }),
    );
    if (!status.ready) throw new Error("messaging provider runtime is unavailable");
    return;
  }
  if (binding.transport === "linked-device") {
    const lifecycle = binding.linkedDeviceLifecycle;
    if (lifecycle === undefined) {
      throw new Error("messaging linked-device runtime has no readiness inspection");
    }
    const status = await lifecycle.inspect(environment);
    if (!status.ready) throw new Error("messaging provider runtime is unavailable");
  }
}

function implementationIdentity(
  binding: ProviderPluginBindingV1,
  registry: ProviderPluginRegistry,
): string {
  return sha256(canonicalJson({
    surfaceId: binding.surfaceId,
    transport: binding.transport,
    closureHash: registry.implementationClosureHash(binding),
    artifactSha256: registry.artifactSha256(binding),
    ...(binding.transport === "local-cli" ? { tool: binding.tool } : {}),
  }));
}

function identityFor(
  invocation: PreparedInvocation,
  resolution: MessagingResolution,
  registry: ProviderPluginRegistry,
): Pick<MessagingRouteRecordV1, "adapter" | "plugin" | "binding" | "auth"> {
  requireBoundAuth(resolution.binding, invocation.auth);
  return Object.freeze({
    adapter: Object.freeze({
      id: invocation.manifest.id,
      version: invocation.manifest.version,
      hash: manifestHash(invocation.manifest),
    }),
    plugin: Object.freeze({
      id: resolution.plugin.id,
      version: resolution.plugin.version,
      closureHash: registry.implementationClosureHash(resolution.binding),
    }),
    binding: Object.freeze({
      surfaceId: resolution.binding.surfaceId,
      transport: resolution.binding.transport,
      implementationIdentity: implementationIdentity(resolution.binding, registry),
      messagingContractId: resolution.messaging.contractId,
    }),
    auth: Object.freeze({
      id: invocation.auth.id,
      hash: sha256(canonicalJson(invocation.auth)),
      subject: invocation.auth.subject,
    }),
  });
}

function exactLivePage(
  invocation: PreparedInvocation,
  resolution: MessagingResolution,
  output: unknown,
): ProviderMaterializedPageV1 {
  const omni = resolution.operation.omni;
  if (omni?.state !== "supported") {
    throw new Error("messaging provider operation lost normalization support");
  }
  return parseMaterializedPageV1(omni.materialize(invocation.input, output));
}

function routeFingerprint(record: MessagingRouteRecordV1): string {
  return sha256(canonicalJson({
    adapter: record.adapter,
    plugin: record.plugin,
    binding: record.binding,
    auth: record.auth,
    target: record.target,
    conversationProviderId: record.conversationProviderId,
  }));
}

function assertRouteIdentity(
  record: MessagingRouteRecordV1,
  invocation: PreparedInvocation,
  resolution: MessagingResolution,
  registry: ProviderPluginRegistry,
  observation: Date,
): void {
  if (Date.parse(record.expiresAt) <= observation.getTime()) {
    throw new Error("messaging route is unavailable or expired");
  }
  const identity = identityFor(invocation, resolution, registry);
  const expected = sha256(canonicalJson({
    adapter: identity.adapter,
    plugin: identity.plugin,
    binding: identity.binding,
    auth: identity.auth,
    target: resolution.messaging.parseTarget(record.target),
    conversationProviderId: record.conversationProviderId,
  }));
  if (expected !== routeFingerprint(record)) {
    throw new Error("messaging route identity changed; discover a new route");
  }
}

function latestRevision(
  surfaceId: string,
  conversationProviderId: string,
  messages: readonly ProviderMessageV1[],
  exactDataRevision: string,
): string {
  if (messages.length === 0) {
    return sha256(canonicalJson({
      surfaceId,
      conversationProviderId,
      empty: true,
      exactDataRevision,
    }));
  }
  const latest = [...messages].sort((left, right) =>
    (left.orderedAt ?? "").localeCompare(right.orderedAt ?? "")
      || left.providerId.localeCompare(right.providerId)).at(-1)!;
  return sha256(canonicalJson({
    surfaceId,
    conversationProviderId,
    providerId: latest.providerId,
    providerRevision: latest.providerRevision,
    orderedAt: latest.orderedAt,
  }));
}

function pageMessages(
  page: ProviderMaterializedPageV1,
  conversationProviderId: string,
): readonly ProviderMessageV1[] {
  return Object.freeze(page.entities.map((entity) => {
    if (
      entity.kind !== "message"
      || entity.conversationProviderId !== conversationProviderId
    ) {
      throw new Error("messaging context did not bind the exact route conversation");
    }
    return entity;
  }));
}

function randomRefMap(
  messages: readonly ProviderMessageV1[],
): {
  readonly byProvider: ReadonlyMap<string, string>;
  readonly replyTargets: Readonly<Record<string, string>>;
} {
  const byProvider = new Map<string, string>();
  const replyTargets: Record<string, string> = {};
  for (const message of messages) {
    if (byProvider.has(message.providerId)) {
      throw new Error("messaging context repeated a provider message identity");
    }
    const reference = opaque("wmreply");
    byProvider.set(message.providerId, reference);
    replyTargets[reference] = message.providerId;
  }
  return Object.freeze({
    byProvider,
    replyTargets: Object.freeze(replyTargets),
  });
}

function publicMessages(
  messages: readonly ProviderMessageV1[],
  refs: ReadonlyMap<string, string>,
): readonly MessagingContextMessageV1[] {
  return Object.freeze(messages.map((message) => {
    const messageRef = refs.get(message.providerId);
    if (messageRef === undefined) throw new Error("messaging reply reference disappeared");
    return Object.freeze({
      messageRef,
      direction: message.direction,
      time: message.orderedAt,
      author: message.sender === null
        ? null
        : Object.freeze({
            displayName: message.sender.displayName,
            handle: message.sender.handle,
          }),
      body: message.body,
      bodyTruncated: message.bodyTruncated === true,
      edited: "unknown" as const,
      retracted:
        message.state === "revoked"
        || message.state === "revoked-and-deleted-for-me"
          ? "observed" as const
          : "unknown" as const,
      reply: Object.freeze({
        toMessageRef: message.replyToProviderId === null
          ? null
          : refs.get(message.replyToProviderId) ?? null,
      }),
      attachments: Object.freeze(message.attachments.map((attachment) =>
        Object.freeze({
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          name: attachment.name,
          sizeBytes: attachment.sizeBytes,
        }))),
      untrustedData: true as const,
    });
  }));
}

function privateOutputPath(path: string): string {
  if (
    !isAbsolute(path)
    || resolve(path) !== path
    || Buffer.byteLength(path, "utf8") > 4_096
    || /[\0\r\n]/u.test(path)
  ) throw new Error("messaging private output path must be normalized and absolute");
  return path;
}

export function writeMessagingPrivateOutput(
  path: string,
  artifact:
    | MessagingRouteV1
    | MessagingRoutesV1
    | MessagingContextV1
    | MessagingPreviewV1,
): MessagingPrivateOutputReceiptV1 {
  const outputPath = privateOutputPath(path);
  writePrivateJson(outputPath, artifact, { privateParent: true });
  const artifactSha256 = sha256(canonicalJson(artifact));
  const expiresAt = artifact.format === "wrench.messaging-context"
    ? artifact.binding.expiresAt
    : artifact.format === "wrench.messaging-preview"
      ? artifact.expiresAt
      : artifact.format === "wrench.messaging-route"
        ? artifact.expiresAt
      : artifact.routes.reduce<string | null>((latest, route) =>
          latest === null || route.expiresAt < latest ? route.expiresAt : latest, null);
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-private-output-receipt",
    artifactFormat: artifact.format,
    artifactSha256,
    itemCount: artifact.format === "wrench.messaging-routes"
      ? artifact.routes.length
      : artifact.format === "wrench.messaging-context"
        ? artifact.messages.length
        : artifact.format === "wrench.messaging-route"
          ? 1
        : artifact.partCount,
    generatedAt: artifact.format === "wrench.messaging-routes"
      ? artifact.generatedAt
      : artifact.format === "wrench.messaging-context"
        ? artifact.binding.validatedAt
        : artifact.format === "wrench.messaging-route"
          ? new Date().toISOString()
        : new Date().toISOString(),
    expiresAt,
  });
}

export async function discoverMessagingRoutesInternal(
  value: unknown,
  options: MessagingRuntimeOptions = {},
): Promise<MessagingRoutesV1> {
  const request = parseMessagingRoutesRequestV1(value);
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const observation = now(options);
  const generatedAt = observation.toISOString();
  const expiresAt = new Date(observation.getTime() + ROUTE_TTL_MS).toISOString();
  const routes: MessagingRouteV1[] = [];
  const routeIdentities = new Set<string>();
  const source = request.source;
    const invocation = prepareInvocation(
      source.adapterId,
      "messaging.list",
      source.listInput,
      source.authId,
      environment,
      registry,
    );
    const resolution = messagingResolution(invocation, registry, "messaging.list");
    await requireRuntimeReady(resolution.binding, invocation.auth, environment, registry);
    const live = await executeReadInvocation(invocation, {
      headed: false,
      environment,
      registry,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (live.receipt.status !== "succeeded") {
      throw new Error("messaging route discovery live read did not succeed");
    }
    const exactDataRevision = sha256(canonicalJson(live.output));
    const page = exactLivePage(invocation, resolution, live.output);
    const candidates = resolution.messaging.enumerateRoutes(invocation.input, page);
    if (!Array.isArray(candidates) || candidates.length > 1_000) {
      throw new Error("provider messaging route enumeration exceeded its bound");
    }
    const identity = identityFor(invocation, resolution, registry);
    for (const candidate of candidates) {
      const target = resolution.messaging.parseTarget(candidate.target);
      if (
        typeof candidate.conversationProviderId !== "string"
        || candidate.conversationProviderId.length < 1
        || candidate.conversationProviderId.length > 4_096
        || !Array.isArray(candidate.participants)
        || candidate.participants.length > 10_000
      ) throw new Error("provider messaging route candidate is malformed");
      const dedupe = sha256(canonicalJson({
        adapter: identity.adapter,
        binding: identity.binding,
        auth: identity.auth,
        target,
      }));
      if (routeIdentities.has(dedupe)) {
        throw new Error("messaging route page repeated one exact provider conversation");
      }
      routeIdentities.add(dedupe);
      const routeRef = opaque("wmroute");
      const participantFingerprint = sha256(canonicalJson(candidate.participants));
      const routeRecord: MessagingRouteRecordV1 = Object.freeze({
        schemaVersion: 1,
        format: "wrench.messaging-route-record",
        routeRef,
        createdAt: generatedAt,
        expiresAt,
        ...identity,
        list: Object.freeze({
          operation: "messaging.list",
          input: invocation.input,
          inputHash: sha256(canonicalJson(invocation.input)),
          exactDataRevision,
          validatedAt: generatedAt,
        }),
        target,
        conversationProviderId: candidate.conversationProviderId,
        conversation: Object.freeze({
          kind: candidate.conversationKind,
          title: candidate.title,
          participantCount: candidate.participants.length,
          participantFingerprint,
          providerRevision: candidate.providerRevision,
        }),
      });
      saveMessagingRouteRecord(routeRecord, environment);
      const action = resolution.messaging.action;
      routes.push(Object.freeze({
        schemaVersion: 1,
        format: "wrench.messaging-route",
        routeRef,
        network: resolution.messaging.network,
        conversation: Object.freeze({
          kind: candidate.conversationKind,
          title: candidate.title,
          participantCount: candidate.participants.length,
        }),
        readiness: Object.freeze({
          context: resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
            ? "ready"
            : "historical-readable",
          turn:
            action.state === "supported"
            && resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
              ? "ready"
              : "unavailable",
          reply:
            action.state === "supported"
            && resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
              ? action.reply
              : "unsupported",
          reason: resolution.messaging.contextLiveness === "freshness-unproven"
            ? "provider context freshness is unproven"
            : action.state === "supported"
              ? null
              : action.reason,
        }),
        completeness: page.completeness,
        expiresAt,
  }));
}
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-routes",
    generatedAt,
    completeness: page.completeness,
    continuation: Object.freeze({
      direction: page.cursor.direction,
      request: page.cursor.request,
      nextInput: page.cursor.nextInput,
    }),
    routes: Object.freeze(routes),
  });
}

export async function resolveMessagingRouteInternal(
  value: unknown,
  options: MessagingRuntimeOptions = {},
): Promise<MessagingRouteV1> {
  const request = parseMessagingRouteResolveRequestV1(value);
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const observation = now(options);
  const createdAt = observation.toISOString();
  const expiresAt = new Date(observation.getTime() + ROUTE_TTL_MS).toISOString();
  const source = request.source;
  const sourceInvocation = prepareInvocation(
    source.adapterId,
    "messaging.list",
    source.listInput,
    source.authId,
    environment,
    registry,
  );
  const resolution = messagingResolution(
    sourceInvocation,
    registry,
    "messaging.list",
  );
  await requireRuntimeReady(
    resolution.binding,
    sourceInvocation.auth,
    environment,
    registry,
  );
  if (request.candidate.coordinate.kind !== resolution.messaging.coordinateKind) {
    throw new Error("messaging route coordinate does not match the selected provider");
  }
  const exactInput = resolution.messaging.resolveRoute.input(
    sourceInvocation.input,
    request.candidate.coordinate,
  );
  const exactInvocation = prepareInvocation(
    source.adapterId,
    resolution.messaging.resolveRoute.operation,
    exactInput,
    source.authId,
    environment,
    registry,
  );
  const exactResolution = operationResolution(exactInvocation, registry);
  if (
    exactResolution.plugin.id !== resolution.plugin.id
    || exactResolution.binding !== resolution.binding
    || exactResolution.binding.messaging?.contractId
      !== resolution.messaging.contractId
    || exactResolution.operation.name
      !== resolution.messaging.resolveRoute.operation
  ) throw new Error("exact messaging route resolution changed provider binding");
  const live = await executeReadInvocation(exactInvocation, {
    headed: false,
    environment,
    registry,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (live.receipt.status !== "succeeded") {
    throw new Error("exact messaging route live read did not succeed");
  }
  const exactDataRevision = sha256(canonicalJson(live.output));
  const candidates = resolution.messaging.resolveRoute.candidates(
    sourceInvocation.input,
    request.candidate.coordinate,
    live.output,
  );
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    throw new Error(
      Array.isArray(candidates) && candidates.length === 0
        ? "exact messaging route candidate was not proven by the live provider read"
        : "exact messaging route candidate was ambiguous in the live provider read",
    );
  }
  const candidate = candidates[0]!;
  const target = resolution.messaging.parseTarget(candidate.target);
  if (
    candidate.conversationProviderId.length < 1
    || candidate.conversationProviderId.length > 4_096
    || !Array.isArray(candidate.participants)
    || candidate.participants.length > 10_000
  ) throw new Error("provider messaging route candidate is malformed");
  const identity = identityFor(sourceInvocation, resolution, registry);
  const routeRef = opaque("wmroute");
  const routeRecord: MessagingRouteRecordV1 = Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-route-record",
    routeRef,
    createdAt,
    expiresAt,
    ...identity,
    list: Object.freeze({
      operation: "messaging.list",
      input: sourceInvocation.input,
      inputHash: sha256(canonicalJson(sourceInvocation.input)),
      exactDataRevision,
      validatedAt: createdAt,
    }),
    target,
    conversationProviderId: candidate.conversationProviderId,
    conversation: Object.freeze({
      kind: candidate.conversationKind,
      title: candidate.title,
      participantCount: candidate.participants.length,
      participantFingerprint: sha256(canonicalJson(candidate.participants)),
      providerRevision: candidate.providerRevision,
    }),
  });
  saveMessagingRouteRecord(routeRecord, environment);
  const action = resolution.messaging.action;
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-route",
    routeRef,
    network: resolution.messaging.network,
    conversation: Object.freeze({
      kind: candidate.conversationKind,
      title: candidate.title,
      participantCount: candidate.participants.length,
    }),
    readiness: Object.freeze({
      context: resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
        ? "ready"
        : "historical-readable",
      turn:
        action.state === "supported"
        && resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
          ? "ready"
          : "unavailable",
      reply:
        action.state === "supported"
        && resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
          ? action.reply
          : "unsupported",
      reason: resolution.messaging.contextLiveness === "freshness-unproven"
        ? "provider context freshness is unproven"
        : action.state === "supported"
          ? null
          : action.reason,
    }),
    completeness: Object.freeze({
      kind: "complete",
      reason: "provider-native exact coordinate read proved one route",
    }),
    expiresAt,
  });
}

async function resolveCurrentRoute(
  routeRef: string,
  observation: Date,
  environment: Environment,
  registry: ProviderPluginRegistry,
): Promise<{
  readonly record: MessagingRouteRecordV1;
  readonly resolution: MessagingResolution;
}> {
  const record = loadMessagingRouteRecord(routeRef, environment, observation);
  const invocation = prepareInvocation(
    record.adapter.id,
    record.list.operation,
    record.list.input,
    record.auth.id,
    environment,
    registry,
  );
  const resolution = messagingResolution(invocation, registry, "messaging.list");
  assertRouteIdentity(record, invocation, resolution, registry, observation);
  await requireRuntimeReady(resolution.binding, invocation.auth, environment, registry);
  return Object.freeze({ record, resolution });
}

async function currentContextPage(
  record: MessagingRouteRecordV1,
  resolution: MessagingResolution,
  limit: number,
  environment: Environment,
  registry: ProviderPluginRegistry,
  signal?: AbortSignal,
): Promise<{
  readonly exactDataRevision: string;
  readonly latestMessageRevision: string;
  readonly page: ProviderMaterializedPageV1;
  readonly messages: readonly ProviderMessageV1[];
}> {
  const target = resolution.messaging.parseTarget(record.target);
  const input = resolution.messaging.contextInput(target, limit);
  const invocation = prepareInvocation(
    record.adapter.id,
    resolution.messaging.contextOperation,
    input,
    record.auth.id,
    environment,
    registry,
  );
  const contextResolution = messagingResolution(invocation, registry, "messaging.read");
  if (
    contextResolution.plugin.id !== resolution.plugin.id
    || contextResolution.binding !== resolution.binding
    || contextResolution.messaging.contractId !== resolution.messaging.contractId
  ) throw new Error("messaging context operation changed provider route");
  const live = await executeReadInvocation(invocation, {
    headed: false,
    environment,
    registry,
    ...(signal === undefined ? {} : { signal }),
  });
  if (live.receipt.status !== "succeeded") {
    throw new Error("messaging context live preflight did not succeed");
  }
  const exactDataRevision = sha256(canonicalJson(live.output));
  const page = exactLivePage(invocation, contextResolution, live.output);
  const messages = pageMessages(page, record.conversationProviderId);
  return Object.freeze({
    exactDataRevision,
    latestMessageRevision: latestRevision(
      resolution.binding.surfaceId,
      record.conversationProviderId,
      messages,
      exactDataRevision,
    ),
    page,
    messages,
  });
}

export async function readMessagingContextInternal(
  value: unknown,
  options: MessagingRuntimeOptions = {},
): Promise<MessagingContextV1> {
  const request = parseMessagingContextRequestV1(value);
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const observation = now(options);
  const { record, resolution } = await resolveCurrentRoute(
    request.routeRef,
    observation,
    environment,
    registry,
  );
  const current = await currentContextPage(
    record,
    resolution,
    request.limit,
    environment,
    registry,
    options.signal,
  );
  const validationObservation = options.now ?? new Date();
  if (!Number.isFinite(validationObservation.getTime())) {
    throw new Error("messaging live-preflight completion time is invalid");
  }
  const validatedAt = validationObservation.toISOString();
  const expiresAt = new Date(
    validationObservation.getTime() + CONTEXT_TTL_MS,
  ).toISOString();
  const contextRef = opaque("wmcontext");
  const references = randomRefMap(current.messages);
  const binding: MessagingContextBindingV1 = Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context-binding",
    contractId: MESSAGING_CONTEXT_BINDING_CONTRACT_ID,
    contractHash: MESSAGING_CONTEXT_BINDING_CONTRACT_HASH,
    routeRef: record.routeRef,
    contextRef,
    exactDataRevision: current.exactDataRevision,
    latestMessageRevision: current.latestMessageRevision,
    validatedAt,
    expiresAt,
  });
  const contextRecord: MessagingContextRecordV1 = Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context-record",
    contextRef,
    routeRef: record.routeRef,
    routeRecordHash: messagingRouteRecordHash(record),
    exactDataRevision: current.exactDataRevision,
    latestMessageRevision: current.latestMessageRevision,
    validatedAt,
    expiresAt,
    limit: request.limit,
    liveness: resolution.messaging.contextLiveness,
    replyTargets: references.replyTargets,
  });
  saveMessagingContextRecord(contextRecord, environment);
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context",
    binding,
    network: resolution.messaging.network,
    liveness: resolution.messaging.contextLiveness,
    truncated:
      current.page.completeness.kind !== "complete"
      || current.messages.some((message) => message.bodyTruncated === true),
    completeness: current.page.completeness,
    messages: publicMessages(current.messages, references.byProvider),
    warnings: Object.freeze([
      ...(resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
        ? ["fresh-as-of-live-preflight-only"]
        : []),
      ...(resolution.messaging.contextLiveness === "freshness-unproven"
        ? ["provider-freshness-unproven-action-blocked"]
        : []),
      ...(current.page.completeness.kind === "complete"
        ? []
        : ["provider-history-incomplete"]),
    ]),
  });
}

export async function previewMessagingTurnInternal(
  value: unknown,
  options: MessagingRuntimeOptions = {},
): Promise<MessagingPreviewV1> {
  const turn = parseMessagingTurnV1(value);
  if (turn.parts.length !== 1) {
    throw new Error(
      "ordered multi-part turns require an existing-kernel composite journal with proven-prefix, uncertain-part, and unattempted-suffix state; no preview was created",
    );
  }
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const observation = now(options);
  const { record, resolution } = await resolveCurrentRoute(
    turn.routeRef,
    observation,
    environment,
    registry,
  );
  if (resolution.messaging.action.state !== "supported") {
    throw new Error("messaging route does not support checked turn actions");
  }
  const context = loadMessagingContextRecord(
    turn.contextRef,
    environment,
    observation,
  );
  if (
    context.routeRef !== record.routeRef
    || context.routeRecordHash !== messagingRouteRecordHash(record)
    || Date.parse(context.expiresAt) <= observation.getTime()
  ) throw new Error("messaging context is stale or belongs to another route");
  if (context.liveness !== "fresh-as-of-live-preflight") {
    throw new Error("messaging context freshness is unproven; no action preview is allowed");
  }
  const current = await currentContextPage(
    record,
    resolution,
    context.limit,
    environment,
    registry,
    options.signal,
  );
  if (
    current.exactDataRevision !== context.exactDataRevision
    || current.latestMessageRevision !== context.latestMessageRevision
  ) throw new Error("messaging context changed; read a new context before preview");
  const part = turn.parts[0]!;
  const replyToProviderId = part.replyRef === null
    ? null
    : context.replyTargets[part.replyRef];
  if (part.replyRef !== null && replyToProviderId === undefined) {
    throw new Error("messaging reply reference is not part of the bound context");
  }
  if (
    replyToProviderId !== null
    && resolution.messaging.action.reply !== "supported"
  ) throw new Error("messaging route does not support exact replies");
  const input: OperationInput = resolution.messaging.action.compileTurnPart(
    resolution.messaging.parseTarget(record.target),
    Object.freeze({
      partId: part.partId,
      text: part.text,
      replyToProviderId: replyToProviderId ?? null,
    }),
  );
  const invocation = prepareInvocation(
    record.adapter.id,
    resolution.messaging.action.operation,
    input,
    record.auth.id,
    environment,
    registry,
  );
  const actionResolution = messagingResolution(invocation, registry, "action");
  if (
    actionResolution.binding !== resolution.binding
    || actionResolution.plugin.id !== resolution.plugin.id
    || actionResolution.messaging.contractId !== resolution.messaging.contractId
  ) throw new Error("messaging action changed provider route");
  const stored = createAndSaveInvocationPlan(
    invocation,
    environment,
    observation,
    registry,
  );
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-preview",
    status: "confirmation-required",
    planDigest: stored.digest,
    expiresAt: stored.plan.expiresAt,
    routeRef: record.routeRef,
    contextRef: context.contextRef,
    clientIntentSha256: turn.clientIntentSha256,
    turnDigest: messagingTurnDigest(turn),
    recipient: Object.freeze({
      network: resolution.messaging.network,
      conversation: Object.freeze({
        kind: record.conversation.kind,
        title: record.conversation.title,
        participantCount: record.conversation.participantCount,
      }),
    }),
    partCount: 1,
    bubbles: Object.freeze([Object.freeze({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef,
    })]),
    risk: "R3",
    sideEffect: stored.plan.sideEffect,
  });
}
