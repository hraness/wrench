import type {
  BrowserDispatchPlan,
  OperationInput,
} from "./model";
import type { WebSessionContract } from "./web-session-contract-definitions";

export function planWebSessionContractDispatches(
  selected: WebSessionContract,
  input: OperationInput,
): readonly BrowserDispatchPlan[] {
  if (selected.state !== "observed") {
    throw new Error(
      `${selected.site} ${selected.operation} is capture-required: ${selected.implementation}`,
    );
  }
  if (selected.dispatch === "none") return [];
  if (selected.dispatch === "single") {
    return [{
      id: selected.operation,
      description: `Dispatch one reviewed ${selected.operation} internal API action`,
    }];
  }
  if (selected.dispatch === "bounded-items") {
    throw new Error(`${selected.site} ${selected.operation} requires its provider-owned bounded dispatch planner`);
  }
  const items = input.items;
  if (
    !Array.isArray(items)
    || items.length < 1
    || items.some((item) => typeof item !== "string")
  ) {
    throw new Error(
      "authenticated thread contract requires a non-empty string items input",
    );
  }
  return items.map((_item, index) => ({
    id: `${selected.operation}[${index + 1}]`,
    description: index === 0
      ? "Publish reviewed thread root"
      : `Publish reviewed thread reply ${index}`,
  }));
}
