import { join } from "node:path";

import {
  definePortableProviderPluginProjection,
  PROVIDER_PLUGIN_API_VERSION,
  type ProviderPluginV1,
} from "./provider-plugin";
import type {
  VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  createAuthorizedKernelPortableProviderPluginBindingProjections,
} from "./provider-plugin-portable-authority";
import {
  resolvePortableProviderRuntimeDependencies,
  type PortableProviderRuntimeDependencies,
} from "./provider-plugin-portable-runtime";
import {
  extendProviderPluginRegistryWithPortablePlugins,
  type ProviderPluginRegistry,
} from "./provider-plugin-registry";
import {
  listInstalledPortableProviderPlugins,
  type InstalledPortableProviderPlugin,
} from "./provider-plugin-store";
import { wrenchStateHome } from "./storage";

type Environment = Readonly<Record<string, string | undefined>>;

export type PortableProviderPluginCatalog = {
  readonly registry: ProviderPluginRegistry;
  readonly installed: readonly InstalledPortableProviderPlugin[];
};

function projectWithResolvedDependencies(
  packageValue: VerifiedPortableProviderPluginPackage,
  environment: Environment,
  dependencies: PortableProviderRuntimeDependencies,
): ProviderPluginV1 {
  const bindings =
    createAuthorizedKernelPortableProviderPluginBindingProjections(
      packageValue,
      environment,
      dependencies,
    );
  return definePortableProviderPluginProjection({
    apiVersion: PROVIDER_PLUGIN_API_VERSION,
    id: packageValue.manifest.id,
    version: packageValue.manifest.version,
    displayName: packageValue.manifest.displayName,
    sourceKind: "portable",
    package: packageValue,
    bindings,
  });
}

/**
 * Project one already-verified immutable package into the ordinary provider
 * plugin contract. Projection is pure with respect to plugin code: it never
 * starts the package host or crosses a network boundary.
 */
export function projectPortableProviderPluginPackage(
  packageValue: VerifiedPortableProviderPluginPackage,
  environment: Environment = process.env,
  dependencyOverrides: Partial<PortableProviderRuntimeDependencies> = {},
): ProviderPluginV1 {
  return projectWithResolvedDependencies(
    packageValue,
    environment,
    resolvePortableProviderRuntimeDependencies(dependencyOverrides),
  );
}

export function createPortableProviderPluginCatalog(
  sourceRegistry: ProviderPluginRegistry,
  environment: Environment = process.env,
  dependencyOverrides: Partial<PortableProviderRuntimeDependencies> = {},
): PortableProviderPluginCatalog {
  const dependencies = resolvePortableProviderRuntimeDependencies(
    dependencyOverrides,
  );
  const installed = listInstalledPortableProviderPlugins(
    join(wrenchStateHome(environment), "provider-plugins"),
  );
  const portable = installed.map((entry) =>
    projectWithResolvedDependencies(entry.package, environment, dependencies));
  return Object.freeze({
    registry: extendProviderPluginRegistryWithPortablePlugins(
      sourceRegistry,
      portable,
    ),
    installed,
  });
}
