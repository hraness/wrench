import { createProviderPluginRegistry } from "./provider-plugin-registry";
import { generatedProviderPlugins } from "./provider-plugins.generated";

/** Statically imported trusted source plugins in deterministic catalog order. */
export const providerPlugins = generatedProviderPlugins;

/** The process-wide validated provider route and implementation registry. */
export const providerPluginRegistry = createProviderPluginRegistry(providerPlugins);
