import type { WrenchAuth } from "./auth";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { getWebSessionContract, planWebSessionDispatches } from "./web-session-contracts";
import type { WebSessionSiteId } from "./web-session-sites";
import {
  requireValidWebSessionOperationInput,
  runWebSessionOperationWithDeadline,
  type WebSessionExecution,
  type WebSessionOperationExecutor,
} from "./web-session-execution";

export {
  requireValidWebSessionOperationInput,
  runWebSessionOperationWithDeadline,
  startWebSessionCleanupTrackedOperation,
  type WebSessionCleanupBarrierRegistrar,
  type WebSessionDispatchEvent,
  type WebSessionExecution,
  type WebSessionExecutionOptions,
  type WebSessionOperationDeadline,
  type WebSessionOperationExecutor,
  type WebSessionProviderAcceptedMutationTargetEvent,
  type WebSessionProviderBoundMutationTargetEvent,
} from "./web-session-execution";

export async function probeWebSessionSubject(
  site: WebSessionSiteId,
  auth: WrenchAuth,
  registry: ProviderPluginRegistry,
): Promise<string> {
  const binding = registry.requireSessionRoute(site);
  requireProviderPluginAuth(binding, auth);
  const probe = binding.subject.probe;
  if (probe === undefined) {
    throw new Error("authenticated web site has no registered current-account probe");
  }
  return probe(auth);
}

/**
 * Execute one code-owned first-party API capability. Provider implementations
 * are registered here as they graduate from capture-required evidence.
 */
export function createWebSessionOperationExecutor(
  registry: ProviderPluginRegistry,
): WebSessionOperationExecutor {
  return async (
    manifest,
    recipe,
    input,
    auth,
    options,
  ) => runWebSessionOperationWithDeadline(
    recipe,
    options,
    async (boundedOptions) => {
      const route = registry.requireSessionRoute(recipe.site);
      const { binding, operation } = registry.requireOperationDefinition(
      route.transport,
      recipe.site,
      recipe.action,
      recipe.contractVersion,
    );
      const contract = getWebSessionContract(recipe, registry);
      requireProviderPluginAuth(binding, auth);
      requireValidWebSessionOperationInput(operation, input);
      const planned = planWebSessionDispatches(recipe, input, registry).length;
      const unavailable = (reason: string): WebSessionExecution => ({
        status: "failed",
        output: null,
        finalUrl: binding.origin,
        dispatchStarted: false,
        dispatch: { planned, started: 0, verified: 0 },
        error: reason,
      });
      if (contract.state === "capture-required") {
        return unavailable(`${recipe.site} ${recipe.action} requires a fresh reviewed HAR contract before execution`);
      }
      // Provider runtimes own the distinction between a known pre-dispatch
      // failure and an indeterminate post-dispatch outcome. Do not flatten an
      // unexpected throw here: runPrepared will conservatively reconcile it
      // against the durable dispatch ledger.
      if (
        binding.transport !== "web-session-api"
        && binding.transport !== "linked-device"
      ) {
        return unavailable("authenticated web site operation resolved to the wrong plugin transport");
      }
      return binding.execute(manifest, recipe, input, auth, boundedOptions);
    },
  );
}
