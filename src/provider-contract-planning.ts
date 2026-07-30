import type { OperationInput } from "./model";
import type { ProviderContract } from "./provider-contract-definitions";

export function planProviderContractDispatches(
  contract: ProviderContract,
  input: OperationInput,
): readonly { readonly id: string; readonly description: string }[] {
  if (contract.dispatch === "none") return [];
  if (contract.dispatch === "single") {
    return [{
      id: contract.operation.replaceAll(".", "-"),
      description: `Execute ${contract.provider} ${contract.operation}`,
    }];
  }
  const items = input.items;
  if (!Array.isArray(items)) {
    throw new Error("thread provider input must contain a validated items array");
  }
  return items.map((_item, index) => ({
    id: `publish-item[${index + 1}]`,
    description: `Publish confirmed thread item ${index + 1}`,
  }));
}
