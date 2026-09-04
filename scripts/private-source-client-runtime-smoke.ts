export const packedPrivateSourceClientRuntimeProgram = String.raw`
  import assert from "node:assert/strict";
  import childProcess from "node:child_process";
  import { createHash } from "node:crypto";
  import { mock } from "bun:test";

  const canonicalJson = (value) => {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      return JSON.stringify(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
    }
    throw new Error("runtime-smoke canonical JSON received an unsupported value");
  };
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const output = "/private/tmp/wrench-packed-runtime-bound-output";
  const projection = {
    schemaVersion: 1,
    format: "wrench.whatsapp-message-like-me-export-receipt",
    runId: "12345678-1234-4123-8123-123456789abc",
    operation: "whatsapp.export-message-like-me",
    status: "succeeded",
    transport: "linked-device-local-store",
    startedAt: "2026-08-28T12:00:00.000Z",
    finishedAt: "2026-08-28T12:01:00.000Z",
    auth: { id: "whatsapp-main", provider: "whatsapp", identitySha256: "a".repeat(64) },
    source: { id: "wacli-local", version: "1.0.0" },
    provider: { id: "whatsapp", version: "0.15.0" },
    completeness: {
      kind: "bounded-local",
      reason: "local-store-coverage-unknown",
      observedFrom: "2026-08-01T00:00:00.000Z",
      observedThrough: "2026-08-28T12:00:00.000Z",
    },
    warnings: ["remote-history-incomplete", "reaction-state-unproven"],
    counts: { account: 1, participant: 2, conversation: 1, message: 5, reaction: 0, tombstone: 0 },
    output: {
      schemaVersion: 2,
      format: "message-like-me.local-message-bundle",
      directory: output,
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
  };
  const receipt = {
    ...projection,
    integrity: { algorithm: "sha256", receiptSha256: sha256(canonicalJson(projection)) },
  };
  let spawnCount = 0;
  const spawnSync = () => {
    spawnCount += 1;
    return { error: undefined, signal: null, status: 0, stderr: "", stdout: JSON.stringify(receipt) };
  };
  await mock.module("node:child_process", () => ({ ...childProcess, spawnSync }));
  await mock.module("child_process", () => ({ ...childProcess, spawnSync }));

  const whatsapp = await import("@hraness/wrench/whatsapp");
  assert.deepEqual(whatsapp.parseWhatsAppMessageLikeMeExportReceipt(receipt), receipt);
  const { sourcePaths: _sourcePaths, ...legacyPrivacy } = projection.privacy;
  const legacyProjection = { ...projection, privacy: { ...legacyPrivacy, paths: "excluded" } };
  const legacyReceipt = {
    ...legacyProjection,
    integrity: { algorithm: "sha256", receiptSha256: sha256(canonicalJson(legacyProjection)) },
  };
  assert.throws(
    () => whatsapp.parseWhatsAppMessageLikeMeExportReceipt(legacyReceipt),
    /unsupported or missing fields/u,
  );
  assert.throws(
    () => whatsapp.exportWhatsAppMessageLikeMeSync({
      authId: "whatsapp-main",
      output: output + "-different",
    }),
    /receipt output directory does not match the requested output/u,
  );
  assert.equal(spawnCount, 1);

  const applePhotos = await import("@hraness/wrench/apple-photos");
  assert.throws(
    () => applePhotos.exportApplePhotosContactEvidenceSync({}, {
      environment: { HOME: "/private/tmp/wrench-untrusted-packed-home" },
    }),
    /HOME cannot override Apple Photos source authority/u,
  );
  assert.equal(spawnCount, 1, "Apple Photos source-authority rejection must occur before spawn");
`;
