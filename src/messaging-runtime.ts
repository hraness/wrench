import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import type { WrenchAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  parseMessageLikeMeSourceConversationCoordinateBindingV1,
  wrenchMessagingContextBindingSha256V1,
} from "./message-like-me-agentic-messaging";
import {
  MESSAGING_CONTEXT_BINDING_CONTRACT_HASH,
  MESSAGING_CONTEXT_BINDING_CONTRACT_ID,
  parseMessagingContextBindingV1,
  parseMessagingContextRequestV1,
  parseMessagingRouteResolveRequestV1,
  parseMessagingRoutesRequestV1,
  parseMessagingTurnV1,
  messagingTurnDigest,
  type MessagingContextBindingV1,
  type MessagingContextMessageV1,
  type MessagingContextV1,
  type MessagingPreviewV1,
  type MessagingPrivateProviderOutcomeV1,
  type MessagingReceiptBindingV1,
  type MessagingRouteV1,
  type MessagingRoutesV1,
  type MessagingRunReceiptV1,
  type MessagingRunV1,
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
import { runLocalCliOperationWithDeadline } from "./local-cli-execution";
import { parseMaterializedPageV1, type ProviderMaterializedPageV1, type ProviderMessageV1 } from "./omni-model";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "./operation-deadline";
import { withLocalCliProviderCleanupAdmission } from "./local-cli-admission";
import type {
  ProviderPluginBindingV1,
  ProviderPluginMessagingDefinitionV1,
  ProviderPluginMessagingExpectedOwnPrefixProofV1,
} from "./provider-plugin";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import type {
  ProviderPluginOperationResolutionV1,
  ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  bindMessagingCompositePreviewDigest,
  createMessagingCompositeInvocationPlan,
  executeReadInvocation,
  invocationPlanDigest,
  loadInvocationPlan,
  prepareInvocation,
  saveInvocationPlan,
  type PreparedInvocation,
  type StoredPlan,
} from "./runtime";
import {
  initializeMessagingRun,
  messagingExpectedOwnPrefix,
  messagingReceiptBinding,
  messagingRunReceipt,
  readMessagingRun,
  updateMessagingRun,
  type MessagingRunSnapshotV1,
} from "./messaging-action-store";
import {
  createPrivateJsonIfAbsent,
  isWrenchStatePath,
  readRegularFile,
  writePrivateJson,
} from "./storage";
import {
  runWebSessionOperationWithDeadline,
} from "./web-session-execution";
import {
  withWebSessionCleanupAdmission,
  type WebSessionCleanupAdmissionIdentity,
} from "./web-session-cleanup-admission";

const ROUTE_TTL_MS = 15 * 60_000;
const CONTEXT_TTL_MS = 5 * 60_000;

type Environment = Readonly<Record<string, string | undefined>>;

export type MessagingRuntimeOptions = {
  readonly environment?: Environment;
  readonly registry?: ProviderPluginRegistry;
  readonly now?: Date;
  readonly signal?: AbortSignal;
  /** Internal deterministic-clock seam for the per-bubble total deadline. */
  readonly deadlineClock?: OperationDeadlineClock;
};

type MessagingResolution = ProviderPluginOperationResolutionV1 & {
  readonly messaging: ProviderPluginMessagingDefinitionV1;
};

function parseExpectedOwnPrefixProof(
  value: unknown,
  acceptedCount: number,
): ProviderPluginMessagingExpectedOwnPrefixProofV1 {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error("messaging provider returned a malformed prefix proof");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error("messaging provider returned a malformed prefix proof");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("messaging provider returned a malformed prefix proof");
    }
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (source.state === "drift" && keys.length === 1 && keys[0] === "state") {
    return Object.freeze({ state: "drift" as const });
  }
  if (
    source.state !== "proven"
    || keys.length !== 2
    || keys[0] !== "matchedAcceptedPrefixCount"
    || keys[1] !== "state"
    || typeof source.matchedAcceptedPrefixCount !== "number"
    || !Number.isSafeInteger(source.matchedAcceptedPrefixCount)
    || source.matchedAcceptedPrefixCount < 0
    || source.matchedAcceptedPrefixCount > acceptedCount
  ) throw new Error("messaging provider returned a malformed prefix proof");
  return Object.freeze({
    state: "proven" as const,
    matchedAcceptedPrefixCount: source.matchedAcceptedPrefixCount,
  });
}

export type MessagingPrivateOutputReceiptV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-private-output-receipt";
  readonly artifactFormat: string;
  readonly artifactSha256: string;
  readonly itemCount: number;
  readonly generatedAt: string;
  readonly expiresAt: string | null;
};

type MessagingPrivateOutputArtifactV1 =
  | MessagingRouteV1
  | MessagingRoutesV1
  | MessagingContextV1
  | MessagingPreviewV1
  | MessagingRunV1
  | MessagingReceiptBindingV1;

export type MessagingPrivateOutputReservationV1 = {
  readonly path: string;
  readonly artifactFormat: MessagingPrivateOutputArtifactV1["format"];
  readonly reservationId: string;
  readonly reservedContentSha256: string;
};

