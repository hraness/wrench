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
    kind: "bounded-local";
    reason: "local-store-coverage-unknown";
    observedFrom: string | null;
    observedThrough: string | null;
  }>;
  warnings: readonly [
    "remote-history-incomplete",
    ...(
      | "reaction-state-unproven"
      | "self-chat-excluded"
      | "message-payload-purged"
      | "non-conversation-chats-excluded"
    )[],
  ];
  counts: Readonly<{
    account: 1;
    participant: number;
    conversation: number;
    message: number;
    reaction: 0;
    tombstone: 0;
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
    sourcePaths: "excluded";
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
