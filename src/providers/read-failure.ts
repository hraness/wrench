import { OperationDeadlineError } from "../operation-deadline";
import {
  readFailureProjection,
  type ReadFailureProjection,
  type WebSessionExecution,
} from "../web-session-execution";

export type ProviderReadFailureStage =
  | "bootstrap"
  | "identity"
  | "target"
  | "supplemental";

export class ProviderReadResponseRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("provider read response did not match the reviewed status contract");
    this.name = "ProviderReadResponseRejectedError";
    this.status = status;
  }
}

export class ProviderReadTransportError extends Error {
  constructor(cause: unknown) {
    super("provider read transport failed before a reviewed response", { cause });
    this.name = "ProviderReadTransportError";
  }
}

export class ProviderReadThrottledError extends Error {
  constructor() {
    super("provider read was throttled by bounded response metadata");
    this.name = "ProviderReadThrottledError";
  }
}

type ProviderReadFailureOptions = {
  readonly stage: ProviderReadFailureStage;
  readonly authenticated: boolean;
  readonly accountMismatch?: (error: Error) => boolean;
  readonly authRepairRequired?: (error: Error) => boolean;
  readonly targetUnavailable?: (error: Error) => boolean;
  readonly targetStatusUnavailable?: boolean;
};

function responseStatus(error: Error): number | null {
  if (error instanceof ProviderReadResponseRejectedError) return error.status;
  const match = /^(?:authenticated web (?:API )?request|authenticated web API|public first-party web asset) returned unreviewed status(?:\/content type)? ([1-5][0-9]{2})(?:\/|$)/u
    .exec(error.message);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function transientTransportFailure(error: Error): boolean {
  return error.message === "authenticated web API request failed before a reviewed response was received"
    || error.message === "authenticated web request failed before a reviewed response was received"
    || error.message === "authenticated web response body stream failed before completion"
    || error.message === "public first-party web asset request failed"
    || error.message === "public web asset upload failed before a reviewed response was received"
    || error instanceof ProviderReadTransportError;
}

export function providerReadFailureProjection(
  error: unknown,
  options: ProviderReadFailureOptions,
): ReadFailureProjection {
  let deadlineCause: unknown = error;
  for (let depth = 0; depth < 8 && deadlineCause !== undefined; depth += 1) {
    if (deadlineCause instanceof OperationDeadlineError) {
      return deadlineCause.failure === "timed-out"
        ? readFailureProjection("operation-timeout")
        : readFailureProjection("contract-drift");
    }
    deadlineCause = deadlineCause instanceof Error
      ? deadlineCause.cause
      : undefined;
  }
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (
      current instanceof OperationDeadlineError
      && current.failure === "timed-out"
    ) return readFailureProjection("operation-timeout");
    if (current instanceof ProviderReadThrottledError) {
      return readFailureProjection("provider-throttled");
    }
    if (current instanceof Error) {
      if (options.accountMismatch?.(current) === true) {
        return readFailureProjection("account-mismatch");
      }
      if (options.authRepairRequired?.(current) === true) {
        return readFailureProjection("auth-repair-required");
      }
      if (
        options.stage === "target"
        && options.targetUnavailable?.(current) === true
      ) return readFailureProjection("target-unavailable");
      const status = responseStatus(current);
      if (status === 401 || status === 403) {
        return options.authenticated
          ? readFailureProjection("auth-repair-required")
          : readFailureProjection("contract-drift");
      }
      if (status === 429) return readFailureProjection("provider-throttled");
      if (status === 404) {
        return options.stage === "target" && options.targetStatusUnavailable === true
          ? readFailureProjection("target-unavailable")
          : readFailureProjection("contract-drift");
      }
      if (status === 302 || status === 408 || (status !== null && status >= 500)) {
        return readFailureProjection("provider-temporary");
      }
      if (transientTransportFailure(current)) {
        return readFailureProjection("provider-temporary");
      }
      current = current.cause;
      continue;
    }
    break;
  }
  return readFailureProjection("contract-drift");
}

export function failedProviderRead(
  provider: string,
  error: unknown,
  finalUrl: string | null,
  options: ProviderReadFailureOptions,
): WebSessionExecution {
  return {
    status: "failed",
    output: null,
    finalUrl,
    dispatchStarted: false,
    dispatch: { planned: 0, started: 0, verified: 0 },
    error: `${provider} read failed before the dispatch boundary`,
    readFailure: providerReadFailureProjection(error, options),
  };
}
