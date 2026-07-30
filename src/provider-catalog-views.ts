import type {
  OfficialProviderId,
} from "./model";
import { projectProviderContracts } from "./provider-contracts";
import type { ProviderPluginOperationName } from "./provider-plugin-identifiers";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  listWebSessionSiteIds,
  projectWebSessionOperations,
  projectWebSessionOrigins,
} from "./web-session-sites";

function providerApiBindings(registry: ProviderPluginRegistry) {
  return registry.list().flatMap((plugin) =>
    plugin.bindings.filter((binding) => binding.transport === "provider-api"));
}

export function listOfficialProviderIds(
  registry: ProviderPluginRegistry,
): readonly OfficialProviderId[] {
  return Object.freeze(
    providerApiBindings(registry).map((binding) => binding.surfaceId).sort(),
  );
}

export function projectOfficialProviderOperations(
  registry: ProviderPluginRegistry,
): Readonly<
  Partial<Record<OfficialProviderId, readonly ProviderPluginOperationName[]>>
> {
  return Object.freeze(Object.fromEntries(
    providerApiBindings(registry).map((binding) => [
      binding.surfaceId,
      Object.freeze(binding.operations.map((operation) => operation.name)),
    ]),
  ));
}

/** Host-only compatibility views for the bundled composition. */
export const officialProviderIds = listOfficialProviderIds(providerPluginRegistry);
export const officialProviderOperations =
  projectOfficialProviderOperations(providerPluginRegistry);
export const providerContracts =
  projectProviderContracts(providerPluginRegistry);
export const webSessionSiteIds = listWebSessionSiteIds(providerPluginRegistry);
export const webSessionOrigins = projectWebSessionOrigins(providerPluginRegistry);
export const webSessionOperations =
  projectWebSessionOperations(providerPluginRegistry);
