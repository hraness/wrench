import { describe, expect, test } from "bun:test";

import {
  assertAsyncProperty,
  assertProperty,
  fc,
  propertyParameters,
  propertyReplayParameters,
} from "./test-support";

describe("property replay coordinates", () => {
  test("preserves the bounded fail-closed property defaults", () => {
    expect(propertyParameters).toMatchObject({
      numRuns: 200,
      interruptAfterTimeLimit: 10_000,
      markInterruptAsFailure: true,
    });
  });

  test("accepts one exact seed with an optional shrink path", () => {
    expect(propertyReplayParameters({
      WRENCH_PROPERTY_SEED: "-17",
    })).toEqual({ seed: -17 });
    expect(propertyReplayParameters({
      WRENCH_PROPERTY_SEED: "2147483647",
      WRENCH_PROPERTY_PATH: "3:0",
    })).toEqual({ seed: 2_147_483_647, path: "3:0" });
    expect(propertyReplayParameters({
      WRENCH_PROPERTY_SEED: "1",
      WRENCH_PROPERTY_PATH: "0:1:10000",
    })).toEqual({ seed: 1, path: "0:1:10000" });
  });

  test("fails closed on ambiguous, noncanonical, or unbounded input", () => {
    expect(() => propertyReplayParameters({
      WRENCH_PROPERTY_PATH: "1:0",
    })).toThrow("requires WRENCH_PROPERTY_SEED");
    for (const seed of ["-0", "01", "+1", "2147483648", "1.5", "seed"]) {
      expect(() => propertyReplayParameters({
        WRENCH_PROPERTY_SEED: seed,
      })).toThrow("canonical 32-bit integer");
    }
    for (const seed of [null, 1, true, {}]) {
      expect(() => propertyReplayParameters({
        WRENCH_PROPERTY_SEED: seed,
      })).toThrow("canonical 32-bit integer");
    }
    for (const path of [
      "",
      "1::2",
      "-1",
      "1/a",
      "01:0",
      "1:00",
      "10001",
      "9007199254740991",
      "9007199254740992",
      Array.from({ length: 11 }, () => "10000").join(":"),
      `1:${"2".repeat(513)}`,
    ]) {
      expect(() => propertyReplayParameters({
        WRENCH_PROPERTY_SEED: "1",
        WRENCH_PROPERTY_PATH: path,
      })).toThrow("bounded fast-check path");
    }
    for (const path of [null, 1, true, {}]) {
      expect(() => propertyReplayParameters({
        WRENCH_PROPERTY_SEED: "1",
        WRENCH_PROPERTY_PATH: path,
      })).toThrow("bounded fast-check path");
    }
  });

  test("rejects partial or crossed replay coordinates in synchronous overrides", () => {
    const property = fc.property(fc.constant(null), () => true);
    for (const overrides of [
      { seed: -17 },
      { path: "3:0" },
      { seed: -17, path: "3:0" },
    ]) {
      expect(() => assertProperty(property, overrides as never)).toThrow(
        "dedicated property replay coordinate",
      );
    }
  });

  test("rejects partial or crossed replay coordinates in asynchronous overrides", async () => {
    const property = fc.asyncProperty(fc.constant(null), async () => true);
    for (const overrides of [
      { seed: -17 },
      { path: "3:0" },
      { seed: -17, path: "3:0" },
    ]) {
      await expect(assertAsyncProperty(property, overrides as never)).rejects.toThrow(
        "dedicated property replay coordinate",
      );
    }
  });
});
