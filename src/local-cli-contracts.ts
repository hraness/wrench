import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type {
  BrowserDispatchPlan,
  IdempotencyKind,
  InputSchema,
  LocalCliRecipe,
  OperationInput,
  OperationRisk,
} from "./model";
import type { LocalCliPluginOperationV1 } from "./provider-plugin";
import {
  isProviderPluginOperationName,
  isProviderPluginSurfaceId,
  type ProviderPluginOperationName,
} from "./provider-plugin-identifiers";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import {
  parseLocalCliToolIdentityV1,
  type LocalCliToolIdentityV1,
} from "./local-cli-tool-identity";

export type LocalCliContract = {
  readonly surface: string;
  readonly operation: ProviderPluginOperationName;
  readonly contractVersion: number;
  readonly risk: OperationRisk;
  readonly input: InputSchema;
  readonly sideEffect: string;
  readonly idempotency: IdempotencyKind;
  readonly dedupeWindowMs: number;
  readonly state: "observed" | "capture-required";
  readonly dispatch: "none" | "single" | "thread-items" | "bounded-items";
  readonly implementation: string;
  readonly tool: LocalCliToolIdentityV1;
};

export type LocalCliContractIdentityV1 = {
  readonly surface: string;
  readonly action: string;
  readonly version: number;
  readonly hash: string;
  readonly tool: LocalCliToolIdentityV1;
};

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function strictIdentityRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new Error("local CLI contract identity must be an object");
  }
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("local CLI contract identity has an unsupported prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    throw new Error("local CLI contract identity has unsupported symbol fields");
  }
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      !descriptor.enumerable
      || !("value" in descriptor)
      || !hasWellFormedUnicode(key)
      || /[\u0000-\u001f\u007f-\u009f]/u.test(key)
    ) {
      throw new Error("local CLI contract identity has unsupported accessor fields");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function parseLocalCliContractIdentityV1(
  value: unknown,
): LocalCliContractIdentityV1 {
  const record = strictIdentityRecord(value);
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== ["action", "hash", "surface", "tool", "version"].sort().join("\0")) {
    throw new Error("local CLI contract identity has unsupported fields");
  }
  if (
    !isProviderPluginSurfaceId(record.surface)
    || !isProviderPluginOperationName(record.action)
    || typeof record.version !== "number"
    || !Number.isSafeInteger(record.version)
    || record.version < 1
    || record.version > 1_000_000
    || typeof record.hash !== "string"
    || !/^[a-f0-9]{64}$/u.test(record.hash)
  ) {
    throw new Error("local CLI contract identity is malformed");
  }
  return Object.freeze({
    surface: record.surface,
    action: record.action,
    version: record.version,
    hash: record.hash,
    tool: parseLocalCliToolIdentityV1(record.tool),
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("local CLI contract contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error("local CLI contract contains an unsupported value");
}

function requireLocalCliOperation(
  recipe: Pick<LocalCliRecipe, "surface" | "action" | "contractVersion">,
  registry: ProviderPluginRegistry,
) {
  const resolution = registry.resolveOperationDefinition(
    "local-cli",
    recipe.surface,
    recipe.action,
    recipe.contractVersion,
  );
  if (resolution === undefined || resolution.binding.transport !== "local-cli") {
    throw new Error(
      `local CLI contract ${recipe.surface}/${recipe.action}@${recipe.contractVersion} is not installed`,
    );
  }
  return {
    ...resolution,
    binding: resolution.binding,
    operation: resolution.operation as LocalCliPluginOperationV1,
  };
}

const caches = new WeakMap<ProviderPluginRegistry, Map<string, LocalCliContract>>();

function cache(registry: ProviderPluginRegistry): Map<string, LocalCliContract> {
  const current = caches.get(registry);
  if (current !== undefined) return current;
  const created = new Map<string, LocalCliContract>();
  caches.set(registry, created);
  return created;
}

function key(recipe: Pick<LocalCliRecipe, "surface" | "action" | "contractVersion">): string {
  return `${recipe.surface}/${recipe.action}@${recipe.contractVersion}`;
}

export function getLocalCliContract(
  recipe: LocalCliRecipe,
  registry: ProviderPluginRegistry,
): LocalCliContract {
  const resolution = requireLocalCliOperation(recipe, registry);
  const contractKey = key(recipe);
  const current = cache(registry).get(contractKey);
  if (current !== undefined) return current;
  const contract: LocalCliContract = Object.freeze({
    surface: recipe.surface,
    operation: resolution.operation.name as ProviderPluginOperationName,
    contractVersion: resolution.contractVersion,
    risk: resolution.operation.risk,
    input: resolution.operation.input,
    sideEffect: resolution.operation.sideEffect,
    idempotency: resolution.operation.idempotency,
    dedupeWindowMs: resolution.operation.dedupeWindowMs,
    state: resolution.operation.state,
    dispatch: resolution.operation.dispatch,
    implementation: resolution.operation.implementation,
    tool: resolution.binding.tool,
  });
  cache(registry).set(contractKey, contract);
  return contract;
}

export function localCliContractHash(
  contract: LocalCliContract,
  registry: ProviderPluginRegistry,
): string {
  const { binding } = requireLocalCliOperation({
    surface: contract.surface,
    action: contract.operation,
    contractVersion: contract.contractVersion,
  }, registry);
  return createHash("sha256")
    .update(stableJson(contract))
    .update("\0")
    .update(registry.contractImplementationHash(binding))
    .digest("hex");
}

export function localCliContractIdentity(
  recipe: LocalCliRecipe,
  registry: ProviderPluginRegistry,
): LocalCliContractIdentityV1 {
  const contract = getLocalCliContract(recipe, registry);
  return Object.freeze({
    surface: contract.surface,
    action: contract.operation,
    version: contract.contractVersion,
    hash: localCliContractHash(contract, registry),
    tool: contract.tool,
  });
}

export function isCompatibleLocalCliContractHash(
  contract: LocalCliContract,
  candidate: string,
  registry: ProviderPluginRegistry,
): boolean {
  if (candidate === localCliContractHash(contract, registry)) return true;
  const { binding } = requireLocalCliOperation({
    surface: contract.surface,
    action: contract.operation,
    contractVersion: contract.contractVersion,
  }, registry);
  return registry.legacyContractImplementationHashes(
    binding,
    contract.operation,
    contract.contractVersion,
  ).some((implementationHash) =>
    createHash("sha256")
      .update(stableJson(contract))
      .update("\0")
      .update(implementationHash)
      .digest("hex") === candidate);
}

export function planLocalCliDispatches(
  recipe: LocalCliRecipe,
  input: OperationInput,
  registry: ProviderPluginRegistry,
): readonly BrowserDispatchPlan[] {
  getLocalCliContract(recipe, registry);
  return requireLocalCliOperation(recipe, registry).operation.planDispatches(input);
}

export function localCliConditionalInputIssues(
  recipe: LocalCliRecipe,
  input: OperationInput,
  registry: ProviderPluginRegistry,
): readonly string[] {
  getLocalCliContract(recipe, registry);
  return requireLocalCliOperation(recipe, registry).operation.validateInput(input);
}
