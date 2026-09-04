import { describe, expect, test } from "bun:test";

import {
  isWhatsAppExportAuthId,
  isWhatsAppExportOutputDirectory,
} from "./whatsapp-export-coordinate";

describe("WhatsApp export coordinates", () => {
  test("shares the exact auth and output grammar across the CLI and typed client", () => {
    const cases = [
      { kind: "auth", value: "a", valid: true },
      { kind: "auth", value: `a${"b".repeat(47)}`, valid: true },
      { kind: "auth", value: `a${"b".repeat(48)}`, valid: false },
      { kind: "auth", value: "WhatsApp-main", valid: false },
      { kind: "auth", value: "whatsapp_main", valid: false },
      { kind: "auth", value: "1whatsapp", valid: false },
      { kind: "auth", value: null, valid: false },
      { kind: "output", value: "/private/tmp/message-like-me", valid: true },
      { kind: "output", value: `/tmp/${"a".repeat(4_091)}`, valid: true },
      { kind: "output", value: `/tmp/${"a".repeat(4_092)}`, valid: false },
      { kind: "output", value: `/tmp/${"é".repeat(1_364)}`, valid: false },
      { kind: "output", value: "/", valid: false },
      { kind: "output", value: "/tmp/../tmp/export", valid: false },
      { kind: "output", value: "/tmp/export\0other", valid: false },
      { kind: "output", value: "/tmp/export\rother", valid: false },
      { kind: "output", value: "/tmp/export\nother", valid: false },
      { kind: "output", value: "relative/export", valid: false },
      { kind: "output", value: undefined, valid: false },
    ] as const;

    for (const scenario of cases) {
      const actual = scenario.kind === "auth"
        ? isWhatsAppExportAuthId(scenario.value)
        : isWhatsAppExportOutputDirectory(scenario.value);
      expect(actual, `${scenario.kind}: ${String(scenario.value)}`).toBe(scenario.valid);
    }
  });
});
