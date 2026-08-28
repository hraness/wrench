import { join } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json";
import {
  parseMessageLikeMeSourceConversationCoordinateBindingV1,
  type MessageLikeMeSourceConversationCoordinateBindingV1,
} from "./message-like-me-agentic-messaging";
import type { OperationInput } from "./model";
import type { ProviderPluginMessagingTargetV1 } from "./provider-plugin";
import {
  openAuthenticatedPrivatePayload,
  sealAuthenticatedPrivatePayload,
} from "./read-projections";
import {
  createPrivateJsonIfAbsent,
  ensurePrivateStateDirectory,
  listPrivateStateDirectory,
  readPrivateStateFileIfPresent,
  removePrivateStateFile,
  wrenchStateHome,
} from "./storage";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_ENCRYPTED_RECORD_BYTES = 2 * 1024 * 1024;

export type MessagingRouteRecordV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-route-record";
  readonly routeRef: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly hash: string;
  };
  readonly plugin: {
    readonly id: string;
    readonly version: string;
    readonly closureHash: string;
  };
  readonly binding: {
    readonly surfaceId: string;
    readonly transport: "provider-api" | "web-session-api" | "linked-device" | "local-cli";
    readonly implementationIdentity: string;
    readonly messagingContractId: string;
  };
  readonly auth: {
    readonly id: string;
    readonly hash: string;
    readonly subject: string;
  };
  readonly list: {
    readonly operation: "messaging.list";
    readonly input: OperationInput;
    readonly inputHash: string;
    readonly exactDataRevision: string;
    readonly validatedAt: string;
  };
  readonly target: ProviderPluginMessagingTargetV1;
  readonly resolution: "list-candidate" | "exact-coordinate";
  readonly network: string;
  readonly sourceConversationCoordinate:
    | MessageLikeMeSourceConversationCoordinateBindingV1
    | null;
  readonly conversationProviderId: string;
  readonly conversation: {
    readonly kind: "single" | "group" | "unknown";
    readonly title: string | null;
    readonly participantCount: number;
    readonly participantFingerprint: string;
    readonly providerRevision: string | null;
  };
};

export type MessagingContextRecordV1 = {
  readonly schemaVersion: 1;
  readonly format: "wrench.messaging-context-record";
  readonly contextRef: string;
  readonly routeRef: string;
  readonly routeRecordHash: string;
  readonly sourceConversationCoordinate:
    MessageLikeMeSourceConversationCoordinateBindingV1;
  readonly exactDataRevision: string;
  readonly latestMessageRevision: string;
  readonly validatedAt: string;
  readonly expiresAt: string;
  readonly limit: number;
  readonly liveness: "fresh-as-of-live-preflight" | "freshness-unproven";
  readonly replyTargets: Readonly<Record<string, string>>;
};

function messagingRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return join(wrenchStateHome(environment), "messaging");
}

function ensureMessagingRecordDirectory(
  kind: "routes" | "contexts",
  environment: Readonly<Record<string, string | undefined>>,
) {
  ensurePrivateStateDirectory(messagingRoot(environment), environment);
  return ensurePrivateStateDirectory(
    join(messagingRoot(environment), kind),
    environment,
  );
}

function routePath(
  routeRef: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (!/^wmroute_[A-Za-z0-9_-]{22}$/u.test(routeRef)) {
    throw new Error("messaging route reference is malformed");
  }
  return join(messagingRoot(environment), "routes", `${routeRef}.json`);
}

function contextPath(
  contextRef: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (!/^wmcontext_[A-Za-z0-9_-]{22}$/u.test(contextRef)) {
    throw new Error("messaging context reference is malformed");
  }
  return join(messagingRoot(environment), "contexts", `${contextRef}.json`);
}

function routeDomain(routeRef: string): string {
  return `wrench-messaging-route-record-v1:${routeRef}`;
}

function contextDomain(contextRef: string): string {
  return `wrench-messaging-context-record-v1:${contextRef}`;
}

