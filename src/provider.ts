import type { WrenchAuth } from "./auth";
import type { BrowserFileResolver } from "./browser";
import {
  getProviderContract,
  planProviderDispatches,
  providerConditionalInputIssues,
} from "./provider-contracts";
import {
  loadOAuthToken,
  ProviderHttpClient,
  requireOAuthScopes,
  type ProviderFetch,
} from "./provider-http";
import type {
  FileInputValue,
  OperationInput,
  ProviderRecipe,
  WrenchManifest,
} from "./model";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "./operation-deadline";
import { summarizePlanFile } from "./plan-assets";
import {
  pinnedHttpsFetch,
  type PinnedHttpsFetch,
} from "./pinned-https";
import { requireProviderPluginAuth } from "./provider-plugin-auth";
import type { ProviderPluginOperationV1 } from "./provider-plugin";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import type {
  ProviderActionContext,
  ProviderDispatchEvent,
  ProviderExecution,
  ProviderFile,
} from "./provider-context";

export type {
  ProviderActionContext,
  ProviderDispatchEvent,
  ProviderExecution,
  ProviderFile,
} from "./provider-context";

const OAUTH_VALIDITY_SKEW_MS = 30_000;
const PROVIDER_OPERATION_LABEL = "official provider operation";
const MINIMUM_PINNED_PROVIDER_TIMEOUT_MS = 1_000;

function isFileInputValue(value: unknown): value is FileInputValue {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { readonly kind?: unknown }).kind === "file"
    && typeof (value as { readonly reference?: unknown }).reference === "string";
}

function pinnedProviderFetch(
  deadline: OperationDeadline,
  transport: PinnedHttpsFetch,
): ProviderFetch {
  return (input, init = {}) => {
    const remaining = deadline.remainingTimeMs();
    if (remaining < MINIMUM_PINNED_PROVIDER_TIMEOUT_MS) {
      return Promise.reject(
        new Error(
          "official provider operation has insufficient time for a DNS-pinned request",
        ),
      );
    }
    const target = input instanceof URL
      ? new URL(input)
      : new URL(typeof input === "string" ? input : input.url);
    return transport(target, init, remaining);
  };
}

export function requireExecutableProviderOperation(
  operation: Pick<ProviderPluginOperationV1, "name" | "state">,
): void {
  if (operation.state === "capture-required") {
    throw new Error(
      `${operation.name} requires a reviewed provider contract before execution`,
    );
  }
}

