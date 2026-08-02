import { describe, expect, test } from "bun:test";

import {
  boundedOmniText,
  OMNI_MAX_REASON_BYTES,
  OMNI_MAX_RESPONSE_BYTES,
} from "./omni-limits";

describe("omni shared bounds", () => {
  test("keeps the suffix inside a UTF-8 byte bound without splitting code points", () => {
    const bounded = boundedOmniText(
      `${"🛠️".repeat(4_096)}provider drift`,
      OMNI_MAX_REASON_BYTES,
    );
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(
      OMNI_MAX_REASON_BYTES,
    );
    expect(bounded.endsWith("…")).toBeTrue();
    expect(bounded).not.toContain("�");
  });

  test("preserves already bounded text and one shared response capacity", () => {
    expect(boundedOmniText("exact provider error", 64))
      .toBe("exact provider error");
    expect(OMNI_MAX_RESPONSE_BYTES).toBe(20 * 1024 * 1024);
  });
});
