/** Side-effect-free DTO declarations for the direct WhatsApp local export client. */

export type WhatsAppMessageLikeMeClientRequest = Readonly<{
  authId: string;
  output: string;
}>;

export type WhatsAppMessageLikeMeClientOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
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
  source: Readonly<{ id: "wacli-local"; version: "1.0.0" }>;
  provider: Readonly<{ id: "whatsapp"; version: "0.15.0" }>;
  completeness: Readonly<{
    kind: "bounded-local" | "truncated" | "unknown";
    reason: string | null;
    observedFrom: string | null;
    observedThrough: string | null;
  }>;
  warnings: readonly string[];
  counts: Readonly<{
    account: number;
    participant: number;
    conversation: number;
    message: number;
    reaction: number;
    tombstone: number;
  }>;
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

export declare function exportWhatsAppMessageLikeMeSync(
  request: WhatsAppMessageLikeMeClientRequest,
  options?: WhatsAppMessageLikeMeClientOptions,
): WhatsAppMessageLikeMeExportReceipt;

export declare function parseWhatsAppMessageLikeMeExportReceipt(
  value: unknown,
): WhatsAppMessageLikeMeExportReceipt;
