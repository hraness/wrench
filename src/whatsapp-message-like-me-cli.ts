import { randomUUID } from "node:crypto";

import type { WrenchAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  exportWhatsAppMessageLikeMeBundle,
  type WhatsAppMessageLikeMeBundleProgress,
  type WhatsAppMessageLikeMeExportResult,
} from "./whatsapp-message-like-me-export";
import {
  createWhatsAppMessageLikeMeSource,
  type WhatsAppMessageLikeMeProgress,
} from "./whatsapp-message-like-me-source";
import {
  WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
  WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
} from "./whatsapp-message-bundle-v2";
import {
  acquireBeeperMessageLikeMeExportAdmission,
  recoverBeeperMessageLikeMeDirectoryLeases,
  releaseBeeperMessageLikeMeExportAdmission,
} from "./beeper-message-like-me-recovery";

export type WhatsAppMessageLikeMeCliProgress =
  | WhatsAppMessageLikeMeProgress
  | WhatsAppMessageLikeMeBundleProgress
  | Readonly<{ phase: "recovery-started" }>
  | Readonly<{
      phase: "recovery-completed";
      recovered: number;
      published: number;
    }>;

export type WhatsAppMessageLikeMeCliRequest = Readonly<{
  auth: WrenchAuth;
  outputRoot: string;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  onProgress?: (progress: WhatsAppMessageLikeMeCliProgress) => void;
}>;

export type WhatsAppMessageLikeMeExportReceipt = Readonly<{
  schemaVersion: 1;
  format: "wrench.whatsapp-message-like-me-export-receipt";
  runId: string;
  operation: "whatsapp.export-message-like-me";
  status: "succeeded";
  transport: "linked-device-local-store";
  startedAt: string;
  finishedAt: string;
  auth: Readonly<{
    id: string;
    provider: "whatsapp";
    identitySha256: string;
  }>;
  source: typeof WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE;
  provider: typeof WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER;
  completeness: WhatsAppMessageLikeMeExportResult["manifest"]["completeness"];
  warnings: readonly string[];
  counts: WhatsAppMessageLikeMeExportResult["manifest"]["counts"];
  output: Readonly<{
    schemaVersion: 2;
    format: "message-like-me.local-message-bundle";
    directory: string;
    manifestSha256: string;
  }>;
  privacy: Readonly<{
    classification: "private-local";
    attachments: "metadata-only";
    credentials: "excluded";
    paths: "excluded";
    mediaBytes: "excluded";
    cloudSync: "none";
  }>;
  integrity: Readonly<{ algorithm: "sha256"; receiptSha256: string }>;
}>;

export type WhatsAppMessageLikeMeCliResult = Readonly<{
  receipt: WhatsAppMessageLikeMeExportReceipt;
  bundle: WhatsAppMessageLikeMeExportResult;
}>;

function fail(message: string): never {
  throw new Error(`WhatsApp Message Like Me CLI: ${message}`);
}

export async function exportWhatsAppMessageLikeMeFromAuth(
  request: WhatsAppMessageLikeMeCliRequest,
): Promise<WhatsAppMessageLikeMeCliResult> {
  if (
    request.auth.kind !== "linked-device-store"
    || request.auth.provider !== "whatsapp"
    || request.auth.subject === undefined
  ) return fail("a bound WhatsApp linked-device-store auth locator is required");
  const environment = request.environment ?? process.env;
  request.onProgress?.(Object.freeze({ phase: "recovery-started" }));
  const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
  let bundle: WhatsAppMessageLikeMeExportResult;
  const startedAt = new Date().toISOString();
  try {
    const recovery = await recoverBeeperMessageLikeMeDirectoryLeases({ environment });
    if (recovery.active > 0 || recovery.indeterminate > 0) {
      return fail("another private message export is active or prior recovery is indeterminate");
    }
    request.onProgress?.(Object.freeze({
      phase: "recovery-completed",
      recovered: recovery.recovered,
      published: recovery.published,
    }));
    bundle = await exportWhatsAppMessageLikeMeBundle({
      outputRoot: request.outputRoot,
      source: createWhatsAppMessageLikeMeSource({
        auth: request.auth,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      recoveryEnvironment: environment,
    });
  } finally {
    releaseBeeperMessageLikeMeExportAdmission(admission);
  }
  const finishedAt = new Date().toISOString();
  const projection = Object.freeze({
    schemaVersion: 1 as const,
    format: "wrench.whatsapp-message-like-me-export-receipt" as const,
    runId: randomUUID(),
    operation: "whatsapp.export-message-like-me" as const,
    status: "succeeded" as const,
    transport: "linked-device-local-store" as const,
    startedAt,
    finishedAt,
    auth: Object.freeze({
      id: request.auth.id,
      provider: "whatsapp" as const,
      identitySha256: sha256(canonicalJson({
        id: request.auth.id,
        provider: request.auth.provider,
        subject: request.auth.subject,
      })),
    }),
    source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
    provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
    completeness: bundle.manifest.completeness,
    warnings: bundle.manifest.warnings,
    counts: bundle.manifest.counts,
    output: Object.freeze({
      schemaVersion: 2 as const,
      format: "message-like-me.local-message-bundle" as const,
      directory: bundle.outputRoot,
      manifestSha256: bundle.manifestSha256,
    }),
    privacy: Object.freeze({
      classification: "private-local" as const,
      attachments: "metadata-only" as const,
      credentials: "excluded" as const,
      paths: "excluded" as const,
      mediaBytes: "excluded" as const,
      cloudSync: "none" as const,
    }),
  });
  const receipt: WhatsAppMessageLikeMeExportReceipt = Object.freeze({
    ...projection,
    integrity: Object.freeze({
      algorithm: "sha256",
      receiptSha256: sha256(canonicalJson(projection)),
    }),
  });
  return Object.freeze({ receipt, bundle });
}

export function encodeWhatsAppMessageLikeMeCliResult(
  value: WhatsAppMessageLikeMeCliResult,
): string {
  return `${canonicalJson(value.receipt)}\n`;
}
