import type { WrenchAuth } from "./auth";
import type {
  ProviderPluginAuthKind,
  ProviderPluginBindingV1,
  ProviderPluginTransport,
} from "./provider-plugin";

export type ProviderPluginAuthBinding = {
  readonly surfaceId: string;
  readonly transport: ProviderPluginTransport;
  readonly authKinds: readonly ProviderPluginAuthKind[];
};

/**
 * Enforce the kernel-owned relationship between a resolved plugin binding and
 * an auth locator. Plugins choose accepted auth kinds; realm-bearing locators
 * remain bound to the exact surface that selected them.
 */
export function requireProviderPluginAuth(
  binding: ProviderPluginAuthBinding | ProviderPluginBindingV1,
  auth: WrenchAuth,
): void {
  if (!binding.authKinds.includes(auth.kind)) {
    throw new Error(
      `provider plugin surface ${binding.surfaceId} does not accept ${auth.kind} auth`,
    );
  }
  if (
    (auth.kind === "oauth-token-file" || auth.kind === "linked-device-store")
    && auth.provider !== binding.surfaceId
  ) {
    throw new Error(
      `auth locator ${auth.id} is for ${auth.provider}, not ${binding.surfaceId}`,
    );
  }
}