function observationTime(value: Date): number {
  const result = value.getTime();
  if (!Number.isFinite(result)) throw new Error("messaging record observation time is invalid");
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error(`${label} is malformed`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new Error(`${label} has unsupported fields`);
}

function string(value: unknown, label: string, maximum = 4_096): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} is malformed`);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(result)) throw new Error(`${label} is malformed`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label, 64);
  if (!Number.isFinite(Date.parse(result)) || !result.endsWith("Z")) {
    throw new Error(`${label} is malformed`);
  }
  return result;
}

function parseStringRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> {
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length < 1 || entries.length > 16) {
    throw new Error(`${label} has an invalid field count`);
  }
  return Object.freeze(Object.fromEntries(entries.map(([key, candidate]) => [
    string(key, `${label} key`, 128),
    string(candidate, `${label}.${key}`, 4_096),
  ])));
}

function parseOperationInput(value: unknown): OperationInput {
  const source = record(value, "messaging route list input");
  if (Buffer.byteLength(canonicalJson(source), "utf8") > 256 * 1024) {
    throw new Error("messaging route list input is too large");
  }
  return Object.freeze(source) as OperationInput;
}

export function parseMessagingRouteRecordV1(
  value: unknown,
): MessagingRouteRecordV1 {
  const source = record(value, "messaging route record");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "routeRef",
    "createdAt",
    "expiresAt",
    "adapter",
    "plugin",
    "binding",
    "auth",
    "list",
    "target",
    "resolution",
    "network",
    "sourceConversationCoordinate",
    "conversationProviderId",
    "conversation",
  ], "messaging route record");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-route-record") {
    throw new Error("messaging route record has an unsupported contract");
  }
  const adapter = record(source.adapter, "messaging route adapter");
  exactKeys(adapter, ["id", "version", "hash"], "messaging route adapter");
  const plugin = record(source.plugin, "messaging route plugin");
  exactKeys(plugin, ["id", "version", "closureHash"], "messaging route plugin");
  const binding = record(source.binding, "messaging route binding");
  exactKeys(binding, ["surfaceId", "transport", "implementationIdentity", "messagingContractId"], "messaging route binding");
  if (![
    "provider-api",
    "web-session-api",
    "linked-device",
    "local-cli",
  ].includes(String(binding.transport))) {
    throw new Error("messaging route binding transport is malformed");
  }
  const auth = record(source.auth, "messaging route auth");
  exactKeys(auth, ["id", "hash", "subject"], "messaging route auth");
  const list = record(source.list, "messaging route list");
  exactKeys(list, ["operation", "input", "inputHash", "exactDataRevision", "validatedAt"], "messaging route list");
  if (list.operation !== "messaging.list") {
    throw new Error("messaging route list operation is malformed");
  }
  const conversation = record(source.conversation, "messaging route conversation");
  exactKeys(conversation, ["kind", "title", "participantCount", "participantFingerprint", "providerRevision"], "messaging route conversation");
  if (
    conversation.kind !== "single"
    && conversation.kind !== "group"
    && conversation.kind !== "unknown"
  ) throw new Error("messaging route conversation kind is malformed");
  if (
    (conversation.title !== null && typeof conversation.title !== "string")
    || (conversation.providerRevision !== null && typeof conversation.providerRevision !== "string")
    || !Number.isSafeInteger(conversation.participantCount)
    || (conversation.participantCount as number) < 0
    || (conversation.participantCount as number) > 10_000
  ) throw new Error("messaging route conversation metadata is malformed");
  const routeRef = string(source.routeRef, "messaging route reference", 128);
  if (!/^wmroute_[A-Za-z0-9_-]{22}$/u.test(routeRef)) {
    throw new Error("messaging route reference is malformed");
  }
  if (
    source.resolution !== "list-candidate"
    && source.resolution !== "exact-coordinate"
  ) throw new Error("messaging route resolution state is malformed");
  const resolution = source.resolution;
  const network = string(source.network, "messaging route network", 64);
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(network)) {
    throw new Error("messaging route network is malformed");
  }
  const sourceConversationCoordinate = source.sourceConversationCoordinate === null
    ? null
    : parseMessageLikeMeSourceConversationCoordinateBindingV1(
        source.sourceConversationCoordinate,
      );
  if (resolution === "list-candidate" && sourceConversationCoordinate !== null) {
    throw new Error("messaging list candidate cannot claim an exact source coordinate");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-route-record",
    routeRef,
    createdAt: timestamp(source.createdAt, "messaging route createdAt"),
    expiresAt: timestamp(source.expiresAt, "messaging route expiresAt"),
    adapter: Object.freeze({
      id: string(adapter.id, "messaging route adapter ID", 64),
      version: string(adapter.version, "messaging route adapter version", 64),
      hash: digest(adapter.hash, "messaging route adapter hash"),
    }),
    plugin: Object.freeze({
      id: string(plugin.id, "messaging route plugin ID", 128),
      version: string(plugin.version, "messaging route plugin version", 64),
      closureHash: digest(plugin.closureHash, "messaging route plugin closure"),
    }),
    binding: Object.freeze({
      surfaceId: string(binding.surfaceId, "messaging route surface", 64),
      transport: binding.transport as MessagingRouteRecordV1["binding"]["transport"],
      implementationIdentity: digest(binding.implementationIdentity, "messaging route implementation identity"),
      messagingContractId: string(binding.messagingContractId, "messaging route contract ID", 128),
    }),
    auth: Object.freeze({
      id: string(auth.id, "messaging route auth ID", 48),
      hash: digest(auth.hash, "messaging route auth hash"),
      subject: string(auth.subject, "messaging route auth subject", 512),
    }),
    list: Object.freeze({
      operation: "messaging.list",
      input: parseOperationInput(list.input),
      inputHash: digest(list.inputHash, "messaging route list input hash"),
      exactDataRevision: digest(list.exactDataRevision, "messaging route list data revision"),
      validatedAt: timestamp(list.validatedAt, "messaging route list validatedAt"),
    }),
    target: parseStringRecord(source.target, "messaging route target"),
    resolution,
    network,
    sourceConversationCoordinate,
    conversationProviderId: string(source.conversationProviderId, "messaging route conversation identity"),
    conversation: Object.freeze({
      kind: conversation.kind,
      title: conversation.title as string | null,
      participantCount: conversation.participantCount as number,
      participantFingerprint: digest(conversation.participantFingerprint, "messaging route participant fingerprint"),
      providerRevision: conversation.providerRevision as string | null,
    }),
  });
}

export function parseMessagingContextRecordV1(
  value: unknown,
): MessagingContextRecordV1 {
  const source = record(value, "messaging context record");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "contextRef",
    "routeRef",
    "routeRecordHash",
    "sourceConversationCoordinate",
    "exactDataRevision",
    "latestMessageRevision",
    "validatedAt",
    "expiresAt",
    "limit",
    "liveness",
    "replyTargets",
  ], "messaging context record");
  if (source.schemaVersion !== 1 || source.format !== "wrench.messaging-context-record") {
    throw new Error("messaging context record has an unsupported contract");
  }
  const contextRef = string(source.contextRef, "messaging context reference", 128);
  const routeRef = string(source.routeRef, "messaging context route reference", 128);
  if (!/^wmcontext_[A-Za-z0-9_-]{22}$/u.test(contextRef) || !/^wmroute_[A-Za-z0-9_-]{22}$/u.test(routeRef)) {
    throw new Error("messaging context record has malformed references");
  }
  const targetsSource = record(source.replyTargets, "messaging context reply targets");
  if (Object.keys(targetsSource).length > 200) {
    throw new Error("messaging context has too many reply targets");
  }
  const replyTargets = Object.freeze(Object.fromEntries(
    Object.entries(targetsSource).map(([key, value]) => {
      if (!/^wmreply_[A-Za-z0-9_-]{22}$/u.test(key)) {
        throw new Error("messaging context reply reference is malformed");
      }
      return [key, string(value, "messaging context provider message identity")];
    }),
  ));
  if (
    !Number.isSafeInteger(source.limit)
    || (source.limit as number) < 1
    || (source.limit as number) > 200
  ) throw new Error("messaging context limit is malformed");
  if (
    source.liveness !== "fresh-as-of-live-preflight"
    && source.liveness !== "freshness-unproven"
  ) throw new Error("messaging context liveness is malformed");
  return Object.freeze({
    schemaVersion: 1,
    format: "wrench.messaging-context-record",
    contextRef,
    routeRef,
    routeRecordHash: digest(source.routeRecordHash, "messaging context route record hash"),
    sourceConversationCoordinate:
      parseMessageLikeMeSourceConversationCoordinateBindingV1(
        source.sourceConversationCoordinate,
      ),
    exactDataRevision: digest(source.exactDataRevision, "messaging context data revision"),
    latestMessageRevision: digest(source.latestMessageRevision, "messaging context latest revision"),
    validatedAt: timestamp(source.validatedAt, "messaging context validatedAt"),
    expiresAt: timestamp(source.expiresAt, "messaging context expiresAt"),
    limit: source.limit as number,
    liveness: source.liveness,
    replyTargets,
  });
}

export function messagingRouteRecordHash(record: MessagingRouteRecordV1): string {
  return sha256(canonicalJson(record));
}

export function saveMessagingRouteRecord(
  record: MessagingRouteRecordV1,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const parent = ensureMessagingRecordDirectory("routes", environment);
  const created = createPrivateJsonIfAbsent(
    routePath(record.routeRef, environment),
    sealAuthenticatedPrivatePayload(
      record,
      routeDomain(record.routeRef),
      environment,
      MAX_RECORD_BYTES,
    ),
    { environment, expectedStateParent: parent },
  );
  if (!created.created) throw new Error("messaging route reference already exists");
}

export function loadMessagingRouteRecord(
  routeRef: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  observation: Date = new Date(),
): MessagingRouteRecordV1 {
  const text = readPrivateStateFileIfPresent(
    routePath(routeRef, environment),
    MAX_ENCRYPTED_RECORD_BYTES,
    "messaging route record",
    environment,
  );
  if (text === null) throw new Error("messaging route is unavailable or expired");
  const parsed = parseMessagingRouteRecordV1(openAuthenticatedPrivatePayload(
    JSON.parse(text) as unknown,
    routeDomain(routeRef),
    environment,
    MAX_RECORD_BYTES,
  ));
  if (parsed.routeRef !== routeRef) throw new Error("messaging route record reference changed");
  if (Date.parse(parsed.expiresAt) <= observationTime(observation)) {
    throw new Error("messaging route is unavailable or expired");
  }
  return parsed;
}

export function saveMessagingContextRecord(
  record: MessagingContextRecordV1,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const parent = ensureMessagingRecordDirectory("contexts", environment);
  const created = createPrivateJsonIfAbsent(
    contextPath(record.contextRef, environment),
    sealAuthenticatedPrivatePayload(
      record,
      contextDomain(record.contextRef),
      environment,
      MAX_RECORD_BYTES,
    ),
    { environment, expectedStateParent: parent },
  );
  if (!created.created) throw new Error("messaging context reference already exists");
}

export function loadMessagingContextRecord(
  contextRef: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  observation: Date = new Date(),
): MessagingContextRecordV1 {
  const text = readPrivateStateFileIfPresent(
    contextPath(contextRef, environment),
    MAX_ENCRYPTED_RECORD_BYTES,
    "messaging context record",
    environment,
  );
  if (text === null) throw new Error("messaging context is unavailable or expired");
  const parsed = parseMessagingContextRecordV1(openAuthenticatedPrivatePayload(
    JSON.parse(text) as unknown,
    contextDomain(contextRef),
    environment,
    MAX_RECORD_BYTES,
  ));
  if (parsed.contextRef !== contextRef) throw new Error("messaging context record reference changed");
  if (Date.parse(parsed.expiresAt) <= observationTime(observation)) {
    throw new Error("messaging context is unavailable or expired");
  }
  return parsed;
}

export function purgeExpiredMessagingRecords(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  observation: Date = new Date(),
): Readonly<{ routes: number; contexts: number }> {
  observationTime(observation);
  let routes = 0;
  let contexts = 0;
  const purge = (
    kind: "routes" | "contexts",
  ): void => {
    const directory = join(messagingRoot(environment), kind);
    const identity = ensureMessagingRecordDirectory(kind, environment);
    const entries = listPrivateStateDirectory(directory, environment, identity);
    for (const entry of entries) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      const reference = entry.name.slice(0, -".json".length);
      try {
        if (kind === "routes") {
          loadMessagingRouteRecord(reference, environment, observation);
        } else {
          loadMessagingContextRecord(reference, environment, observation);
        }
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("expired")) {
          continue;
        }
        removePrivateStateFile(join(directory, entry.name), environment);
        if (kind === "routes") routes += 1;
        else contexts += 1;
      }
    }
  };
  purge("routes");
  purge("contexts");
  return Object.freeze({ routes, contexts });
}
