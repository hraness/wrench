import { describe, expect, test } from "bun:test";

import { OperationDeadlineError } from "../operation-deadline";
import {
  ProviderReadResponseRejectedError,
  ProviderReadTransportError,
  providerReadFailureProjection,
} from "./read-failure";

describe("provider read failure projection", () => {
  test.each([
    ["target", 404, "target-unavailable", "do-not-retry"],
    ["bootstrap", 404, "contract-drift", "do-not-retry"],
    ["identity", 404, "contract-drift", "do-not-retry"],
    ["target", 429, "provider-throttled", "retry-once-after-60s"],
    ["target", 408, "provider-temporary", "retry-once-after-60s"],
    ["supplemental", 503, "provider-temporary", "retry-once-after-60s"],
  ] as const)("maps %s HTTP %i without retaining provider text", (stage, status, category, retryDisposition) => {
    const error = new ProviderReadResponseRejectedError(status);
    const projected = providerReadFailureProjection(error, {
      stage,
      authenticated: true,
      targetStatusUnavailable: true,
    });
    expect(projected.category).toBe(category);
    expect(projected.retryDisposition).toBe(retryDisposition);
    expect(JSON.stringify(projected)).not.toContain(error.message);
  });

  test("distinguishes authenticated repair and public drift", () => {
    const error = new ProviderReadResponseRejectedError(401);
    expect(providerReadFailureProjection(error, {
      stage: "identity",
      authenticated: true,
    }).category).toBe("auth-repair-required");
    expect(providerReadFailureProjection(error, {
      stage: "target",
      authenticated: false,
    }).category).toBe("contract-drift");
  });

  test("does not infer target absence from an unreviewed target-stage 404", () => {
    expect(providerReadFailureProjection(
      new ProviderReadResponseRejectedError(404),
      { stage: "target", authenticated: true },
    ).category).toBe("contract-drift");
  });

  test("maps only timed-out deadlines as retryable timeout", () => {
    expect(providerReadFailureProjection(
      new OperationDeadlineError("read", "timed-out"),
      { stage: "target", authenticated: false },
    ).category).toBe("operation-timeout");
    expect(providerReadFailureProjection(
      new OperationDeadlineError("read", "cancelled"),
      { stage: "target", authenticated: false },
    ).category).toBe("contract-drift");

    for (const wrapped of [
      new ProviderReadTransportError(
        new OperationDeadlineError("read", "timed-out"),
      ),
      new Error(
        "authenticated web API request failed before a reviewed response was received",
        { cause: new OperationDeadlineError("read", "timed-out") },
      ),
    ]) {
      expect(providerReadFailureProjection(
        wrapped,
        { stage: "target", authenticated: true },
      )).toEqual({
        category: "operation-timeout",
        retryDisposition: "retry-once-after-60s",
      });
    }
    expect(providerReadFailureProjection(
      new ProviderReadTransportError(
        new OperationDeadlineError("read", "cancelled"),
      ),
      { stage: "target", authenticated: true },
    )).toEqual({
      category: "contract-drift",
      retryDisposition: "do-not-retry",
    });
  });

  test("retries only a transport-bound body-stream failure, not a parser TypeError", () => {
    const streamFailure = new Error(
      "authenticated web response body stream failed before completion",
      { cause: new TypeError("private stream sentinel") },
    );
    expect(providerReadFailureProjection(
      streamFailure,
      { stage: "target", authenticated: true },
    )).toEqual({
      category: "provider-temporary",
      retryDisposition: "retry-once-after-60s",
    });
    expect(providerReadFailureProjection(
      new TypeError("private parser sentinel"),
      { stage: "target", authenticated: true },
    )).toEqual({
      category: "contract-drift",
      retryDisposition: "do-not-retry",
    });
  });
});