/** Execute one fixed, code-owned official-provider contract. */
export async function executeProviderOperation(
  manifest: WrenchManifest,
  recipe: ProviderRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly fetch?: ProviderFetch;
    /** Deterministic seam for the production DNS-pinned default transport. */
    readonly pinnedFetch?: PinnedHttpsFetch;
    readonly fileResolver?: BrowserFileResolver;
    readonly beforeDispatch?: (event: ProviderDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: ProviderDispatchEvent) => Promise<void>;
    readonly now?: Date;
    readonly signal?: AbortSignal;
    readonly deadlineClock?: OperationDeadlineClock;
    readonly registry: ProviderPluginRegistry;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): Promise<ProviderExecution> {
  const deadline = new OperationDeadline(recipe.timeoutMs, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineClock === undefined
      ? {}
      : { clock: options.deadlineClock }),
  });
  let output: unknown = null;
  let finalUrl: string | null = null;
  let dispatches: ReturnType<typeof planProviderDispatches> = [];
  let started = 0;
  let verified = 0;
  const progress = (overrideVerified = verified): ProviderExecution["dispatch"] => ({
    planned: dispatches.length,
    started,
    verified: overrideVerified,
  });
  const failureStatus = (): ProviderExecution["status"] => {
    if (started > verified) return "indeterminate";
    if (verified > 0) return "partial";
    return "failed";
  };
  try {
    const registry = options.registry;
    const { binding, operation } = registry.requireOperationDefinition(
      "provider-api",
      recipe.provider,
      recipe.action,
      recipe.contractVersion,
    );
    if (binding.transport !== "provider-api") {
      throw new Error("official provider plugin resolved to the wrong transport");
    }
    requireExecutableProviderOperation(operation);
    const contract = getProviderContract(recipe, registry);
    dispatches = planProviderDispatches(recipe, input, registry);
    // Establish the full confirmed schedule before observing cancellation so a
    // pre-dispatch timeout still reports the exact planned count.
    deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    if (manifest.surfaceId !== recipe.provider || contract.provider !== recipe.provider) {
      throw new Error("official provider binding does not match its manifest surface");
    }
    requireProviderPluginAuth(binding, auth);
    if (auth.kind !== "oauth-token-file") {
      throw new Error("provider-api plugin binding violated its OAuth auth invariant");
    }
    const conditionalIssues = providerConditionalInputIssues(
      recipe,
      input,
      registry,
    );
    if (conditionalIssues.length > 0) throw new Error(conditionalIssues.join("; "));
    requireOAuthScopes(auth, contract.requiredScopeSets);
    deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    const token = loadOAuthToken(
      auth,
      options.now ?? new Date(),
      deadline.remainingTimeMs() + OAUTH_VALIDITY_SKEW_MS,
    );
    deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    const http = new ProviderHttpClient(
      options.fetch ?? pinnedProviderFetch(
        deadline,
        options.pinnedFetch ?? pinnedHttpsFetch,
      ),
      deadline,
      recipe.maxOutputBytes,
    );
    const resolvedFiles = new Map<string, readonly ProviderFile[]>();
    const resolveFiles = async (inputName: string): Promise<readonly ProviderFile[]> => {
      deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
      const existing = resolvedFiles.get(inputName);
      if (existing !== undefined) return existing;
      const raw = input[inputName];
      const values = Array.isArray(raw) ? raw.filter(isFileInputValue) : isFileInputValue(raw) ? [raw] : [];
      if (values.length === 0) {
        resolvedFiles.set(inputName, []);
        return [];
      }
      const resolver = options.fileResolver;
      if (resolver === undefined) throw new Error("official provider attachment resolver is unavailable");
      const paths = await deadline.run(
        () => resolver(values),
        PROVIDER_OPERATION_LABEL,
      );
      if (paths.length !== values.length) throw new Error("official provider attachment resolver returned the wrong file count");
      const files = values.map((value, index): ProviderFile => {
        const summary = summarizePlanFile(value);
        const path = paths[index];
        if (path === undefined) throw new Error("official provider attachment resolver omitted a file");
        return { value, path, ...summary };
      });
      resolvedFiles.set(inputName, files);
      return files;
    };
    const beginDispatch = async (): Promise<{
      readonly verify: () => Promise<void>;
    }> => {
      deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
      const planned = dispatches[started];
      if (planned === undefined) {
        throw new Error("official provider attempted an unplanned dispatch");
      }
      const index = started + 1;
      await options.beforeDispatch?.({
        id: planned.id,
        index,
        progress: progress(),
      });
      started += 1;
      deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
      let completed = false;
      return Object.freeze({
        verify: async (): Promise<void> => {
          deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
          if (completed) {
            throw new Error("official provider verified one dispatch twice");
          }
          if (verified + 1 !== index || started !== index) {
            throw new Error(
              "official provider verified dispatches outside their confirmed order",
            );
          }
          const afterDispatchVerified = options.afterDispatchVerified;
          if (afterDispatchVerified !== undefined) {
            await deadline.run(
              () => afterDispatchVerified({
                id: planned.id,
                index,
                progress: progress(verified + 1),
              }),
              PROVIDER_OPERATION_LABEL,
            );
          }
          deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
          verified += 1;
          completed = true;
        },
      });
    };
    const context: ProviderActionContext = {
      manifest,
      recipe,
      contract,
      input,
      auth,
      token,
      http,
      environment: options.environment ?? process.env,
      signal: deadline.signal,
      remainingTimeMs: () => deadline.remainingTimeMs(),
      resolveFiles,
      beginDispatch,
      dispatch: async <T>(action: () => Promise<T>): Promise<T> => {
        const boundary = await beginDispatch();
        const result = await deadline.run(
          () => action(),
          PROVIDER_OPERATION_LABEL,
        );
        await boundary.verify();
        return result;
      },
      addRequiredScopes: (scopes) => {
        deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
        requireOAuthScopes(auth, contract.requiredScopeSets, scopes);
      },
      setOutput: (value) => {
        deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
        output = value;
      },
      setFinalUrl: (value) => {
        deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
        finalUrl = value;
      },
    };
    await deadline.run(
      () => binding.execute(context),
      PROVIDER_OPERATION_LABEL,
    );
    deadline.throwIfUnavailable(PROVIDER_OPERATION_LABEL);
    if (started !== dispatches.length || verified !== dispatches.length) {
      throw new Error("official provider did not complete its confirmed dispatch schedule");
    }
    return {
      status: "succeeded",
      output,
      finalUrl,
      dispatchStarted: started > 0,
      dispatch: progress(),
    };
  } catch (error) {
    return {
      status: failureStatus(),
      output,
      finalUrl,
      dispatchStarted: started > 0,
      dispatch: progress(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deadline.dispose();
  }
}
