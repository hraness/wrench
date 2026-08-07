import { describe, expect, test } from "bun:test";

import {
  parseContactDirectionStats,
  projectContactDirectionStats,
  type ContactDirectionStats,
} from "./contact-projection";

function completeStats(): ContactDirectionStats {
  return {
    count: 2,
    complete: true,
    lowerBound: false,
    truncated: false,
    lastAt: "2026-08-05T14:15:16.123Z",
    lastAtComplete: true,
    lastAtBasis: "bounded-matched-message-internal-date",
    incompleteReasons: [],
  };
}

function lowerBoundStats(): ContactDirectionStats {
  return {
    count: 3,
    complete: false,
    lowerBound: true,
    truncated: true,
    lastAt: "2026-08-04T09:08:07Z",
    lastAtComplete: false,
    lastAtBasis: "bounded-local-message-timestamp",
    incompleteReasons: ["scan-limit-reached"],
  };
}

function unavailableStats(): ContactDirectionStats {
  return {
    count: null,
    complete: false,
    lowerBound: false,
    truncated: false,
    lastAt: null,
    lastAtComplete: false,
    lastAtBasis: "unavailable",
    incompleteReasons: ["message-statistics-unavailable"],
  };
}

describe("contact direction statistics projection", () => {
  test("constructs and freezes complete statistics and the stable flat projection", () => {
    const sent = parseContactDirectionStats(completeStats());
    const received = parseContactDirectionStats({
      ...completeStats(),
      count: 0,
      lastAt: null,
      lastAtBasis: "unavailable",
    });

    expect(sent).toEqual(completeStats());
    expect(Object.isFrozen(sent)).toBeTrue();
    expect(Object.isFrozen(sent.incompleteReasons)).toBeTrue();
    expect(projectContactDirectionStats(sent, received)).toEqual({
      sentCount: 2,
      sentCountComplete: true,
      sentCountLowerBound: false,
      sentCountTruncated: false,
      receivedCount: 0,
      receivedCountComplete: true,
      receivedCountLowerBound: false,
      receivedCountTruncated: false,
      lastSentAt: "2026-08-05T14:15:16.123Z",
      lastSentAtComplete: true,
      lastSentAtBasis: "bounded-matched-message-internal-date",
      sentStatsIncompleteReasons: [],
      lastReceivedAt: null,
      lastReceivedAtComplete: true,
      lastReceivedAtBasis: "unavailable",
      receivedStatsIncompleteReasons: [],
    });
  });

  test("preserves lower-bound and truncated evidence without overstating completeness", () => {
    const stats = parseContactDirectionStats(lowerBoundStats());

    expect(stats).toEqual(lowerBoundStats());
    expect(projectContactDirectionStats(stats, stats)).toMatchObject({
      sentCount: 3,
      sentCountComplete: false,
      sentCountLowerBound: true,
      sentCountTruncated: true,
      lastSentAt: "2026-08-04T09:08:07Z",
      lastSentAtComplete: false,
      sentStatsIncompleteReasons: ["scan-limit-reached"],
      receivedCount: 3,
      receivedCountComplete: false,
      receivedCountLowerBound: true,
      receivedCountTruncated: true,
      receivedStatsIncompleteReasons: ["scan-limit-reached"],
    });
  });

  test("represents unavailable counts with null rather than a fabricated zero", () => {
    const stats = parseContactDirectionStats(unavailableStats());

    expect(stats).toEqual(unavailableStats());
    expect(projectContactDirectionStats(stats, stats)).toMatchObject({
      sentCount: null,
      sentCountComplete: false,
      sentCountLowerBound: false,
      sentCountTruncated: false,
      lastSentAt: null,
      lastSentAtComplete: false,
      lastSentAtBasis: "unavailable",
      sentStatsIncompleteReasons: ["message-statistics-unavailable"],
      receivedCount: null,
      receivedCountComplete: false,
      receivedCountLowerBound: false,
      receivedCountTruncated: false,
      lastReceivedAt: null,
      lastReceivedAtComplete: false,
      lastReceivedAtBasis: "unavailable",
      receivedStatsIncompleteReasons: ["message-statistics-unavailable"],
    });
  });

  test("accepts exactly the exhaustive count completeness states", () => {
    for (const count of [null, 0] as const) {
      for (const complete of [false, true]) {
        for (const lowerBound of [false, true]) {
          for (const truncated of [false, true]) {
            const candidate = {
              count,
              complete,
              lowerBound,
              truncated,
              lastAt: null,
              lastAtComplete: false,
              lastAtBasis: "unavailable",
              incompleteReasons: ["bounded-evidence-incomplete"],
            };
            const valid = count === null
              ? !complete && !lowerBound && !truncated
              : complete !== lowerBound && (!truncated || lowerBound);
            if (valid) expect(() => parseContactDirectionStats(candidate)).not.toThrow();
            else expect(() => parseContactDirectionStats(candidate)).toThrow();
          }
        }
      }
    }
  });

  test("accepts a complete missing lastAt only for an exactly complete zero count", () => {
    for (const count of [null, 0, 1] as const) {
      for (const complete of [false, true]) {
        for (const lastAtComplete of [false, true]) {
          const candidate = {
            count,
            complete,
            lowerBound: count === null ? false : !complete,
            truncated: false,
            lastAt: null,
            lastAtComplete,
            lastAtBasis: "unavailable",
            incompleteReasons: complete && lastAtComplete
              ? []
              : ["bounded-evidence-incomplete"],
          };
          const countStateValid = count === null ? !complete : true;
          const missingLastAtStateValid = !lastAtComplete || (count === 0 && complete);
          const valid = countStateValid && missingLastAtStateValid;

          if (valid) expect(() => parseContactDirectionStats(candidate)).not.toThrow();
          else expect(() => parseContactDirectionStats(candidate)).toThrow();
        }
      }
    }
  });

  test("requires incomplete reasons exactly unless both dimensions are complete", () => {
    const cases = [
      { complete: true, lastAtComplete: true, incompleteReasons: [], valid: true },
      {
        complete: true,
        lastAtComplete: true,
        incompleteReasons: ["contradictory-reason"],
        valid: false,
      },
      { complete: true, lastAtComplete: false, incompleteReasons: [], valid: false },
      {
        complete: true,
        lastAtComplete: false,
        incompleteReasons: ["message-timestamp-unavailable"],
        valid: true,
      },
      { complete: false, lastAtComplete: false, incompleteReasons: [], valid: false },
      {
        complete: false,
        lastAtComplete: false,
        incompleteReasons: ["scan-limit-reached"],
        valid: true,
      },
    ] as const;
    for (const scenario of cases) {
      const candidate = {
        ...completeStats(),
        complete: scenario.complete,
        lowerBound: !scenario.complete,
        lastAtComplete: scenario.lastAtComplete,
        incompleteReasons: scenario.incompleteReasons,
      };
      if (scenario.valid) expect(() => parseContactDirectionStats(candidate)).not.toThrow();
      else {
        expect(() => parseContactDirectionStats(candidate)).toThrow(
          "must have no incomplete reasons exactly when both count and lastAt are complete",
        );
      }
    }
  });

  test("accepts bounded RFC 3339 UTC instants and rejects non-UTC or impossible dates", () => {
    for (const lastAt of [
      "0000-01-01T00:00:00Z",
      "2024-02-29T23:59:60.123456789Z",
      "9999-12-31T23:59:59Z",
    ]) {
      expect(() => parseContactDirectionStats({
        ...completeStats(),
        lastAt,
      })).not.toThrow();
    }
    for (const lastAt of [
      "2023-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-08-05T24:00:00Z",
      "2026-08-05T14:15:61Z",
      "2026-08-05t14:15:16z",
      "2026-08-05T14:15:16+00:00",
      "2026-08-05T14:15:16.1234567890Z",
    ]) {
      expect(() => parseContactDirectionStats({
        ...completeStats(),
        lastAt,
      })).toThrow("must be null or an RFC 3339 UTC timestamp");
    }
  });

  test("rejects unreviewed shapes, executable properties, and malformed reasons", () => {
    const missingCount: Record<string, unknown> = { ...completeStats() };
    delete missingCount.count;
    expect(() => parseContactDirectionStats(missingCount)).toThrow(".count is required");
    expect(() => parseContactDirectionStats({
      ...completeStats(),
      estimate: 2,
    })).toThrow("contains unreviewed property estimate");

    const accessor = { ...completeStats() };
    Object.defineProperty(accessor, "count", {
      enumerable: true,
      get: () => 2,
    });
    expect(() => parseContactDirectionStats(accessor)).toThrow(
      ".count must be an enumerable data property",
    );
    expect(() => parseContactDirectionStats(new Proxy(completeStats(), {}))).toThrow(
      "must be a plain object",
    );
    expect(() => parseContactDirectionStats(Object.assign(
      completeStats(),
      { [Symbol("unreviewed")]: true },
    ))).toThrow("must not contain symbol properties");

    const sparseReasons = new Array<string>(1);
    expect(() => parseContactDirectionStats({
      ...lowerBoundStats(),
      incompleteReasons: sparseReasons,
    })).toThrow("must not be sparse");
    for (const incompleteReasons of [
      ["scan-limit-reached", "scan-limit-reached"],
      ["Scan limit reached"],
      ["scan_limit_reached"],
    ]) {
      expect(() => parseContactDirectionStats({
        ...lowerBoundStats(),
        incompleteReasons,
      })).toThrow();
    }
  });

  test("the projection validates each direction independently", () => {
    expect(() => projectContactDirectionStats(completeStats(), {
      ...lowerBoundStats(),
      truncated: true,
      lowerBound: false,
    })).toThrow("received contact direction stats");
  });
});
