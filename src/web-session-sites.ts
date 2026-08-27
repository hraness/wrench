import type { ProviderPluginSurfaceId } from "./provider-plugin-identifiers";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";

export type WebSessionSiteId = ProviderPluginSurfaceId;
export type BundledWebSessionSiteId = WebSessionSiteId;

function sessionBindings(registry: ProviderPluginRegistry) {
  return registry.list().flatMap((plugin) =>
    plugin.bindings.filter((binding) =>
      binding.transport === "web-session-api"
      || binding.transport === "linked-device"))
    .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
}

/** Every authenticated-session surface in deterministic order. */
export function listWebSessionSiteIds(
  registry: ProviderPluginRegistry,
): readonly WebSessionSiteId[] {
  return Object.freeze(
    sessionBindings(registry).map((binding) => binding.surfaceId),
  );
}

export function projectWebSessionOrigins(
  registry: ProviderPluginRegistry,
): Readonly<Partial<Record<WebSessionSiteId, `https://${string}`>>> {
  return Object.freeze(Object.fromEntries(
    sessionBindings(registry).map((binding) => [
      binding.surfaceId,
      binding.origin,
    ]),
  ));
}

export function projectWebSessionOperations(
  registry: ProviderPluginRegistry,
): Readonly<Partial<Record<WebSessionSiteId, readonly string[]>>> {
  return Object.freeze(Object.fromEntries(
    sessionBindings(registry).map((binding) => [
      binding.surfaceId,
      Object.freeze([
        ...new Set(binding.operations.map((operation) => operation.name)),
      ]),
    ]),
  ));
}

/**
 * New sites use namespaced subjects so unrelated providers cannot satisfy the
 * wrong realm. Compatibility formats remain owned by each injected binding.
 */
export function webSessionSubjectMatches(
  site: WebSessionSiteId,
  subject: string,
  registry: ProviderPluginRegistry,
): boolean {
  return registry.resolveSessionRoute(site)?.subject.matches(subject) ?? false;
}
