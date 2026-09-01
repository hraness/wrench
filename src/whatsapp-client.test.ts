import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256 } from "./canonical-json";
import { requireWhatsAppMessageLikeMeReceiptRequestBinding } from "./whatsapp-client-binding";
import { parseWhatsAppMessageLikeMeExportReceipt } from "./whatsapp-client";

function receipt() {
  const projection = {
    schemaVersion: 1,
    format: "wrench.whatsapp-message-like-me-export-receipt",
    runId: "12345678-1234-4123-8123-123456789abc",
    operation: "whatsapp.export-message-like-me",
    status: "succeeded",
    transport: "linked-device-local-store",
    startedAt: "2026-08-28T12:00:00.000Z",
    finishedAt: "2026-08-28T12:01:00.000Z",
    auth: {
      id: "whatsapp-main",
      provider: "whatsapp",
      identitySha256: "a".repeat(64),
    },
    source: { id: "wacli-local", version: "1.0.0" },
    provider: { id: "whatsapp", version: "0.15.0" },
    completeness: {
      kind: "bounded-local",
      reason: "local-store-coverage-unknown",
      observedFrom: "2026-08-01T00:00:00.000Z",
      observedThrough: "2026-08-28T12:00:00.000Z",
    },
    warnings: ["remote-history-incomplete"],
    counts: { account: 1, participant: 2, conversation: 1, message: 5, reaction: 1, tombstone: 0 },
    output: {
      schemaVersion: 2,
      format: "message-like-me.local-message-bundle",
      directory: "/private/tmp/message-like-me",
      manifestSha256: "b".repeat(64),
    },
    privacy: {
      classification: "private-local",
      attachments: "metadata-only",
      credentials: "excluded",
      sourcePaths: "excluded",
      mediaBytes: "excluded",
      cloudSync: "none",
    },
  } as const;
  return {
    ...projection,
    integrity: {
      algorithm: "sha256",
      receiptSha256: sha256(canonicalJson(projection)),
    },
  } as const;
}

describe("public WhatsApp export receipt parser", () => {
  test("accepts the exact local-only receipt and rejects tampering or extra private fields", () => {
    expect(parseWhatsAppMessageLikeMeExportReceipt(receipt())).toEqual(receipt());
    expect(() => parseWhatsAppMessageLikeMeExportReceipt({
      ...receipt(),
      output: { ...receipt().output, manifestSha256: "c".repeat(64) },
    })).toThrow("digest");
    expect(() => parseWhatsAppMessageLikeMeExportReceipt({
      ...receipt(),
      deviceStore: "/private/credentials",
    })).toThrow("unsupported or missing");
    expect(() => parseWhatsAppMessageLikeMeExportReceipt({
      ...receipt(),
      privacy: { ...receipt().privacy, cloudSync: "enabled" },
    })).toThrow("privacy");
    const { sourcePaths: _sourcePaths, ...privacyWithoutSourcePaths } = receipt().privacy;
    expect(() => parseWhatsAppMessageLikeMeExportReceipt({
      ...receipt(),
      privacy: { ...privacyWithoutSourcePaths, paths: "excluded" },
    })).toThrow("unsupported or missing");
  });

  test("rejects hostile warning arrays without evaluating accessors", () => {
    let accessorEvaluated = false;
    const accessorWarnings: unknown[] = [];
    Object.defineProperty(accessorWarnings, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorEvaluated = true;
        throw new Error("warning accessor evaluated");
      },
    });
    expect(() => parseWhatsAppMessageLikeMeExportReceipt({
      ...receipt(),
      warnings: accessorWarnings,
    })).toThrow("dense enumerable data elements");
    expect(accessorEvaluated).toBe(false);

    const sparseWarnings = new Array<unknown>(1);
    expect(() => parseWhatsAppMessageLikeMeExportReceipt({
      ...receipt(),
      warnings: sparseWarnings,
    })).toThrow("dense array");

    const namedWarnings = ["remote-history-incomplete"] as unknown[] & { note?: string };
    namedWarnings.note = "unreviewed";
    expect(() => parseWhatsAppMessageLikeMeExportReceipt({
      ...receipt(),
      warnings: namedWarnings,
    })).toThrow("dense array");
  });

  test("binds a valid receipt to the exact requested auth and output", () => {
    const parsed = parseWhatsAppMessageLikeMeExportReceipt(receipt());
    expect(requireWhatsAppMessageLikeMeReceiptRequestBinding(parsed, {
      authId: "whatsapp-main",
      output: "/private/tmp/message-like-me",
    })).toBe(parsed);
    expect(() => requireWhatsAppMessageLikeMeReceiptRequestBinding(parsed, {
      authId: "whatsapp-other",
      output: "/private/tmp/message-like-me",
    })).toThrow("auth identity does not match");
    expect(() => requireWhatsAppMessageLikeMeReceiptRequestBinding(parsed, {
      authId: "whatsapp-main",
      output: "/private/tmp/message-like-me-other",
    })).toThrow("output directory does not match");
  });
});
