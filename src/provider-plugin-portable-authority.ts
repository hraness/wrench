import type {
  ProviderPluginBindingDefinitionV1,
} from "./provider-plugin";
import type { WrenchManifest } from "./model";
import {
  isVerifiedPortableProviderPluginPackage,
  type PortableProviderPluginBindingV1,
  type VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  createKernelPortableProviderPluginBindingProjections,
  isResolvedPortableProviderRuntimeDependencies,
  type KernelPortableProviderPluginBindingProjection,
  type PortableProviderRuntimeDependencies,
} from "./provider-plugin-portable-runtime";

type Environment = Readonly<Record<string, string | undefined>>;

type PortableProjectionBindingAuthority = {
  readonly package: VerifiedPortableProviderPluginPackage;
  readonly portableBinding: PortableProviderPluginBindingV1;
  readonly adapterId: string;
  readonly manifest: WrenchManifest;
  readonly operations: ProviderPluginBindingDefinitionV1["operations"];
  readonly runtime: ProviderPluginBindingDefinitionV1["runtime"];
};

const authorizedBindings = new WeakMap<
  ProviderPluginBindingDefinitionV1,
  PortableProjectionBindingAuthority
>();

/**
 * Build and authorize the exact immutable child-host wrappers for one verified
 * package. There is intentionally no API that accepts caller-provided runtime
 * hooks: portable authority can only be minted around the kernel builder's
 * own return values.
 */
export function createAuthorizedKernelPortableProviderPluginBindingProjections(
  packageValue: VerifiedPortableProviderPluginPackage,
  environment: Environment,
  dependencies: PortableProviderRuntimeDependencies,
): readonly KernelPortableProviderPluginBindingProjection[] {
  if (
    !isVerifiedPortableProviderPluginPackage(packageValue)
    || !isResolvedPortableProviderRuntimeDependencies(dependencies)
  ) {
    throw new Error(
      "portable provider plugin binding authority requires an exact verified package and kernel dependencies",
    );
  }
  const projections = createKernelPortableProviderPluginBindingProjections(
    packageValue,
    environment,
    dependencies,
  );
  for (const projection of projections) {
    if (
      !packageValue.manifest.bindings.includes(projection.portableBinding)
      || !Object.isFrozen(projection)
      || !Object.isFrozen(projection.binding)
      || !Object.isFrozen(projection.binding.operations)
      || !projection.binding.operations.every(Object.isFrozen)
      || !Object.isFrozen(projection.binding.runtime)
    ) {
      throw new Error(
        "portable provider plugin kernel wrapper construction violated its immutable authority boundary",
      );
    }
    authorizedBindings.set(projection.binding, Object.freeze({
      package: packageValue,
      portableBinding: projection.portableBinding,
      adapterId: projection.adapterId,
      manifest: projection.manifest,
      operations: projection.binding.operations,
      runtime: projection.binding.runtime,
    }));
  }
  return projections;
}

export function assertKernelPortableProviderPluginBindingProjection(
  binding: ProviderPluginBindingDefinitionV1,
  packageValue: VerifiedPortableProviderPluginPackage,
  portableBinding: PortableProviderPluginBindingV1,
  adapterId: string,
  manifest: WrenchManifest,
): void {
  const authority = authorizedBindings.get(binding);
  if (
    authority?.package !== packageValue
    || authority.portableBinding !== portableBinding
    || authority.adapterId !== adapterId
    || authority.manifest !== manifest
    || authority.operations !== binding.operations
    || authority.runtime !== binding.runtime
    || !Object.isFrozen(binding)
    || !Object.isFrozen(binding.operations)
    || !binding.operations.every(Object.isFrozen)
    || !Object.isFrozen(binding.runtime)
  ) {
    throw new Error(
      "portable provider plugin runtime must be a kernel-owned child-host wrapper",
    );
  }
}
