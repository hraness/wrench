import { describe, expect, test } from "bun:test";

import {
  parseReadFailureProjection,
  readFailureProjection,
} from "./web-session-execution";

describe("R1 read failure projection", () => {
  test("derives the only valid retry disposition for every stable category", () => {
    const cases = [
      ["target-unavailable", "do-not-retry"],
      ["auth-repair-required", "repair-auth"],
      ["account-mismatch", "do-not-retry"],
      ["provider-throttled", "retry-once-after-60s"],
      ["provider-temporary", "retry-once-after-60s"],
      ["operation-timeout", "retry-once-after-60s"],
      ["contract-drift", "do-not-retry"],
      ["cleanup-required", "do-not-retry"],
    ] as const;
    for (const [category, retryDisposition] of cases) {
      const projected = readFailureProjection(category);
      expect(projected.category).toBe(category);
      expect(projected.retryDisposition).toBe(retryDisposition);
      expect(Object.keys(projected).sort()).toEqual([
        "category",
        "retryDisposition",
      ]);
      expect(parseReadFailureProjection(projected)).toEqual(projected);
    }
  });

  test("rejects unknown, inconsistent, accessor, proxy, and extra-field values", () => {
    let accessorReads = 0;
    const accessor = Object.defineProperty(
      { retryDisposition: "do-not-retry" },
      "category",
      {
        enumerable: true,
        get: () => {
          accessorReads += 1;
          return "contract-drift";
        },
      },
    );
    const proxied = new Proxy({
      category: "contract-drift",
      retryDisposition: "do-not-retry",
    }, {
      ownKeys: () => {
        throw new Error("proxy trap must not execute");
      },
    });
    for (const candidate of [
      null,
      [],
      {
        category: "provider-throttled",
        retryDisposition: "do-not-retry",
      },
      {
        category: "unknown",
        retryDisposition: "do-not-retry",
      },
      {
        category: "contract-drift",
        retryDisposition: "do-not-retry",
        detail: "private provider detail",
      },
      accessor,
      proxied,
    ]) {
      expect(() => parseReadFailureProjection(candidate)).toThrow();
    }
    expect(accessorReads).toBe(0);
  });
});
