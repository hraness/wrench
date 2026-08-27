/** Self-contained DTO types for the side-effect-free public Beeper client. */

export type BeeperContactInteractionAccount = Readonly<{
  accountId: string;
  accountProviderId: string;
  network: string;
  selfParticipantId: string;
  selfParticipantProviderId: string;
  observedAt: string;
}>;

export type BeeperContactInteraction = Readonly<{
  accountId: string;
  accountProviderId: string;
  contactId: string;
  contactProviderId: string;
  network: string;
  sentCount: number;
  receivedCount: number;
  interactionCount: number;
  conversationCount: number;
  firstInteractionAt: string;
  lastInteractionAt: string;
  reciprocal: boolean;
  completeness: "lower-bound";
  provenance: Readonly<{
    sourceId: "beeper-local";
    sourceVersion: "1.1.0";
    providerId: "beeper";
    providerVersion: string;
    observedAt: string;
  }>;
}>;

export type BeeperContactInteractionSummary = Readonly<{
  schemaVersion: 1;
  format: "wrench.contact-interaction-summary";
  transform: Readonly<{
    id: "beeper-direct-contact-interactions";
    version: 1;
    sourceVersion: "1.1.0";
  }>;
  source: Readonly<{ id: "beeper-local"; version: "1.1.0" }>;
  provider: Readonly<{ id: "beeper"; version: string }>;
  observedAt: string | null;
  scope: Readonly<{
    conversations: "complete-direct-only";
    messages: "current-direction-known-only";
  }>;
  completeness: Readonly<{
    kind: "lower-bound";
    sourceKind: "bounded-local" | "truncated" | "unknown";
    reason: string | null;
    observedFrom: string | null;
    observedThrough: string | null;
  }>;
  warnings: readonly string[];
  privacy: Readonly<{
    messageBodies: "excluded";
    attachments: "excluded";
    reactions: "excluded";
    media: "excluded";
    groupMessages: "excluded";
    localPaths: "excluded";
    credentials: "excluded";
  }>;
  counts: Readonly<{
    accounts: number;
    directRelationships: number;
    directConversations: number;
    interactions: number;
    sent: number;
    received: number;
  }>;
  accounts: readonly BeeperContactInteractionAccount[];
  interactions: readonly BeeperContactInteraction[];
  integrity: Readonly<{
    algorithm: "sha256";
    summarySha256: string;
  }>;
}>;

export type BeeperContactInteractionExportBounds = Readonly<{
  limitChats: number | null;
  limitMessages: number | null;
  maxParticipants: number | null;
}>;

export type BeeperContactInteractionExportReceipt = Readonly<{
  schemaVersion: 1;
  format: "wrench.beeper-contact-interaction-export-receipt";
  runId: string;
  operation: "beeper.export-contact-interactions";
  status: "succeeded";
  transport: "linked-device";
  implementation: Readonly<{
    producer: Readonly<{
      package: "@hraness/wrench";
      version: "0.14.0";
    }>;
    officialCli: Readonly<{
      implementation: "github.com/beeper/cli";
      version: "0.6.2";
      commit: "a416af06023449a87312dc11e54643fd9dc94b8c";
      platform: "darwin-arm64";
      binarySha256: "48aa895449129c793a212ea19f69a534adc34a8adc4037ca1d7da9e648716425";
    }>;
  }>;
  startedAt: string;
  finishedAt: string;
  auth: Readonly<{
    id: string;
    kind: "linked-device-store";
    provider: "beeper";
    identitySha256: string;
  }>;
  bounds: BeeperContactInteractionExportBounds;
  source: BeeperContactInteractionSummary["source"];
  provider: BeeperContactInteractionSummary["provider"];
  transform: BeeperContactInteractionSummary["transform"];
  completeness: BeeperContactInteractionSummary["completeness"];
  counts: BeeperContactInteractionSummary["counts"];
  output: Readonly<{
    schemaVersion: 1;
    format: "wrench.contact-interaction-summary";
    summarySha256: string;
  }>;
  privacy: Readonly<{
    messageBodies: "excluded";
    attachments: "excluded";
    reactions: "excluded";
    media: "excluded";
    localPaths: "excluded";
    credentials: "excluded";
  }>;
  integrity: Readonly<{
    algorithm: "sha256";
    receiptSha256: string;
  }>;
}>;

export type BeeperContactInteractionExportResult = Readonly<{
  receipt: BeeperContactInteractionExportReceipt;
  output: BeeperContactInteractionSummary;
}>;

export type BeeperContactInteractionClientRequest = Readonly<{
  authId: string;
  limitChats?: number;
  limitMessages?: number;
  maxParticipants?: number;
}>;

export type BeeperContactInteractionClientOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
}>;

export declare function exportBeeperContactInteractionsSync(
  request: BeeperContactInteractionClientRequest,
  options?: BeeperContactInteractionClientOptions,
): BeeperContactInteractionExportResult;

export declare function parseBeeperContactInteractionExportResult(
  value: unknown,
): BeeperContactInteractionExportResult;

export declare function parseBeeperContactInteractionSummary(
  value: unknown,
): BeeperContactInteractionSummary;