export type MessagingPrivateOutputReservationPairV1 = {
  readonly run: MessagingPrivateOutputReservationV1;
  readonly receiptBinding: MessagingPrivateOutputReservationV1;
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

function messagingWebCleanupAdmissionIdentity(
  invocation: PreparedInvocation,
  resolution: MessagingResolution,
  registry: ProviderPluginRegistry,
  runId: string,
  partIndex: number,
): WebSessionCleanupAdmissionIdentity {
  return Object.freeze({
    runId,
    pluginId: resolution.plugin.id,
    pluginVersion: resolution.plugin.version,
    pluginImplementationHash: registry
      .implementationHash(resolution.binding)
      .toString("hex"),
    adapterId: invocation.manifest.id,
    adapterHash: manifestHash(invocation.manifest),
    surfaceId: resolution.binding.surfaceId,
    authId: invocation.auth.id,
    authHash: sha256(canonicalJson(invocation.auth)),
    transport: "web-session-api" as const,
    executionIdentityHash: sha256(canonicalJson({
      schemaVersion: 1,
      kind: "messaging",
      runId,
      partIndex,
      operation: invocation.operationId,
      binding: implementationIdentity(resolution.binding, registry),
    })),
  });
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
    resolution: record.resolution,
    network: record.network,
    sourceConversationCoordinate: record.sourceConversationCoordinate,
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
    resolution: record.resolution,
    network: record.network,
    sourceConversationCoordinate: record.sourceConversationCoordinate,
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

function messagingBaseMessages(
  messages: readonly ProviderMessageV1[],
): readonly {
  readonly providerMessageId: string;
  readonly providerRevision: string | null;
  readonly orderedAt: string | null;
  readonly messageSha256: string;
}[] {
  return Object.freeze([...messages]
    .sort((left, right) => {
      const leftKey = `${left.orderedAt ?? ""}\0${left.providerId}`;
      const rightKey = `${right.orderedAt ?? ""}\0${right.providerId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map((message) => Object.freeze({
      providerMessageId: message.providerId,
      providerRevision: message.providerRevision,
      orderedAt: message.orderedAt,
      messageSha256: sha256(canonicalJson(message)),
    })));
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

export function validateMessagingPrivateOutputPath(
  path: string,
  environment: Environment = process.env,
): string {
  if (
    !isAbsolute(path)
    || resolve(path) !== path
    || Buffer.byteLength(path, "utf8") > 4_096
    || /[\0\r\n]/u.test(path)
  ) throw new Error("messaging private output path must be normalized and absolute");
  if (isWrenchStatePath(path, environment)) {
    throw new Error(
      "messaging private output path must be outside WRENCH_STATE_HOME",
    );
  }
  return path;
}

export function writeMessagingPrivateOutput(
  path: string,
  artifact: MessagingPrivateOutputArtifactV1,
  environment: Environment = process.env,
): MessagingPrivateOutputReceiptV1 {
  const outputPath = validateMessagingPrivateOutputPath(path, environment);
  writePrivateJson(outputPath, artifact, { privateParent: true });
  const artifactSha256 = sha256(canonicalJson(artifact));
  const expiresAt = artifact.format === "wrench.messaging-context"
    ? artifact.binding.expiresAt
    : artifact.format === "wrench.messaging-preview"
      ? artifact.expiresAt
      : artifact.format === "wrench.messaging-route"
        ? artifact.expiresAt
      : artifact.format === "wrench.messaging-run"
        ? null
      : artifact.format === "wrench.messaging-receipt-binding"
        ? null
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
        : artifact.format === "wrench.messaging-preview"
          || artifact.format === "wrench.messaging-run"
          ? artifact.partCount
          : 1,
    generatedAt: artifact.format === "wrench.messaging-routes"
      ? artifact.generatedAt
      : artifact.format === "wrench.messaging-context"
        ? artifact.binding.validatedAt
      : artifact.format === "wrench.messaging-route"
          ? new Date().toISOString()
        : artifact.format === "wrench.messaging-run"
          || artifact.format === "wrench.messaging-receipt-binding"
          ? artifact.recordedAt
          : new Date().toISOString(),
    expiresAt,
  });
}

function reserveMessagingPrivateOutput(
  path: string,
  artifactFormat: MessagingPrivateOutputArtifactV1["format"],
  reservationId: string,
  environment: Environment,
): MessagingPrivateOutputReservationV1 {
  const outputPath = validateMessagingPrivateOutputPath(path, environment);
  const marker = Object.freeze({
    schemaVersion: 1 as const,
    format: "wrench.messaging-private-output-reservation" as const,
    reservationId,
    artifactFormat,
  });
  const reservedContentSha256 = sha256(`${canonicalJson(marker)}\n`);
  if (!createPrivateJsonIfAbsent(outputPath, marker, { privateParent: true }).created) {
    throw new Error(`messaging private output sink already exists: ${outputPath}`);
  }
  return Object.freeze({
    path: outputPath,
    artifactFormat,
    reservationId,
    reservedContentSha256,
  });
}

export function reserveMessagingPrivateOutputPair(
  runPath: string,
  receiptBindingPath: string,
  environment: Environment = process.env,
): MessagingPrivateOutputReservationPairV1 {
  const exactRunPath = validateMessagingPrivateOutputPath(runPath, environment);
  const exactReceiptBindingPath = validateMessagingPrivateOutputPath(
    receiptBindingPath,
    environment,
  );
  if (exactRunPath === exactReceiptBindingPath) {
    throw new Error(
      "messaging confirmation requires distinct private output and receipt-binding paths",
    );
  }
  const pairId = `wmoutput_${randomBytes(16).toString("base64url")}`;
  const run = reserveMessagingPrivateOutput(
    exactRunPath,
    "wrench.messaging-run",
    pairId,
    environment,
  );
  let receiptBinding: MessagingPrivateOutputReservationV1;
  try {
    receiptBinding = reserveMessagingPrivateOutput(
      exactReceiptBindingPath,
      "wrench.messaging-receipt-binding",
      pairId,
      environment,
    );
  } catch (error) {
    throw new Error(
      `messaging receipt-binding sink failed physical reservation after the body-free run sink was reserved at ${exactRunPath}`,
      { cause: error },
    );
  }
  return Object.freeze({ run, receiptBinding });
}

export function writeReservedMessagingPrivateOutput(
  reservation: MessagingPrivateOutputReservationV1,
  artifact: MessagingPrivateOutputArtifactV1,
  environment: Environment = process.env,
): MessagingPrivateOutputReceiptV1 {
  if (artifact.format !== reservation.artifactFormat) {
    throw new Error("messaging private output reservation has another artifact format");
  }
  const current = readRegularFile(
    reservation.path,
    4_096,
    "messaging private output reservation",
  );
  if (sha256(current) !== reservation.reservedContentSha256) {
    throw new Error(
      "messaging private output reservation changed before final export; recover by run ID",
    );
  }
  return writeMessagingPrivateOutput(reservation.path, artifact, environment);
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
        resolution: "list-candidate",
        network: resolution.messaging.network,
        sourceConversationCoordinate: null,
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
          context: "resolution-required",
          turn: "unavailable",
          reply: "unsupported",
          reason:
            "an exact provider coordinate must be resolved before this list candidate can become a context or action capability",
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
  const sourceConversationCoordinate =
    resolution.messaging.resolveRoute.sourceConversationCoordinate(
      sourceInvocation.input,
      request.candidate.coordinate,
      live.output,
      identity.auth.subject,
    );
  if (
    resolution.messaging.action.state === "supported"
    && sourceConversationCoordinate === null
  ) throw new Error("actionable messaging route lacks a canonical source coordinate");
  const network = request.candidate.coordinate.kind === "beeperConversation"
    ? request.candidate.coordinate.network
    : resolution.messaging.network;
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
    resolution: "exact-coordinate",
    network,
    sourceConversationCoordinate,
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
    network,
    conversation: Object.freeze({
      kind: candidate.conversationKind,
      title: candidate.title,
      participantCount: candidate.participants.length,
    }),
    readiness: Object.freeze({
      context: sourceConversationCoordinate === null
        ? "unavailable"
        : resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
          ? "ready"
          : "historical-readable",
      turn:
        sourceConversationCoordinate !== null
        &&
        action.state === "supported"
        && resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
          ? "ready"
          : "unavailable",
      reply:
        sourceConversationCoordinate !== null
        &&
        action.state === "supported"
        && resolution.messaging.contextLiveness === "fresh-as-of-live-preflight"
          ? action.reply
          : "unsupported",
      reason: sourceConversationCoordinate === null
        ? "provider exact resolution cannot represent this route in the canonical source-conversation contract"
        : resolution.messaging.contextLiveness === "freshness-unproven"
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
  if (
    record.resolution !== "exact-coordinate"
    || record.sourceConversationCoordinate === null
  ) {
    throw new Error(
      "messaging route requires exact conversations.read resolution before context or action use",
    );
  }
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

async function currentMessagingRouteState(
  record: MessagingRouteRecordV1,
  resolution: MessagingResolution,
  environment: Environment,
  registry: ProviderPluginRegistry,
  signal?: AbortSignal,
): Promise<{
  readonly revision: string;
  readonly recipient: MessagingPreviewV1["recipient"];
}> {
  const action = resolution.messaging.action;
  if (action.state !== "supported") {
    throw new Error("messaging route does not support an actionable live preflight");
  }
  const target = resolution.messaging.parseTarget(record.target);
  const invocation = prepareInvocation(
    record.adapter.id,
    action.livePreflight.operation,
    action.livePreflight.input(target),
    record.auth.id,
    environment,
    registry,
  );
  const liveResolution = operationResolution(invocation, registry);
  if (
    liveResolution.binding !== resolution.binding
    || liveResolution.plugin.id !== resolution.plugin.id
  ) throw new Error("messaging live preflight changed provider binding");
  const live = await executeReadInvocation(invocation, {
    headed: false,
    environment,
    registry,
    ...(signal === undefined ? {} : { signal }),
  });
  if (live.receipt.status !== "succeeded") {
    throw new Error("messaging live route preflight did not succeed");
  }
  const snapshot = action.livePreflight.snapshot(
    live.output,
    record.auth.subject,
  );
  const sourceConversationCoordinate =
    parseMessageLikeMeSourceConversationCoordinateBindingV1(
      snapshot.sourceConversationCoordinate,
    );
  if (
    typeof snapshot.conversationProviderId !== "string"
    || snapshot.conversationProviderId !== record.conversationProviderId
    || typeof snapshot.network !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(snapshot.network)
    || snapshot.conversation.kind !== "single"
      && snapshot.conversation.kind !== "group"
      && snapshot.conversation.kind !== "unknown"
    || snapshot.conversation.title !== null
      && (typeof snapshot.conversation.title !== "string"
        || Buffer.byteLength(snapshot.conversation.title, "utf8") > 4_096
        || /[\0\r\n]/u.test(snapshot.conversation.title))
    || typeof snapshot.conversation.participantCount !== "number"
    || !Number.isSafeInteger(snapshot.conversation.participantCount)
    || snapshot.conversation.participantCount < 0
    || snapshot.conversation.participantCount > 10_000
    || typeof snapshot.participantFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(snapshot.participantFingerprint)
    || snapshot.providerRevision !== null
      && (typeof snapshot.providerRevision !== "string"
        || snapshot.providerRevision.length < 1
        || Buffer.byteLength(snapshot.providerRevision, "utf8") > 4_096
        || /[\0\r\n]/u.test(snapshot.providerRevision))
  ) throw new Error("messaging live route preflight returned malformed identity state");
  if (
    snapshot.network !== record.network
    || snapshot.conversation.kind !== record.conversation.kind
    || snapshot.conversation.title !== record.conversation.title
    || snapshot.conversation.participantCount
      !== record.conversation.participantCount
    || sourceConversationCoordinate.sha256
      !== record.sourceConversationCoordinate?.sha256
    || snapshot.participantFingerprint !== record.conversation.participantFingerprint
    || snapshot.providerRevision !== record.conversation.providerRevision
  ) throw new Error("messaging route recipient or provider state changed; resolve a new route");
  const recipient = Object.freeze({
    network: snapshot.network,
    conversation: Object.freeze({
      kind: snapshot.conversation.kind,
      title: snapshot.conversation.title,
      participantCount: snapshot.conversation.participantCount,
    }),
  });
  return Object.freeze({
    revision: sha256(canonicalJson({
    conversationProviderId: snapshot.conversationProviderId,
    recipient,
    sourceConversationCoordinate,
    participantFingerprint: snapshot.participantFingerprint,
    providerRevision: snapshot.providerRevision,
    })),
    recipient,
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
  await currentMessagingRouteState(
    record,
    resolution,
    environment,
    registry,
    options.signal,
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
  if (record.sourceConversationCoordinate === null) {
    throw new Error("messaging route lacks a canonical source coordinate");
  }
  const binding: MessagingContextBindingV1 = parseMessagingContextBindingV1({
    schemaVersion: 1,
    format: "wrench.messaging-context-binding",
    contractId: MESSAGING_CONTEXT_BINDING_CONTRACT_ID,
    contractHash: MESSAGING_CONTEXT_BINDING_CONTRACT_HASH,
    sourceConversationCoordinate: record.sourceConversationCoordinate,
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
    sourceConversationCoordinate: binding.sourceConversationCoordinate,
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
    network: record.network,
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
  const action = resolution.messaging.action;
  const context = loadMessagingContextRecord(
    turn.contextRef,
    environment,
    observation,
  );
  if (
    context.routeRef !== record.routeRef
    || context.routeRecordHash !== messagingRouteRecordHash(record)
    || context.sourceConversationCoordinate.sha256
      !== record.sourceConversationCoordinate?.sha256
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
  const exactContextBinding = parseMessagingContextBindingV1({
    schemaVersion: 1,
    format: "wrench.messaging-context-binding",
    contractId: MESSAGING_CONTEXT_BINDING_CONTRACT_ID,
    contractHash: MESSAGING_CONTEXT_BINDING_CONTRACT_HASH,
    sourceConversationCoordinate: context.sourceConversationCoordinate,
    routeRef: context.routeRef,
    contextRef: context.contextRef,
    exactDataRevision: context.exactDataRevision,
    latestMessageRevision: context.latestMessageRevision,
    validatedAt: context.validatedAt,
    expiresAt: context.expiresAt,
  });
  const contextBindingSha256 =
    wrenchMessagingContextBindingSha256V1(exactContextBinding);
  const baseRouteState = await currentMessagingRouteState(
    record,
    resolution,
    environment,
    registry,
    options.signal,
  );
  const target = resolution.messaging.parseTarget(record.target);
  const plannedParts = turn.parts.map((part) => {
    const replyToProviderId = part.replyRef === null
      ? null
      : context.replyTargets[part.replyRef];
    if (part.replyRef !== null && replyToProviderId === undefined) {
      throw new Error("messaging reply reference is not part of the bound context");
    }
    if (replyToProviderId !== null && action.reply !== "supported") {
      throw new Error("messaging route does not support exact replies");
    }
    const input: OperationInput = action.compileTurnPart(
      target,
      Object.freeze({
        partId: part.partId,
        text: part.text,
        replyToProviderId: replyToProviderId ?? null,
      }),
    );
    const invocation = prepareInvocation(
      record.adapter.id,
      action.operation,
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
    return Object.freeze({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef,
      replyToProviderId: replyToProviderId ?? null,
      invocation,
    });
  });
  const initial = createMessagingCompositeInvocationPlan(
    plannedParts,
    Object.freeze({
      routeRef: record.routeRef,
      contextRef: context.contextRef,
      clientIntentSha256: turn.clientIntentSha256,
      contextBindingSha256,
      sourceConversationCoordinateSha256:
        exactContextBinding.sourceConversationCoordinate.sha256,
      turnDigest: messagingTurnDigest(turn),
      contextLimit: context.limit,
      baseExactDataRevision: context.exactDataRevision,
      baseLatestMessageRevision: context.latestMessageRevision,
      baseRouteStateRevision: baseRouteState.revision,
      baseMessages: messagingBaseMessages(current.messages),
      recipient: baseRouteState.recipient,
    }),
    observation,
    registry,
  );
  const initialComposite = initial.plan.messagingComposite;
  if (initialComposite === undefined) throw new Error("messaging composite plan disappeared");
  const preview: MessagingPreviewV1 = Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-preview",
    status: "confirmation-required",
    planDigest: initial.digest,
    expiresAt: initial.plan.expiresAt,
    routeRef: record.routeRef,
    contextRef: context.contextRef,
    clientIntentSha256: turn.clientIntentSha256,
    turnDigest: messagingTurnDigest(turn),
    recipient: initialComposite.recipient,
    partCount: turn.parts.length,
    bubbles: Object.freeze(turn.parts.map((part) => Object.freeze({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef,
    }))),
    risk: "R3",
    sideEffect: initial.plan.sideEffect,
  });
  const stored = bindMessagingCompositePreviewDigest(
    initial,
    sha256(canonicalJson(preview)),
  );
  if (invocationPlanDigest(stored.plan) !== preview.planDigest) {
    throw new Error("messaging preview changed its confirmation digest");
  }
  saveInvocationPlan(stored, environment);
  return preview;
}

export function previewFromStoredMessagingPlan(stored: StoredPlan): MessagingPreviewV1 {
  const composite = stored.plan.messagingComposite;
  if (composite === undefined) throw new Error("confirmation plan is not a messaging composite");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-preview",
    status: "confirmation-required",
    planDigest: stored.digest,
    expiresAt: stored.plan.expiresAt,
    routeRef: composite.routeRef,
    contextRef: composite.contextRef,
    clientIntentSha256: composite.clientIntentSha256,
    turnDigest: composite.turnDigest,
    recipient: composite.recipient,
    partCount: composite.parts.length,
    bubbles: Object.freeze(composite.parts.map((part) => Object.freeze({
      partId: part.partId,
      text: part.text,
      replyRef: part.replyRef,
    }))),
    risk: "R3",
    sideEffect: stored.plan.sideEffect,
  });
}

export function verifyStoredMessagingPreview(stored: StoredPlan): MessagingPreviewV1 {
  const composite = stored.plan.messagingComposite;
  if (composite === undefined) throw new Error("confirmation plan is not a messaging composite");
  const preview = previewFromStoredMessagingPlan(stored);
  if (sha256(canonicalJson(preview)) !== composite.previewDigest) {
    throw new Error("messaging preview digest does not match the exact reconstructed artifact");
  }
  return preview;
}

export function initializeMessagingCompositeRunInternal(
  stored: StoredPlan,
  runId: string,
  options: Pick<MessagingRuntimeOptions, "environment" | "now"> = {},
): MessagingRunSnapshotV1 {
  const composite = stored.plan.messagingComposite;
  if (composite === undefined) {
    throw new Error("confirmation plan is not a messaging composite");
  }
  verifyStoredMessagingPreview(stored);
  return initializeMessagingRun(
    runId,
    stored.digest,
    composite,
    options.environment ?? process.env,
    now(options).toISOString(),
  );
}

function messagingTransitionTime(
  snapshot: MessagingRunSnapshotV1,
  options: MessagingRuntimeOptions,
): string {
  const observed = now(options).toISOString();
  return Date.parse(observed) < Date.parse(snapshot.run.recordedAt)
    ? snapshot.run.recordedAt
    : observed;
}

function stopMessagingBeforeDispatch(
  snapshot: MessagingRunSnapshotV1,
  reason:
    | "context-drift"
    | "prefix-freshness-unproven"
    | "provider-failed-before-dispatch"
    | "journal-recovery-required",
  options: MessagingRuntimeOptions,
): MessagingRunSnapshotV1 {
  return updateMessagingRun(snapshot, {
    type: "categorical-stop",
    index: snapshot.run.provenPartCount,
    partState: snapshot.run.provenPartCount === 0
      ? "failed-before-dispatch"
      : "failed-permanent",
    reason,
    at: messagingTransitionTime(snapshot, options),
  }, options.environment ?? process.env);
}

function stopMessagingIndeterminate(
  snapshot: MessagingRunSnapshotV1,
  reason: "provider-result-indeterminate" | "journal-recovery-required",
  options: MessagingRuntimeOptions,
  privateProviderOutcome: MessagingPrivateProviderOutcomeV1 | null = null,
): MessagingRunSnapshotV1 {
  return updateMessagingRun(
    snapshot,
    reason === "provider-result-indeterminate"
      ? {
          type: "indeterminate",
          index: snapshot.run.provenPartCount,
          reason,
          privateProviderOutcome,
          at: messagingTransitionTime(snapshot, options),
        }
      : {
          type: "indeterminate",
          index: snapshot.run.provenPartCount,
          reason,
          at: messagingTransitionTime(snapshot, options),
        },
    options.environment ?? process.env,
  );
}

function stopMessagingAfterError(
  snapshot: MessagingRunSnapshotV1,
  options: MessagingRuntimeOptions,
): MessagingRunSnapshotV1 {
  const active = snapshot.run.parts[snapshot.run.provenPartCount];
  if (active?.state === "dispatching") {
    return stopMessagingIndeterminate(
      snapshot,
      "provider-result-indeterminate",
      options,
    );
  }
  if (active?.state === "claimed" || active?.state === "unattempted") {
    return stopMessagingBeforeDispatch(
      snapshot,
      "provider-failed-before-dispatch",
      options,
    );
  }
  if (snapshot.run.state !== "pending") return snapshot;
  throw new Error("messaging run error state could not be classified");
}

function stopMessagingAfterCaughtError(
  snapshot: MessagingRunSnapshotV1,
  options: MessagingRuntimeOptions,
): MessagingRunSnapshotV1 {
  try {
    return stopMessagingAfterError(snapshot, options);
  } catch {
    const environment = options.environment ?? process.env;
    const latest = readMessagingRun(snapshot.run.runId, environment);
    if (latest.run.state !== "pending") return latest;
    const active = latest.run.parts[latest.run.provenPartCount];
    if (active?.state === "dispatching") {
      return stopMessagingIndeterminate(
        latest,
        "journal-recovery-required",
        options,
      );
    }
    return stopMessagingBeforeDispatch(
      latest,
      "journal-recovery-required",
      options,
    );
  }
}

/**
 * Execute one already-owned and consumed composite confirmation. The caller
 * owns the outer confirmation claim and ordinary receipt projection. This
 * function owns the one encrypted per-bubble journal and never retries.
 */
export async function executeMessagingCompositeInternal(
  stored: StoredPlan,
  invocation: PreparedInvocation,
  initialSnapshot: MessagingRunSnapshotV1,
  options: MessagingRuntimeOptions = {},
): Promise<MessagingRunSnapshotV1> {
  const composite = stored.plan.messagingComposite;
  if (composite === undefined) {
    throw new Error("confirmation plan is not a messaging composite");
  }
  if (
    initialSnapshot.run.planDigest !== stored.digest
    || initialSnapshot.run.turnDigest !== composite.turnDigest
    || initialSnapshot.run.contextBindingSha256
      !== composite.contextBindingSha256
    || initialSnapshot.run.sourceConversationCoordinateSha256
      !== composite.sourceConversationCoordinateSha256
    || initialSnapshot.run.state !== "pending"
  ) throw new Error("messaging run does not own the exact composite plan");
  const environment = options.environment ?? process.env;
  const registry = options.registry ?? providerPluginRegistry;
  const actionResolution = messagingResolution(invocation, registry, "action");
  const action = actionResolution.messaging.action;
  if (action.state !== "supported") {
    throw new Error("messaging action support disappeared after confirmation");
  }
  if (actionResolution.binding.executeMessagingPart === undefined) {
    throw new Error("messaging provider has no private action executor");
  }
  if (actionResolution.binding.transport === "provider-api") {
    throw new Error(
      "messaging actions require a cleanup-qualified session or local CLI transport",
    );
  }
  const operation = invocation.manifest.operations[invocation.operationId];
  if (operation === undefined) {
    throw new Error("messaging action lost its exact operation recipe");
  }
  const actionTimeoutMs = isLocalCliOperation(operation)
    ? operation.localCli.timeoutMs
    : isWebSessionOperation(operation)
      ? operation.webSession.timeoutMs
      : null;
  if (actionTimeoutMs === null) {
    throw new Error("messaging action has no cleanup-qualified bounded recipe");
  }
  const boundAuth = invocation.auth;
  requireBoundAuth(actionResolution.binding, boundAuth);
  let snapshot = initialSnapshot;
  for (let index = snapshot.run.provenPartCount; index < composite.parts.length; index += 1) {
    if (snapshot.run.state !== "pending" || snapshot.run.provenPartCount !== index) {
      return snapshot;
    }
    if (options.signal?.aborted === true) {
      return stopMessagingBeforeDispatch(
        snapshot,
        "provider-failed-before-dispatch",
        options,
      );
    }
    const operationDeadline = new OperationDeadline(actionTimeoutMs, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.deadlineClock === undefined
        ? {}
        : { clock: options.deadlineClock }),
    });
    try {
      snapshot = await operationDeadline.run(async () => {
        try {
          await requireRuntimeReady(
            actionResolution.binding,
            boundAuth,
            environment,
            registry,
          );
        } catch {
          operationDeadline.throwIfUnavailable("messaging provider action");
          return stopMessagingBeforeDispatch(
            snapshot,
            "prefix-freshness-unproven",
            options,
          );
        }
        let record: MessagingRouteRecordV1;
        let routeResolution: MessagingResolution;
        let current: Awaited<ReturnType<typeof currentContextPage>>;
        let routeState: Awaited<ReturnType<typeof currentMessagingRouteState>>;
        try {
          const route = await resolveCurrentRoute(
            composite.routeRef,
            now(options),
            environment,
            registry,
          );
          record = route.record;
          routeResolution = route.resolution;
          if (
            routeResolution.binding !== actionResolution.binding
            || routeResolution.plugin.id !== actionResolution.plugin.id
            || routeResolution.messaging.contractId !== actionResolution.messaging.contractId
          ) {
            return stopMessagingBeforeDispatch(snapshot, "context-drift", options);
          }
          current = await currentContextPage(
            record,
            routeResolution,
            composite.contextLimit,
            environment,
            registry,
            operationDeadline.signal,
          );
          routeState = await currentMessagingRouteState(
            record,
            routeResolution,
            environment,
            registry,
            operationDeadline.signal,
          );
        } catch {
          operationDeadline.throwIfUnavailable("messaging provider action");
          return stopMessagingBeforeDispatch(
            snapshot,
            "prefix-freshness-unproven",
            options,
          );
        }
        if (
          routeState.revision !== composite.baseRouteStateRevision
          || record.sourceConversationCoordinate?.sha256
            !== composite.sourceConversationCoordinateSha256
        ) {
          return stopMessagingBeforeDispatch(snapshot, "context-drift", options);
        }
        let proof: ProviderPluginMessagingExpectedOwnPrefixProofV1;
        try {
          const accepted = messagingExpectedOwnPrefix(snapshot.run);
          proof = parseExpectedOwnPrefixProof(action.proveExpectedOwnPrefix(Object.freeze({
            base: Object.freeze({
              exactDataRevision: composite.baseExactDataRevision,
              latestMessageRevision: composite.baseLatestMessageRevision,
              contextLimit: composite.contextLimit,
              messages: composite.baseMessages,
            }),
            current: Object.freeze({
              exactDataRevision: current.exactDataRevision,
              latestMessageRevision: current.latestMessageRevision,
              messages: current.messages,
            }),
            accepted,
          })), accepted.length);
        } catch {
          operationDeadline.throwIfUnavailable("messaging provider action");
          return stopMessagingBeforeDispatch(
            snapshot,
            "prefix-freshness-unproven",
            options,
          );
        }
        operationDeadline.throwIfUnavailable("messaging provider action");
        if (
          proof.state !== "proven"
          || proof.matchedAcceptedPrefixCount < snapshot.run.observedAcceptedPrefixCount
        ) {
          return stopMessagingBeforeDispatch(snapshot, "context-drift", options);
        }
        snapshot = updateMessagingRun(snapshot, {
          type: "claimed",
          index,
          observedAcceptedPrefixCount: proof.matchedAcceptedPrefixCount,
          at: messagingTransitionTime(snapshot, options),
        }, environment);
        operationDeadline.throwIfUnavailable("messaging provider action");
        let crossedExternalBoundary = false;
        try {
          const recordPrivateIndeterminateOutcome = async (
            code: string,
          ): Promise<void> => {
            if (!crossedExternalBoundary) {
              throw new Error(
                "messaging provider outcome preceded its durable dispatch boundary",
              );
            }
            snapshot = stopMessagingIndeterminate(
              snapshot,
              "provider-result-indeterminate",
              options,
              Object.freeze({
                schemaVersion: 1,
                messagingContractId: actionResolution.messaging.contractId,
                code,
              }),
            );
          };
          const beforeExternalBegin = async (): Promise<void> => {
            operationDeadline.throwIfUnavailable("messaging provider action");
            if (crossedExternalBoundary) {
              throw new Error(
                "messaging provider attempted more than one dispatch boundary",
              );
            }
            snapshot = updateMessagingRun(snapshot, {
              type: "dispatching",
              index,
              at: messagingTransitionTime(snapshot, options),
            }, environment);
            crossedExternalBoundary = true;
            operationDeadline.throwIfUnavailable("messaging provider action");
          };
          const executePart = (
            deadline: Parameters<
              NonNullable<typeof actionResolution.binding.executeMessagingPart>
            >[3]["operationDeadline"],
            registerCleanupBarrier?: Parameters<
              NonNullable<typeof actionResolution.binding.executeMessagingPart>
            >[3]["registerCleanupBarrier"],
          ) => actionResolution.binding.executeMessagingPart!(
            action.operation,
            composite.parts[index]!.input,
            boundAuth,
            Object.freeze({
              beforeExternalBegin,
              recordPrivateIndeterminateOutcome,
              operationDeadline: deadline,
              signal: deadline.signal,
              ...(registerCleanupBarrier === undefined
                ? {}
                : { registerCleanupBarrier }),
              environment,
            }),
          );
          const output = actionResolution.binding.transport === "local-cli"
            ? await (() => {
                if (!isLocalCliOperation(operation)) {
                  throw new Error(
                    "local CLI messaging action lost its exact operation recipe",
                  );
                }
                return withLocalCliProviderCleanupAdmission(
                  {
                    registry,
                    binding: actionResolution.binding,
                    auth: boundAuth,
                    purpose: {
                      kind: "messaging",
                      action: operation.localCli.action,
                      contractVersion: operation.localCli.contractVersion,
                      messagingRunId: snapshot.run.runId,
                      partIndex: index,
                    },
                    environment,
                    ...(options.now === undefined ? {} : { now: options.now }),
                  },
                  (registerCleanupBarrier) => runLocalCliOperationWithDeadline(
                    operation.localCli,
                    {
                      environment,
                      signal: operationDeadline.signal,
                      operationDeadline,
                      registerCleanupBarrier,
                    },
                    (boundedOptions) => {
                      const boundedDeadline = boundedOptions.operationDeadline;
                      if (boundedDeadline === undefined) {
                        throw new Error(
                          "local CLI messaging deadline is unavailable",
                        );
                      }
                      return executePart(
                        boundedDeadline,
                        boundedOptions.registerCleanupBarrier,
                      );
                    },
                  ),
                );
              })()
            : await (() => {
                if (!isWebSessionOperation(operation)) {
                  throw new Error(
                    "session messaging action lost its exact operation recipe",
                  );
                }
                return withWebSessionCleanupAdmission(
                  messagingWebCleanupAdmissionIdentity(
                    invocation,
                    actionResolution,
                    registry,
                    snapshot.run.runId,
                    index,
                  ),
                  environment,
                  (registerCleanupBarrier) =>
                    runWebSessionOperationWithDeadline(
                      operation.webSession,
                      {
                        environment,
                        signal: operationDeadline.signal,
                        operationDeadline,
                        registerCleanupBarrier,
                      },
                      (boundedOptions) => {
                        const boundedDeadline = boundedOptions.operationDeadline;
                        if (boundedDeadline === undefined) {
                          throw new Error(
                            "session messaging deadline is unavailable",
                          );
                        }
                        return executePart(
                          boundedDeadline,
                          boundedOptions.registerCleanupBarrier,
                        );
                      },
                    ),
                  options.now,
                );
              })();
          if (snapshot.run.state !== "pending") return snapshot;
          operationDeadline.throwIfUnavailable("messaging provider action");
          if (!crossedExternalBoundary) {
            throw new Error(
              "messaging provider returned without crossing its durable dispatch boundary",
            );
          }
          const accepted = action.mapAcceptedResult(output);
          if (
            accepted.state !== "submitted"
            || typeof accepted.providerMessageId !== "string"
            || accepted.providerMessageId.length < 1
            || Buffer.byteLength(accepted.providerMessageId, "utf8") > 4_096
            || /[\0\r\n]/u.test(accepted.providerMessageId)
            || accepted.providerRevision !== null
              && (typeof accepted.providerRevision !== "string"
                || accepted.providerRevision.length < 1
                || Buffer.byteLength(accepted.providerRevision, "utf8") > 4_096
                || /[\0\r\n]/u.test(accepted.providerRevision))
          ) {
            throw new Error(
              "messaging provider returned malformed acceptance evidence",
            );
          }
          const existingProviderMessageIds = new Set([
            ...composite.baseMessages.map((message) =>
              message.providerMessageId),
            ...snapshot.run.parts
              .slice(0, snapshot.run.provenPartCount)
              .flatMap((part) => part.providerMessageId === null
                ? []
                : [part.providerMessageId]),
          ]);
          if (existingProviderMessageIds.has(accepted.providerMessageId)) {
            throw new Error(
              "messaging provider reused an existing message identity for acceptance",
            );
          }
          operationDeadline.throwIfUnavailable("messaging provider action");
          snapshot = updateMessagingRun(snapshot, {
            type: "accepted",
            index,
            providerMessageId: accepted.providerMessageId,
            providerRevision: accepted.providerRevision,
            at: messagingTransitionTime(snapshot, options),
          }, environment);
          operationDeadline.throwIfUnavailable("messaging provider action");
          return snapshot;
        } catch {
          return stopMessagingAfterCaughtError(snapshot, options);
        }
      }, "messaging provider action");
    } catch {
      snapshot = stopMessagingAfterCaughtError(snapshot, options);
    } finally {
      operationDeadline.dispose();
    }
    if (snapshot.run.state !== "pending") return snapshot;
  }
  return snapshot;
}

export function loadMessagingPreviewForConfirmationInternal(
  digest: string,
  options: Pick<MessagingRuntimeOptions, "environment"> = {},
): MessagingPreviewV1 {
  const stored = loadInvocationPlan(digest, options.environment ?? process.env);
  return verifyStoredMessagingPreview(stored);
}

export function showMessagingRunInternal(
  runId: string,
  options: Pick<MessagingRuntimeOptions, "environment"> = {},
): {
  readonly run: MessagingRunV1;
  readonly receipt: MessagingRunReceiptV1;
  readonly receiptBinding: MessagingReceiptBindingV1;
} {
  const run = readMessagingRun(runId, options.environment ?? process.env).run;
  if (run.state === "pending") {
    throw new Error("messaging run is pending or requires checked recovery");
  }
  return Object.freeze({
    run,
    receipt: messagingRunReceipt(run),
    receiptBinding: messagingReceiptBinding(run),
  });
}

export function reconcileMessagingRunInternal(
  runId: string,
  options: Pick<MessagingRuntimeOptions, "environment"> = {},
): {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-reconciliation";
  readonly runId: string;
  readonly state: MessagingRunV1["state"];
  readonly action: "not-required" | "retained-unretriable";
  readonly receiptBindingSha256: string;
  readonly reason: string;
} {
  const run = readMessagingRun(
    runId,
    options.environment ?? process.env,
  ).run;
  if (run.state === "pending") {
    throw new Error(
      "messaging run is pending; run wrench doctor before reconciliation",
    );
  }
  const binding = messagingReceiptBinding(run);
  const indeterminate = run.state === "indeterminate";
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-reconciliation",
    runId,
    state: run.state,
    action: indeterminate ? "retained-unretriable" : "not-required",
    receiptBindingSha256: binding.receiptSha256,
    reason: indeterminate
      ? "the provider result has no exact accepted message identity; the run remains indeterminate and must not be retried"
      : "the messaging run already has a categorical terminal state",
  });
}
