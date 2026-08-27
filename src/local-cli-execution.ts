import type { WrenchAuth } from "./auth";
import type {
  FileInputValue,
  LocalCliRecipe,
  OperationInput,
  WrenchManifest,
} from "./model";
import type {
  OperationDeadline,
  OperationDeadlineClock,
} from "./operation-deadline";
import type { ProviderPluginCleanupBarrierRegistrar } from "./provider-plugin-cleanup-execution";
import type {
  ProviderAcceptedMutationTarget,
  ProviderBoundMutationTarget,
} from "./recovery";
import { runWebSessionOperationWithDeadline } from "./web-session-execution";

export type LocalCliFileResolver = (
  files: readonly FileInputValue[],
) => Promise<readonly string[]>;

export type LocalCliExecution = {
  readonly status: "succeeded" | "failed" | "partial" | "indeterminate";
  readonly output: unknown;
  readonly finalUrl: string | null;
  readonly noOp?: true;
  readonly dispatchStarted: boolean;
  readonly dispatch: {
    readonly planned: number;
    readonly started: number;
    readonly verified: number;
  };
  readonly error?: string;
};

export type LocalCliDispatchEvent = {
  readonly id: string;
  readonly index: number;
  readonly progress: LocalCliExecution["dispatch"];
};

export type LocalCliProviderAcceptedMutationTargetEvent = {
  readonly id: string;
  readonly index: number;
  readonly target: ProviderAcceptedMutationTarget;
};

export type LocalCliProviderBoundMutationTargetEvent = {
  readonly id: string;
  readonly index: number;
  readonly target: ProviderBoundMutationTarget;
};

export type LocalCliOperationDeadline = Pick<
  OperationDeadline,
  "signal" | "remainingTimeMs" | "run" | "throwIfUnavailable"
>;

export type LocalCliExecutionOptions = {
  readonly fileResolver?: LocalCliFileResolver;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly operationDeadline?: LocalCliOperationDeadline;
  readonly deadlineClock?: OperationDeadlineClock;
  readonly registerCleanupBarrier?: ProviderPluginCleanupBarrierRegistrar;
  readonly beforeDispatch?: (event: LocalCliDispatchEvent) => Promise<void>;
  readonly afterProviderAcceptedMutationTarget?: (
    event: LocalCliProviderAcceptedMutationTargetEvent,
  ) => Promise<void>;
  readonly afterProviderBoundMutationTarget?: (
    event: LocalCliProviderBoundMutationTargetEvent,
  ) => Promise<void>;
  readonly afterDispatchVerified?: (
    event: LocalCliDispatchEvent,
  ) => Promise<void>;
};

export type LocalCliOperationExecutor = (
  manifest: WrenchManifest,
  recipe: LocalCliRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: LocalCliExecutionOptions,
) => Promise<LocalCliExecution>;

/** Local transport facade over the shared bounded deadline/cleanup join. */
export function runLocalCliOperationWithDeadline<T>(
  recipe: Pick<LocalCliRecipe, "timeoutMs">,
  options: LocalCliExecutionOptions,
  execute: (boundedOptions: LocalCliExecutionOptions) => Promise<T>,
): Promise<T> {
  return runWebSessionOperationWithDeadline(
    recipe,
    options,
    (boundedOptions) => execute(boundedOptions),
  );
}
