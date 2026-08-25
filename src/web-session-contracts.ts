import { createHash } from "node:crypto";

import type {
  BrowserDispatchPlan,
  OperationInput,
  WebSessionRecipe,
  WebSessionSiteId,
} from "./model";
import type { WebSessionPluginOperationV1 } from "./provider-plugin";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import type { ProviderPluginOperationName } from "./provider-plugin-identifiers";
import type {
  WebSessionContract,
  WebSessionContractState,
} from "./web-session-contract-definitions";

export type { WebSessionContract, WebSessionContractState };

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("authenticated web contract contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("authenticated web contract contains an unsupported value");
}

const currentMarketplaceCursorDescription =
  "wrench-issued authenticated cursor returned by a complete prior Marketplace page; one chain supports at most 48 provider pages";
const predecessorMarketplaceCursorDescription =
  "oh-issued authenticated cursor returned by a complete prior Marketplace page; one chain supports at most 48 provider pages";

function predecessorCompatibleWebSessionContractValue(
  contract: WebSessionContract,
): unknown {
  // The plugin advertises historical v1 and active v2 from one present
  // operation schema. Both exact predecessor rows carried the Oh cursor text.
  // Future versions must never inherit this compatibility projection.
  const isExactPredecessorMarketplaceFeedVersion =
    contract.contractVersion === 1 || contract.contractVersion === 2;
  if (
    contract.site !== "facebook-marketplace"
    || contract.operation !== "feeds.read"
    || !isExactPredecessorMarketplaceFeedVersion
  ) return contract;
  const project = (value: unknown): unknown => {
    if (value === currentMarketplaceCursorDescription) {
      return predecessorMarketplaceCursorDescription;
    }
    if (Array.isArray(value)) return value.map(project);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, project(entry)]),
    );
  };
  return project(contract);
}

function hashWebSessionContractWithImplementation(
  contract: WebSessionContract,
  implementationHash: Uint8Array,
): string {
  return createHash("sha256")
    .update(stableJson(predecessorCompatibleWebSessionContractValue(contract)))
    .update("\0")
    .update(implementationHash)
    .digest("hex");
}

function requireWebSessionOperation(
  recipe: Pick<WebSessionRecipe, "site" | "action" | "contractVersion">,
  registry: ProviderPluginRegistry,
) {
  const binding = registry.resolveSessionRoute(recipe.site);
  const resolution = binding === undefined
    ? undefined
    : registry.resolveOperationDefinition(
      binding.transport,
      recipe.site,
      recipe.action,
      recipe.contractVersion,
    );
  if (
    resolution === undefined
    || resolution.binding.transport === "provider-api"
  ) {
    throw new Error(
      `authenticated web contract ${recipe.site}/${recipe.action}@${recipe.contractVersion} is not installed`,
    );
  }
  return {
    ...resolution,
    operation: resolution.operation as WebSessionPluginOperationV1,
  };
}

function projectWebSessionContract(
  site: WebSessionSiteId,
  operationName: ProviderPluginOperationName,
  contractVersion: number,
  registry: ProviderPluginRegistry,
): WebSessionContract {
  const { operation } = requireWebSessionOperation({
    site,
    action: operationName,
    contractVersion,
  }, registry);
  return Object.freeze({
    site,
    operation: operation.name,
    contractVersion,
    risk: operation.risk,
    input: operation.input,
    sideEffect: operation.sideEffect,
    idempotency: operation.idempotency,
    dedupeWindowMs: operation.dedupeWindowMs,
    state: operation.state,
    dispatch: operation.dispatch,
    implementation: operation.implementation,
  });
}

const webSessionContractCaches = new WeakMap<
  ProviderPluginRegistry,
  Map<string, WebSessionContract>
>();

function webSessionContractCache(
  registry: ProviderPluginRegistry,
): Map<string, WebSessionContract> {
  const existing = webSessionContractCaches.get(registry);
  if (existing !== undefined) return existing;
  const created = new Map<string, WebSessionContract>();
  webSessionContractCaches.set(registry, created);
  return created;
}

function webSessionContractKey(
  recipe: Pick<WebSessionRecipe, "site" | "action" | "contractVersion">,
): string {
  return `${recipe.site}/${recipe.action}@${recipe.contractVersion}`;
}

export function getWebSessionContract(
  recipe: WebSessionRecipe,
  registry: ProviderPluginRegistry,
): WebSessionContract {
  const resolution = requireWebSessionOperation(recipe, registry);
  const key = webSessionContractKey(recipe);
  const existing = webSessionContractCache(registry).get(key);
  if (existing !== undefined) return existing;
  const projected = projectWebSessionContract(
    recipe.site,
    recipe.action,
    resolution.contractVersion,
    registry,
  );
  webSessionContractCache(registry).set(key, projected);
  return projected;
}

export function webSessionContractHash(
  contract: WebSessionContract,
  registry: ProviderPluginRegistry,
): string {
  const { binding } = requireWebSessionOperation({
    site: contract.site,
    action: contract.operation,
    contractVersion: contract.contractVersion,
  }, registry);
  return hashWebSessionContractWithImplementation(
    contract,
    registry.contractImplementationHash(binding),
  );
}

/** Accept only canonical writer identity or exact bounded predecessor aliases. */
export function isCompatibleWebSessionContractHash(
  contract: WebSessionContract,
  candidate: string,
  registry: ProviderPluginRegistry,
): boolean {
  if (candidate === webSessionContractHash(contract, registry)) return true;
  const { binding } = requireWebSessionOperation({
    site: contract.site,
    action: contract.operation,
    contractVersion: contract.contractVersion,
  }, registry);
  return registry.legacyContractImplementationHashes(
    binding,
    contract.operation,
    contract.contractVersion,
  ).some(
    (implementationHash) =>
      hashWebSessionContractWithImplementation(
        contract,
        implementationHash,
      ) === candidate,
  );
}

export function planWebSessionDispatches(
  recipe: WebSessionRecipe,
  input: OperationInput,
  registry: ProviderPluginRegistry,
): readonly BrowserDispatchPlan[] {
  getWebSessionContract(recipe, registry);
  return requireWebSessionOperation(recipe, registry).operation.planDispatches(input);
}

export function webSessionConditionalInputIssues(
  recipe: WebSessionRecipe,
  input: OperationInput,
  registry: ProviderPluginRegistry,
): readonly string[] {
  getWebSessionContract(recipe, registry);
  return requireWebSessionOperation(recipe, registry).operation.validateInput(input);
}
