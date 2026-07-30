import { createHash } from "node:crypto";

import {
  type providerContractDefinitions,
  type ProviderContract,
  type ProviderCoverage,
} from "./provider-contract-definitions";
import type {
  OfficialProviderId,
  OperationInput,
  ProviderRecipe,
} from "./model";
import type { ProviderApiPluginOperationV1 } from "./provider-plugin";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";

export type { ProviderContract, ProviderCoverage };

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("provider contract contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("provider contract contains an unsupported value");
}

function requireProviderOperation(
  recipe: Pick<ProviderRecipe, "provider" | "action" | "contractVersion">,
  registry: ProviderPluginRegistry,
) {
  const resolution = registry.resolveOperationDefinition(
    "provider-api",
    recipe.provider,
    recipe.action,
    recipe.contractVersion,
  );
  if (
    resolution === undefined
    || resolution.binding.transport !== "provider-api"
  ) {
    throw new Error(
      `official provider contract ${recipe.provider}/${recipe.action}@${recipe.contractVersion} is not installed`,
    );
  }
  return {
    ...resolution,
    operation: resolution.operation as ProviderApiPluginOperationV1,
  };
}

function projectProviderContract(
  provider: OfficialProviderId,
  operationName: string,
  contractVersion: number,
  registry: ProviderPluginRegistry,
): ProviderContract {
  const recipe = {
    provider,
    action: operationName,
    contractVersion,
  };
  const { operation } = requireProviderOperation(recipe, registry);
  return Object.freeze({
    provider,
    operation: operation.name,
    contractVersion,
    risk: operation.risk,
    sideEffect: operation.sideEffect,
    idempotency: operation.idempotency,
    dedupeWindowMs: operation.dedupeWindowMs,
    input: operation.input,
    state: operation.state,
    requiredScopeSets: operation.requiredScopeSets,
    dispatch: operation.dispatch,
    coverage: operation.coverage,
    implementation: operation.implementation,
  });
}

const providerContractCaches = new WeakMap<
  ProviderPluginRegistry,
  Map<string, ProviderContract>
>();

function providerContractCache(
  registry: ProviderPluginRegistry,
): Map<string, ProviderContract> {
  const existing = providerContractCaches.get(registry);
  if (existing !== undefined) return existing;
  const created = new Map<string, ProviderContract>();
  providerContractCaches.set(registry, created);
  return created;
}

function providerContractKey(
  recipe: Pick<ProviderRecipe, "provider" | "action" | "contractVersion">,
): string {
  return `${recipe.provider}/${recipe.action}@${recipe.contractVersion}`;
}

function projectProviderRegistry(
  provider: OfficialProviderId,
  registry: ProviderPluginRegistry,
): Readonly<Record<string, ProviderContract>> {
  const binding = registry.requireRoute("provider-api", provider);
  if (binding.transport !== "provider-api") {
    throw new Error(`provider plugin surface ${provider} is not a provider-api binding`);
  }
  return Object.freeze(Object.fromEntries(binding.operations.map(
    (operation) => {
      const projected = projectProviderContract(
        provider,
        operation.name,
        operation.contractVersion,
        registry,
      );
      providerContractCache(registry).set(providerContractKey({
        provider: projected.provider,
        action: projected.operation,
        contractVersion: projected.contractVersion,
      }), projected);
      return [operation.name, projected];
    },
  )));
}

export function projectProviderContracts(
  registry: ProviderPluginRegistry,
): Readonly<
  Record<string, Readonly<Record<string, ProviderContract>>>
> & typeof providerContractDefinitions {
  return Object.freeze(Object.fromEntries(
    registry.list().flatMap((plugin) =>
  plugin.bindings
    .filter((binding) => binding.transport === "provider-api")
    .map((binding) => [
      binding.surfaceId,
      projectProviderRegistry(binding.surfaceId, registry),
    ])),
  )) as Readonly<
    Record<string, Readonly<Record<string, ProviderContract>>>
  > & typeof providerContractDefinitions;
}

export function getProviderContract(
  recipe: ProviderRecipe,
  registry: ProviderPluginRegistry,
): ProviderContract {
  const resolution = requireProviderOperation(recipe, registry);
  const key = providerContractKey(recipe);
  const existing = providerContractCache(registry).get(key);
  if (existing !== undefined) return existing;
  const projected = projectProviderContract(
    recipe.provider,
    resolution.operation.name,
    resolution.contractVersion,
    registry,
  );
  providerContractCache(registry).set(key, projected);
  return projected;
}

export function providerContractHash(
  contract: ProviderContract,
  registry: ProviderPluginRegistry,
): string {
  const { binding } = requireProviderOperation({
    provider: contract.provider,
    action: contract.operation,
    contractVersion: contract.contractVersion,
  }, registry);
  return createHash("sha256")
    .update(stableJson(contract))
    .update("\0")
    .update(registry.contractImplementationHash(binding))
    .digest("hex");
}

/**
 * Read-side compatibility for exact predecessor common-mode durable evidence.
 * New writers always use `providerContractHash` and its environment-neutral
 * predecessor runtime identity.
 */
export function isCompatibleProviderContractHash(
  contract: ProviderContract,
  candidate: string,
  registry: ProviderPluginRegistry,
): boolean {
  if (candidate === providerContractHash(contract, registry)) return true;
  const { binding } = requireProviderOperation({
    provider: contract.provider,
    action: contract.operation,
    contractVersion: contract.contractVersion,
  }, registry);
  return registry.legacyContractImplementationHashes(binding).some(
    (implementationHash) =>
      createHash("sha256")
        .update(stableJson(contract))
        .update("\0")
        .update(implementationHash)
        .digest("hex") === candidate,
  );
}

export function planProviderDispatches(
  recipe: ProviderRecipe,
  input: OperationInput,
  registry: ProviderPluginRegistry,
) {
  getProviderContract(recipe, registry);
  return requireProviderOperation(recipe, registry).operation.planDispatches(input);
}

export function providerConditionalInputIssues(
  recipe: ProviderRecipe,
  input: OperationInput,
  registry: ProviderPluginRegistry,
): readonly string[] {
  getProviderContract(recipe, registry);
  return requireProviderOperation(recipe, registry).operation.validateInput(input);
}
