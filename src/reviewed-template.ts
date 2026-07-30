import type { WrenchAuth } from "./auth";
import {
  canonicalJson,
  isReviewedTemplateOperation,
  sha256,
  type BrowserDispatchPlan,
  type OperationInput,
  type OperationRisk,
  type ReviewedTemplateRecipe,
  type WrenchManifest,
} from "./model";
import {
  executeWebSessionTemplate,
  type WebSessionHttpDependencies,
} from "./web-session-http";

export type ReviewedTemplateExecution = {
  readonly status: "succeeded" | "failed" | "indeterminate";
  readonly output: unknown;
  readonly finalUrl: string | null;
  readonly dispatchStarted: boolean;
  readonly dispatch: {
    readonly planned: number;
    readonly started: number;
    readonly verified: number;
  };
  readonly error?: string;
};

export type ReviewedTemplateDispatchEvent = {
  readonly id: string;
  readonly index: number;
  readonly progress: ReviewedTemplateExecution["dispatch"];
};

export type ReviewedTemplateOperationExecutor = (
  manifest: WrenchManifest,
  operationId: string,
  recipe: ReviewedTemplateRecipe,
  input: OperationInput,
  auth: WrenchAuth,
  options: {
    readonly beforeDispatch?: (event: ReviewedTemplateDispatchEvent) => Promise<void>;
    readonly afterDispatchVerified?: (event: ReviewedTemplateDispatchEvent) => Promise<void>;
    readonly dependencies?: Partial<WebSessionHttpDependencies>;
  },
) => Promise<ReviewedTemplateExecution>;

export function reviewedTemplateHash(recipe: ReviewedTemplateRecipe): string {
  return sha256(canonicalJson(recipe));
}

export function planReviewedTemplateDispatches(
  operationId: string,
  risk: OperationRisk,
  recipe: ReviewedTemplateRecipe,
): readonly BrowserDispatchPlan[] {
  if (recipe.state !== "reviewed") throw new Error(`${operationId} is capture-required and cannot be planned`);
  void risk;
  throw new Error(
    `${operationId} cannot execute until reviewed-template contractVersion 2 provides a current-account identity preflight`,
  );
}

export function isCookieCapableWebAuth(auth: WrenchAuth): boolean {
  return auth.kind === "cookie-source"
    || auth.kind === "cookies-file"
    || (auth.kind === "browser-profile" && auth.cookieSource !== undefined);
}

/** Fail-closed executor placeholder until reviewed-template contractVersion 2 exists. */
export const executeReviewedTemplateOperation: ReviewedTemplateOperationExecutor = async (
  manifest,
  operationId,
  recipe,
  input,
  auth,
  options,
) => {
  const operation = manifest.operations[operationId];
  if (operation === undefined || !isReviewedTemplateOperation(operation)) {
    throw new Error(`adapter does not provide reviewed template ${operationId}`);
  }
  if (recipe.state !== "reviewed") {
    throw new Error(`${operationId} is capture-required and has no executable template`);
  }
  if (!isCookieCapableWebAuth(auth)) {
    throw new Error("reviewed templates require cookie-source, cookies-file, or cookie-backed browser-profile auth");
  }
  const dispatches = planReviewedTemplateDispatches(operationId, operation.risk, recipe);
  const planned = dispatches.length;
  let started = 0;
  let verified = 0;
  try {
    const result = await executeWebSessionTemplate(recipe.template, input, auth, {
      timeoutMs: recipe.timeoutMs,
      ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
      ...(planned === 0 ? {} : {
        beforeRequest: async () => {
          const plannedDispatch = dispatches[0];
          if (plannedDispatch === undefined) throw new Error("reviewed template dispatch schedule disappeared");
          await options.beforeDispatch?.({
            id: plannedDispatch.id,
            index: 1,
            progress: { planned, started: 0, verified: 0 },
          });
          started = 1;
        },
        afterResponseVerified: async () => {
          const plannedDispatch = dispatches[0];
          if (plannedDispatch === undefined || started !== 1) {
            throw new Error("reviewed template verified an unplanned dispatch");
          }
          await options.afterDispatchVerified?.({
            id: plannedDispatch.id,
            index: 1,
            progress: { planned, started: 1, verified: 1 },
          });
          verified = 1;
        },
      }),
    });
    return {
      status: "succeeded",
      output: {
        status: result.status,
        responseBytes: result.responseBytes,
        data: result.output,
      },
      finalUrl: recipe.template.origin,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
    };
  } catch {
    return {
      status: started > 0 ? "indeterminate" : "failed",
      output: null,
      finalUrl: recipe.template.origin,
      dispatchStarted: started > 0,
      dispatch: { planned, started, verified },
      error: started > 0
        ? "reviewed authenticated API response did not verify after dispatch"
        : "reviewed authenticated API request failed before dispatch",
    };
  }
};
