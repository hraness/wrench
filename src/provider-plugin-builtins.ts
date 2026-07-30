import {
  type ProviderContract,
} from "./provider-contract-definitions";
import { planProviderContractDispatches } from "./provider-contract-planning";
import { assertContractSemanticIdentity } from "./provider-contract-semantic-identity";
import type {
  ProviderApiPluginOperationDefinitionV1,
  ProviderPluginAuthKind,
  ProviderPluginImplementationSourceDefinitionV1,
  WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import type { WebSessionContract } from "./web-session-contract-definitions";
import { planWebSessionContractDispatches } from "./web-session-contract-planning";
import type { OperationInput } from "./model";

export const browserSessionAuthKinds = Object.freeze([
  "browser-profile",
  "cookie-source",
  "cookies-file",
] as const satisfies readonly ProviderPluginAuthKind[]);

export const oauthTokenAuthKinds = Object.freeze([
  "oauth-token-file",
] as const satisfies readonly ProviderPluginAuthKind[]);

export const linkedDeviceAuthKinds = Object.freeze([
  "linked-device-store",
] as const satisfies readonly ProviderPluginAuthKind[]);

/**
 * Adapt reviewed official-provider definitions into complete plugin-owned host
 * contracts. Hooks deliberately close over one exact contract version.
 */
export function officialContractOperations(
  contracts: readonly ProviderContract[],
  options: {
    readonly semanticIdentity: string;
    readonly validateInput: (
      contract: ProviderContract,
      input: OperationInput,
    ) => readonly string[];
    readonly validateSubjectInput?: (
      contract: ProviderContract,
      input: OperationInput,
      subject: string,
    ) => readonly string[];
  },
): readonly ProviderApiPluginOperationDefinitionV1[] {
  assertContractSemanticIdentity(
    contracts[0]?.provider ?? "official provider",
    contracts,
    options.semanticIdentity,
  );
  const validateSubjectInput = options.validateSubjectInput;
  return Object.freeze(contracts.map((contract) => Object.freeze({
    name: contract.operation,
    contractVersion: contract.contractVersion,
    risk: contract.risk,
    input: contract.input,
    sideEffect: contract.sideEffect,
    idempotency: contract.idempotency,
    dedupeWindowMs: contract.dedupeWindowMs,
    state: contract.state,
    dispatch: contract.dispatch,
    implementation: contract.implementation,
    requiredScopeSets: contract.requiredScopeSets,
    coverage: contract.coverage,
    planDispatches: (input: OperationInput) =>
      planProviderContractDispatches(contract, input),
    validateInput: (input: OperationInput) =>
      options.validateInput(contract, input),
    ...(validateSubjectInput === undefined
      ? {}
      : {
        validateSubjectInput: (input: OperationInput, subject: string) =>
          validateSubjectInput(contract, input, subject),
      }),
  })));
}

/**
 * Adapt reviewed authenticated-session definitions into complete plugin-owned
 * host contracts. Conditional input laws are encoded in the exact input schema.
 */
export function webSessionContractOperations(
  contracts: readonly WebSessionContract[],
  semanticIdentity: string,
  historicalVersions: Readonly<Record<string, readonly number[]>> = {},
): readonly WebSessionPluginOperationDefinitionV1[] {
  assertContractSemanticIdentity(
    contracts[0]?.site ?? "authenticated session",
    contracts,
    semanticIdentity,
  );
  return Object.freeze(contracts.map((contract) => Object.freeze({
    name: contract.operation,
    contractVersion: contract.contractVersion,
    ...(historicalVersions[contract.operation] === undefined
      ? {}
      : { historicalContractVersions: historicalVersions[contract.operation] }),
    risk: contract.risk,
    input: contract.input,
    sideEffect: contract.sideEffect,
    idempotency: contract.idempotency,
    dedupeWindowMs: contract.dedupeWindowMs,
    state: contract.state,
    dispatch: contract.dispatch,
    implementation: contract.implementation,
    planDispatches: (input: OperationInput) =>
      planWebSessionContractDispatches(contract, input),
    validateInput: () => Object.freeze([]),
  })));
}

function source(
  base: string,
  label: string,
  relativePath: string,
): ProviderPluginImplementationSourceDefinitionV1 {
  return Object.freeze({ label, url: new URL(relativePath, base) });
}

export function officialImplementationSources(
  base: string,
  implementation: "linkedin" | "x",
): readonly ProviderPluginImplementationSourceDefinitionV1[] {
  return Object.freeze([
    source(base, "plugin.ts", "./plugin.ts"),
    source(base, "kernel/provider-plugin-builtins.ts", "../../provider-plugin-builtins.ts"),
    source(base, "kernel/provider-contract-planning.ts", "../../provider-contract-planning.ts"),
    source(base, "kernel/provider-contract-semantic-identity.ts", "../../provider-contract-semantic-identity.ts"),
    source(base, "kernel/provider-context.ts", "../../provider-context.ts"),
    source(base, "kernel/provider-subject.ts", "../../provider-subject.ts"),
    source(base, `contracts/${implementation}-input.ts`, `../../provider-contract-input-${implementation}.ts`),
    source(base, "kernel/provider-http.ts", "../../provider-http.ts"),
    source(base, "kernel/operation-deadline.ts", "../../operation-deadline.ts"),
    source(base, `providers/${implementation}.ts`, `../../providers/${implementation}.ts`),
  ]);
}

export function webImplementationSources(
  base: string,
  providerSources: readonly (readonly [label: string, relativePath: string])[],
): readonly ProviderPluginImplementationSourceDefinitionV1[] {
  return Object.freeze([
    source(base, "plugin.ts", "./plugin.ts"),
    source(base, "kernel/provider-plugin-builtins.ts", "../../provider-plugin-builtins.ts"),
    source(base, "kernel/provider-contract-semantic-identity.ts", "../../provider-contract-semantic-identity.ts"),
    source(base, "kernel/web-session-contract-planning.ts", "../../web-session-contract-planning.ts"),
    source(base, "kernel/canonical-json.ts", "../../canonical-json.ts"),
    source(base, "kernel/web-session-execution.ts", "../../web-session-execution.ts"),
    source(base, "kernel/web-session-client.ts", "../../web-session-client.ts"),
    source(base, "kernel/operation-deadline.ts", "../../operation-deadline.ts"),
    source(base, "kernel/pinned-https.ts", "../../pinned-https.ts"),
    ...providerSources.map(([label, relativePath]) => source(base, label, relativePath)),
  ]);
}
