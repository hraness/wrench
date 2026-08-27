import { randomUUID } from "node:crypto";

import type { WrenchAuth } from "./auth";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  createBeeperContactInteractionExportResult,
  encodeBeeperContactInteractionExportResult,
  summarizeBeeperContactInteractions,
  type BeeperContactInteractionExportResult,
  type BeeperContactInteractionProgress,
  type BeeperContactInteractionSummary,
} from "./beeper-contact-interactions";

export { encodeBeeperContactInteractionExportResult };
import {
  acquireBeeperMessageLikeMeExportAdmission,
  recoverBeeperMessageLikeMeDirectoryLeases,
  releaseBeeperMessageLikeMeExportAdmission,
} from "./beeper-message-like-me-recovery";
import {
  createBeeperMessageLikeMeSource,
  type BeeperMessageLikeMeProgress,
  type BeeperMessageLikeMeSourceCoordinate,
  type BeeperMessageLikeMeSourceLimits,
} from "./beeper-message-like-me-source";

const CLEANUP_HEARTBEAT_MS = 30_000;

export type BeeperContactInteractionCliProgress =
  | BeeperMessageLikeMeProgress
  | BeeperContactInteractionProgress;

export type BeeperContactInteractionCliRequest = Readonly<{
  auth: WrenchAuth;
  limits?: BeeperMessageLikeMeSourceLimits;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  onProgress?: (progress: BeeperContactInteractionCliProgress) => void;
}>;

/** Preserve the exact platform identity published by the schema-1 receipt. */
export function assertBeeperContactInteractionExportRuntime(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): void {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(
      "Beeper contact interaction summary: schema-1 export requires the pinned darwin/arm64 Beeper CLI artifact",
    );
  }
}

async function disposeSource(
  dispose: (() => Promise<void>) | undefined,
  onProgress: BeeperContactInteractionCliRequest["onProgress"],
): Promise<void> {
  if (dispose === undefined) return;
  const startedAt = Date.now();
  const report = (): void => onProgress?.(Object.freeze({
    phase: "private-cleanup",
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
  }));
  report();
  const heartbeat = onProgress === undefined
    ? undefined
    : setInterval(report, CLEANUP_HEARTBEAT_MS);
  try {
    await dispose();
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }
}

/**
 * Run the admitted sequential Beeper history source and return only its
 * content-free direct-contact interaction summary. Raw private shards are
 * operation-owned and removed before this function resolves.
 */
export async function exportBeeperContactInteractionsFromAuth(
  request: BeeperContactInteractionCliRequest,
): Promise<BeeperContactInteractionExportResult> {
  assertBeeperContactInteractionExportRuntime();
  const startedAt = new Date().toISOString();
  try {
    const environment = request.environment ?? process.env;
    request.onProgress?.(Object.freeze({ phase: "recovery-started" }));
    const admission = acquireBeeperMessageLikeMeExportAdmission({ environment });
    try {
      const recovery = await recoverBeeperMessageLikeMeDirectoryLeases({
        environment,
      });
      if (recovery.active > 0 || recovery.indeterminate > 0) {
        throw new Error(
          "Beeper contact interaction summary: another export is active or prior private export recovery is indeterminate",
        );
      }
      request.onProgress?.(Object.freeze({
        phase: "recovery-completed",
        recovered: recovery.recovered,
        published: recovery.published,
      }));
      const coordinates = new WeakMap<object, BeeperMessageLikeMeSourceCoordinate>();
      const source = createBeeperMessageLikeMeSource({
        auth: request.auth,
        ...(request.limits === undefined ? {} : { limits: request.limits }),
        ...(request.environment === undefined
          ? {}
          : { environment: request.environment }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined
          ? {}
          : { onProgress: request.onProgress }),
        onRecordCoordinate: (record, coordinate) => {
          coordinates.set(record, coordinate);
        },
      });
      let summary: BeeperContactInteractionSummary | undefined;
      let operationError: unknown;
      try {
        summary = await summarizeBeeperContactInteractions({
          source,
          coordinateForRecord: (record) => (
            typeof record === "object" && record !== null
              ? coordinates.get(record)
              : undefined
          ),
          ...(request.onProgress === undefined
            ? {}
            : { onProgress: request.onProgress }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error) {
        operationError = error;
      }
      try {
        await disposeSource(
          source.dispose === undefined
            ? undefined
            : () => source.dispose!(false),
          request.onProgress,
        );
      } catch (cleanupError) {
        if (operationError !== undefined) {
          throw new AggregateError(
            [operationError, cleanupError],
            "Beeper contact interaction summary and private cleanup both failed",
          );
        }
        throw cleanupError;
      }
      if (operationError !== undefined) throw operationError;
      if (summary === undefined) {
        throw new Error("Beeper contact interaction summary: result disappeared");
      }
      return createBeeperContactInteractionExportResult({
        runId: randomUUID(),
        startedAt,
        finishedAt: new Date().toISOString(),
        authId: request.auth.id,
        authIdentitySha256: sha256(canonicalJson(request.auth)),
        bounds: Object.freeze({
          limitChats: request.limits?.limitChats ?? null,
          limitMessages: request.limits?.limitMessages ?? null,
          maxParticipants: request.limits?.maxParticipants ?? null,
        }),
        output: summary,
      });
    } finally {
      releaseBeeperMessageLikeMeExportAdmission(admission);
    }
  } catch (error) {
    if (
      error instanceof Error
      && /^(?:Beeper |Message Like Me |pinned Beeper CLI )/u.test(error.message)
    ) throw error;
    throw new Error(
      "Beeper contact interaction summary: private local operation failed",
    );
  }
}
