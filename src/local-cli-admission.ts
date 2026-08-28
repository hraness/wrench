import { randomUUID } from "node:crypto";

import type { WrenchAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import { localCliToolArtifactForCurrentRuntime } from "./local-cli-tool-identity";
import type { LocalCliPluginBindingV1 } from "./provider-plugin";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import {
  withWebSessionCleanupAdmission,
  type WebSessionCleanupAdmissionIdentity,
} from "./web-session-cleanup-admission";
import type { ProviderPluginCleanupBarrierRegistrar } from "./provider-plugin-cleanup-execution";

type Environment = Readonly<Record<string, string | undefined>>;

export type LocalCliCleanupAdmissionPurposeV1 =
  | { readonly kind: "inspect" }
  | { readonly kind: "subject-probe" }
  | {
      readonly kind: "messaging";
      readonly action: string;
      readonly contractVersion: number;
      readonly messagingRunId: string;
      readonly partIndex: number;
    }
  | {
      readonly kind: "reconcile";
      readonly action: string;
      readonly contractVersion: number;
      readonly recoveryRunId: string;
    };

function ownerForBinding(
  registry: ProviderPluginRegistry,
  binding: LocalCliPluginBindingV1,
) {
  const owners = registry.list().filter((plugin) =>
    plugin.bindings.some((candidate) => candidate === binding));
  if (owners.length !== 1 || owners[0] === undefined) {
    throw new Error("local CLI cleanup admission binding ownership is ambiguous");
  }
  return owners[0];
}

function cleanupAdmissionIdentity(
  registry: ProviderPluginRegistry,
  binding: LocalCliPluginBindingV1,
  auth: WrenchAuth | null,
  purpose: LocalCliCleanupAdmissionPurposeV1,
): WebSessionCleanupAdmissionIdentity {
  const plugin = ownerForBinding(registry, binding);
  if (purpose.kind === "reconcile" || purpose.kind === "messaging") {
    const operation = binding.operations.find((candidate) =>
      candidate.name === purpose.action
      && candidate.contractVersions.includes(purpose.contractVersion));
    if (
      operation === undefined
      || purpose.kind === "reconcile" && operation.reconciliation === undefined
      || purpose.kind === "messaging" && operation.risk !== "R3"
    ) {
      throw new Error(
        purpose.kind === "reconcile"
          ? "local CLI cleanup admission reconciliation route is not installed"
          : "local CLI cleanup admission messaging route is not an installed R3 operation",
      );
    }
  }
  const implementationHash = registry.implementationHash(binding).toString("hex");
  let artifact: ReturnType<typeof localCliToolArtifactForCurrentRuntime> | null;
  try {
    artifact = localCliToolArtifactForCurrentRuntime(binding.tool);
  } catch (error) {
    if (purpose.kind !== "inspect") throw error;
    artifact = null;
  }
  const executionIdentityHash = sha256(canonicalJson({
    schemaVersion: 1,
    transport: "local-cli",
    plugin: {
      id: plugin.id,
      version: plugin.version,
      implementationHash,
    },
    surfaceId: binding.surfaceId,
    tool: binding.tool,
    runtime: { platform: process.platform, arch: process.arch },
    artifact,
    purpose,
  }));
  return Object.freeze({
    runId: randomUUID(),
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    pluginImplementationHash: implementationHash,
    adapterId: "local-cli-kernel",
    adapterHash: executionIdentityHash,
    surfaceId: binding.surfaceId,
    authId: auth?.id ?? "local-cli-inspect",
    authHash: auth === null
      ? sha256(canonicalJson({ schemaVersion: 1, purpose: "local-cli-inspect" }))
      : sha256(canonicalJson(auth)),
    transport: "local-cli",
    executionIdentityHash,
  });
}

/**
 * Admit non-invocation local-CLI work (inspection, auth probes, and recovery
 * readback) to the same durable resource-containment kernel as normal runs.
 */
export function withLocalCliProviderCleanupAdmission<T>(
  input: {
    readonly registry: ProviderPluginRegistry;
    readonly binding: LocalCliPluginBindingV1;
    readonly auth: WrenchAuth | null;
    readonly purpose: LocalCliCleanupAdmissionPurposeV1;
    readonly environment?: Environment;
    readonly now?: Date;
  },
  operation: (
    registerCleanupBarrier: ProviderPluginCleanupBarrierRegistrar,
  ) => Promise<T>,
): Promise<T> {
  return withWebSessionCleanupAdmission(
    cleanupAdmissionIdentity(
      input.registry,
      input.binding,
      input.auth,
      input.purpose,
    ),
    input.environment ?? process.env,
    operation,
    input.now,
  );
}
