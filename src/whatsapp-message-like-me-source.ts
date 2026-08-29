import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WrenchAuth } from "./auth";
import {
  beginBeeperMessageLikeMeHelperLaunch,
  bindBeeperMessageLikeMeHelperOwner,
  markBeeperMessageLikeMeHelperCleanupUnsafe,
  settleBeeperMessageLikeMeHelper,
  type BeeperMessageLikeMeExportAdmission,
} from "./beeper-message-like-me-recovery";
import { canonicalJson, sha256 } from "./canonical-json";
import {
  canonicalWhatsAppAccountSubjectJid,
  canonicalWhatsAppParticipantJid,
  isCanonicalWhatsAppAccountSubject,
} from "./providers/whatsapp-account-identity";
import {
  containsWhatsAppContactProjectionCleanupUnverified,
  runWhatsAppMessageExportSessionHelperChild,
  validateWhatsAppStoreDirectory,
  type WhatsAppContactProjectionHelperInvocation,
  type WhatsAppContactProjectionHelperResult,
  type WhatsAppMessageExportSessionCanonicalFrame,
  type WhatsAppMessageExportSessionHelperResult,
} from "./providers/whatsapp-web-runtime";
import {
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDOUT_BYTES,
  WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
  parseWhatsAppMessageExportProjectionRequest,
  parseWhatsAppMessageExportProjectionResponse,
  type WhatsAppMessageExportProjectionGeneration,
  type WhatsAppMessageExportProjectionItem,
  type WhatsAppMessageExportProjectionRequest,
} from "./providers/whatsapp-message-export-projection-protocol";
import {
  WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK,
  WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
  WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
  WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
  WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS,
  type WhatsAppMessageBundleV2Attachment,
  type WhatsAppMessageBundleV2Completion,
  type WhatsAppMessageBundleV2Conversation,
  type WhatsAppMessageBundleV2Record,
} from "./whatsapp-message-bundle-v2";

const PAGE_LIMIT = 500;
const PAGE_TIMEOUT_MS = 5 * 60_000;
const EXPORT_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_STDERR_BYTES = 16 * 1024;

type WhatsAppAuth = Extract<WrenchAuth, { readonly kind: "linked-device-store" }>;

export type WhatsAppMessageLikeMeProgress =
  | Readonly<{ phase: "preparing" }>
  | Readonly<{ phase: "page-started"; page: number; messages: number }>
  | Readonly<{ phase: "page-completed"; page: number; messages: number }>
  | Readonly<{
      phase: "conversion-completed";
      messages: number;
      conversations: number;
      participants: number;
    }>;

export type WhatsAppMessageLikeMeSourceDependencies = Readonly<{
  helperPath?: string;
  configPath?: string;
  runHelper?: (
    invocation: WhatsAppContactProjectionHelperInvocation,
  ) => Promise<WhatsAppContactProjectionHelperResult>;
  /** Test-only persistent-session process seam. */
  runSessionHelper?: (
    invocation: WhatsAppContactProjectionHelperInvocation,
  ) => Promise<WhatsAppMessageExportSessionHelperResult>;
  /** Test-only total-operation deadline override. */
  totalTimeoutMs?: number;
  /** Test-only monotonic clock seam. */
  monotonicNow?: () => number;
  /** Test-only smaller v2 aggregate-record bound. */
  recordLimit?: number;
}>;

export type WhatsAppMessageLikeMeSourceRequest = Readonly<{
  auth: WrenchAuth;
  stateEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Internal durable admission held by the native CLI. */
  admission?: BeeperMessageLikeMeExportAdmission;
  signal?: AbortSignal;
  onProgress?: (progress: WhatsAppMessageLikeMeProgress) => void;
  dependencies?: WhatsAppMessageLikeMeSourceDependencies;
}>;

export type WhatsAppMessageLikeMeExportSource = Readonly<{
  descriptor: unknown;
  records: AsyncIterable<unknown>;
  completion: () => Promise<unknown>;
}>;

type ConversationFact = {
  readonly jid: string;
  readonly type: "direct" | "group";
  title: string | null;
  readonly participantJids: Set<string>;
  startedAt: string;
  lastMessageAt: string;
};

type ParticipantFact = {
  readonly jid: string;
  displayName: string | null;
  readonly isSelf: boolean;
};

function fail(message: string): never {
  throw new Error(`WhatsApp Message Like Me source: ${message}`);
}

function requireAuth(value: WrenchAuth): WhatsAppAuth & Readonly<{ subject: string }> {
  if (
    value.kind !== "linked-device-store"
    || value.provider !== "whatsapp"
    || value.subject === undefined
    || !isCanonicalWhatsAppAccountSubject(value.subject)
  ) return fail(
    "a bound WhatsApp linked-device-store auth locator is required; its account subject must be canonical, so re-pair a legacy noncanonical account under a new auth id",
  );
  return value as WhatsAppAuth & Readonly<{ subject: string }>;
}

function senderJid(
  item: WhatsAppMessageExportProjectionItem,
  accountJid: string,
  accountJidAliases: ReadonlySet<string>,
  directPeer: string | null,
): string | null {
  const explicit = item.senderJid === null
    ? null
    : canonicalWhatsAppParticipantJid(item.senderJid);
  if (item.chatKind === "dm") {
    if (directPeer === null) return fail("direct conversation peer is missing");
    if (item.fromMe) {
      if (explicit !== null && !accountJidAliases.has(explicit)) {
        return fail("outgoing direct sender does not match the bound account");
      }
      return accountJid;
    }
    if (explicit !== null && explicit !== directPeer) {
      return fail("incoming direct sender does not match the exact peer");
    }
    return explicit ?? directPeer;
  }
  if (item.fromMe) {
    if (explicit !== null && !accountJidAliases.has(explicit)) {
      return fail("outgoing group sender does not match the bound account");
    }
    return accountJid;
  }
  if (explicit !== null && accountJidAliases.has(explicit)) {
    return fail("incoming group sender cannot be the bound account");
  }
  return explicit;
}

function localId(kind: string, ...coordinates: readonly string[]): string {
  return `whatsapp:${kind}:${sha256(coordinates.join("\u0000"))}`;
}

function messageProviderId(item: Pick<WhatsAppMessageExportProjectionItem, "chatJid" | "messageId">): string {
  return `${item.chatJid}/${item.messageId}`;
}

function participantId(accountJid: string, participantJid: string): string {
  return localId("participant", accountJid, participantJid);
}

function userHandle(jid: string): string | null {
  const phone = /^([1-9][0-9]{4,14})@s\.whatsapp\.net$/u.exec(jid);
  return phone?.[1] === undefined ? null : `+${phone[1]}`;
}

function provenance(providerId: string, accountJid: string, observedAt: string, revision: string | null) {
  return Object.freeze({
    providerId,
    providerRevision: revision,
    observedAt,
    connectedAccountProviderId: accountJid,
  });
}

function attachment(item: WhatsAppMessageExportProjectionItem): readonly WhatsAppMessageBundleV2Attachment[] {
  if (
    item.mediaType === null
    && item.mimeType === null
    && item.fileName === null
    && item.fileLength === null
  ) return Object.freeze([]);
  const source = item.mediaType?.toLowerCase() ?? "";
  const kind: WhatsAppMessageBundleV2Attachment["kind"] =
    source === "audio" || source === "ptt"
      ? "audio"
      : source === "document"
        ? "document"
        : source === "image"
          ? "image"
          : source === "sticker"
            ? "sticker"
            : source === "video"
              ? "video"
              : "unknown";
  return Object.freeze([Object.freeze({
    kind,
    mimeType: item.mimeType,
    name: item.fileName,
    sizeBytes: item.fileLength,
  })]);
}

function body(item: WhatsAppMessageExportProjectionItem): string | null {
  if (item.revoked || item.deletedForMe || item.payloadPurgedAt !== null) return null;

  const candidates = [item.text, item.mediaCaption].filter(
    (candidate): candidate is string => candidate !== null && candidate.trim().length > 0,
  );
  const mediaType = item.mediaType?.toLowerCase();
  if (mediaType === "audio" || mediaType === "ptt") {
    const authoredCandidates = candidates.filter((candidate) => candidate !== "[Audio]");
    if (authoredCandidates.length > 0) return authoredCandidates[0] ?? null;
    if (candidates.length > 0) return null;
  }

  return candidates[0] ?? null;
}

function messageDeletion(item: WhatsAppMessageExportProjectionItem, observedAt: string) {
  if (!item.revoked && !item.deletedForMe) return null;
  return Object.freeze({
    state: item.revoked && item.deletedForMe
      ? "revoked-and-deleted-for-me" as const
      : item.revoked
        ? "revoked" as const
        : "deleted-for-me" as const,
    observedAt: item.deletedAt ?? observedAt,
    providerRevision: item.deletedAt,
  });
}

function fixedHelperFiles(
  dependencies: WhatsAppMessageLikeMeSourceDependencies | undefined,
): Readonly<{ helper: string; config: string }> {
  if ((dependencies?.helperPath === undefined) !== (dependencies?.configPath === undefined)) {
    return fail("test helper and config paths must be supplied together");
  }
  if (dependencies?.helperPath !== undefined && dependencies.configPath !== undefined) {
    return Object.freeze({ helper: dependencies.helperPath, config: dependencies.configPath });
  }
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  return Object.freeze({
    helper: resolve(sourceDirectory, "providers/whatsapp-interaction-projection-helper.ts"),
    config: resolve(sourceDirectory, "state-helper.bunfig.toml"),
  });
}

async function boundIdentities(store: string) {
  const [storeStats, sessionStats, messageStats] = await Promise.all([
    lstat(store, { bigint: true }),
    lstat(resolve(store, "session.db"), { bigint: true }),
    lstat(resolve(store, "wacli.db"), { bigint: true }),
  ]);
  return Object.freeze({
    store: Object.freeze({ dev: storeStats.dev.toString(), ino: storeStats.ino.toString() }),
    session: Object.freeze({ dev: sessionStats.dev.toString(), ino: sessionStats.ino.toString() }),
    message: Object.freeze({ dev: messageStats.dev.toString(), ino: messageStats.ino.toString() }),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) return fail("export was cancelled");
}

function remainingExportTimeout(
  startedAt: number,
  dependencies: WhatsAppMessageLikeMeSourceDependencies | undefined,
  pageBound: boolean,
): number {
  const now = dependencies?.monotonicNow ?? (() => performance.now());
  const timeout = dependencies?.totalTimeoutMs ?? EXPORT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1) {
    return fail("the total export timeout is invalid");
  }
  const elapsed = now() - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= timeout) {
    return fail("export exceeded its total deadline");
  }
  const remaining = Math.ceil(timeout - elapsed);
  return Math.max(1, pageBound ? Math.min(PAGE_TIMEOUT_MS, remaining) : remaining);
}

function earliest(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function latest(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

const SESSION_PN_JID_PATTERN = /^[1-9][0-9]{4,14}@s\.whatsapp\.net$/u;
const SESSION_LID_JID_PATTERN = /^[1-9][0-9]{4,19}@lid$/u;

function sessionAccountJidAliases(value: unknown): Readonly<{
  selfJids: readonly string[];
  pnJid: string;
  lidJid: string | null;
}> {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 2
    || !value.every((jid) => typeof jid === "string")
    || new Set(value).size !== value.length
  ) return fail("one fixed projection page had unsupported owner aliases");
  const selfJids = [...value].sort();
  if (!value.every((jid, index) => jid === selfJids[index])) {
    return fail("one fixed projection page had unsorted owner aliases");
  }
  const pnJids = selfJids.filter((jid) => SESSION_PN_JID_PATTERN.test(jid));
  const lidJids = selfJids.filter((jid) => SESSION_LID_JID_PATTERN.test(jid));
  if (
    pnJids.length !== 1
    || lidJids.length > 1
    || pnJids.length + lidJids.length !== selfJids.length
  ) return fail("one fixed projection page had unsupported owner aliases");
  return Object.freeze({
    selfJids: Object.freeze(selfJids),
    pnJid: pnJids[0]!,
    lidJid: lidJids[0] ?? null,
  });
}

async function* runMessageExportSession(
  initialRequest: WhatsAppMessageExportProjectionRequest,
  invocationBase: Omit<WhatsAppContactProjectionHelperInvocation, "stdin" | "maxOutputBytes">,
  runHelper: (
    invocation: WhatsAppContactProjectionHelperInvocation,
  ) => Promise<WhatsAppMessageExportSessionHelperResult>,
  admission: BeeperMessageLikeMeExportAdmission | undefined,
  checkDeadline: () => void,
): AsyncGenerator<unknown> {
  type SessionPage = Readonly<{
    response: Extract<ReturnType<typeof parseWhatsAppMessageExportProjectionResponse>, { status: "succeeded" }>;
    selfChatsExcluded: "none-detected" | "present-excluded";
  }>;

  class SessionValidator {
    readonly #framesHash = createHash("sha256");
    #request = initialRequest;
    #pages = 0;
    #messages = 0;
    #finalCheckpoint: unknown;
    #finalGeneration: unknown;
    #finalSelfJids: readonly string[] | undefined;
    #finalSelfChatsExcluded: "none-detected" | "present-excluded" | undefined;
    #finalNonConversationChatsExcluded: boolean | undefined;
    #failed = false;
    #sealed = false;
    #terminal = false;

    accept(canonicalFrame: WhatsAppMessageExportSessionCanonicalFrame): SessionPage | null {
      checkDeadline();
      if (this.#failed || this.#sealed) {
        return fail("the fixed projection session emitted an extra frame");
      }
      const frame = canonicalFrame.value;
      if (
        typeof frame !== "object"
        || frame === null
        || Array.isArray(frame)
        || !("kind" in frame)
      ) return fail("one fixed projection frame was malformed");
      if (frame.kind === "failed") {
        if (
          Object.keys(frame).sort().join("\0") !== "errorCode\0kind"
          || !("errorCode" in frame)
          || typeof frame.errorCode !== "string"
        ) return fail("the fixed projection failure frame was malformed");
        const failure = parseWhatsAppMessageExportProjectionResponse({
          schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
          status: "failed",
          errorCode: frame.errorCode,
        }, this.#request);
        if (failure.status !== "failed") {
          return fail("the fixed projection failure frame was invalid");
        }
        this.#failed = true;
        return null;
      }
      if (frame.kind === "page") {
        if (
          this.#terminal
          || Object.keys(frame).sort().join("\0")
            !== "checkpoint\0index\0kind\0messages\0nonConversationChatsExcluded\0projectionGeneration\0selfChatsExcluded\0selfJids\0terminal"
          || !("index" in frame)
          || frame.index !== this.#pages + 1
          || !("selfChatsExcluded" in frame)
          || (frame.selfChatsExcluded !== "none-detected"
            && frame.selfChatsExcluded !== "present-excluded")
          || !("selfJids" in frame)
          || this.#pages >= 1_000
          || !("terminal" in frame)
          || typeof frame.terminal !== "boolean"
          || !("messages" in frame)
          || !Array.isArray(frame.messages)
          || !("checkpoint" in frame)
          || !("projectionGeneration" in frame)
          || !("nonConversationChatsExcluded" in frame)
          || typeof frame.nonConversationChatsExcluded !== "boolean"
        ) return fail("one fixed projection page frame was unsupported");
        const aliases = sessionAccountJidAliases(frame.selfJids);
        const response = parseWhatsAppMessageExportProjectionResponse({
          schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
          status: "succeeded",
          projectionGeneration: frame.projectionGeneration,
          accountJidAliases: { pnJid: aliases.pnJid, lidJid: aliases.lidJid },
          nonConversationChatsExcluded: frame.nonConversationChatsExcluded,
          messages: frame.messages,
          nextCursor: frame.terminal ? null : (frame.checkpoint as { cursor?: unknown }).cursor,
          localInsertPageComplete: frame.terminal,
          checkpoint: frame.checkpoint,
        }, this.#request);
        if (response.status !== "succeeded") {
          return fail("one fixed projection page failed");
        }
        const provedSelfJids = new Set(aliases.selfJids);
        if (response.messages.some((message) =>
          message.chatKind === "dm"
          && provedSelfJids.has(canonicalWhatsAppParticipantJid(message.chatJid)))) {
          return fail("the fixed projection helper leaked a proved self chat");
        }
        if (
          response.localInsertPageComplete
          && response.messages.length === 0
          && this.#request.cursor !== "0"
        ) return fail("the fixed projection session contradicted its prior lookahead");
        if (
          this.#finalGeneration !== undefined
          && canonicalJson(this.#finalGeneration) !== canonicalJson(response.projectionGeneration)
        ) return fail("the fixed projection generation changed inside its session");
        if (
          this.#finalSelfJids !== undefined
          && canonicalJson(this.#finalSelfJids) !== canonicalJson(aliases.selfJids)
        ) return fail("the fixed projection owner aliases changed inside its session");
        if (
          this.#finalSelfChatsExcluded !== undefined
          && this.#finalSelfChatsExcluded !== frame.selfChatsExcluded
        ) return fail("the fixed projection self-chat exclusion changed inside its session");
        if (
          this.#finalNonConversationChatsExcluded !== undefined
          && this.#finalNonConversationChatsExcluded !== frame.nonConversationChatsExcluded
        ) return fail("the fixed projection non-conversation exclusion changed inside its session");
        this.#framesHash.update(canonicalFrame.canonical).update("\n");
        this.#messages += response.messages.length;
        if (this.#messages > 500_000) {
          return fail("the fixed projection session exceeded its message bound");
        }
        this.#pages += 1;
        this.#finalCheckpoint = response.checkpoint;
        this.#finalGeneration = response.projectionGeneration;
        this.#finalSelfJids = aliases.selfJids;
        this.#finalSelfChatsExcluded = frame.selfChatsExcluded;
        this.#finalNonConversationChatsExcluded = frame.nonConversationChatsExcluded;
        this.#terminal = response.localInsertPageComplete;
        this.#request = parseWhatsAppMessageExportProjectionRequest({
          ...this.#request,
          cursor: response.checkpoint.cursor,
          cursorAnchor: response.checkpoint.anchor,
          expectedGeneration: response.projectionGeneration,
        });
        checkDeadline();
        return Object.freeze({ response, selfChatsExcluded: frame.selfChatsExcluded });
      }
      if (
        frame.kind !== "seal"
        || Object.keys(frame).sort().join("\0")
          !== "checkpoint\0framesSha256\0integrityChecks\0kind\0messages\0pages\0projectionGeneration\0selfChatsExcluded\0selfJids"
        || !("pages" in frame)
        || frame.pages !== this.#pages
        || !("messages" in frame)
        || frame.messages !== this.#messages
        || !this.#terminal
        || !("integrityChecks" in frame)
        || frame.integrityChecks !== 1
        || !("framesSha256" in frame)
        || frame.framesSha256 !== this.#framesHash.digest("hex")
        || !("checkpoint" in frame)
        || canonicalJson(frame.checkpoint) !== canonicalJson(this.#finalCheckpoint)
        || !("projectionGeneration" in frame)
        || canonicalJson(frame.projectionGeneration) !== canonicalJson(this.#finalGeneration)
        || !("selfJids" in frame)
        || canonicalJson(frame.selfJids) !== canonicalJson(this.#finalSelfJids)
        || !("selfChatsExcluded" in frame)
        || frame.selfChatsExcluded !== this.#finalSelfChatsExcluded
      ) return fail("the fixed projection session seal was invalid");
      this.#sealed = true;
      checkDeadline();
      return null;
    }

    finish(): void {
      checkDeadline();
      if (this.#failed) return fail("fixed read-only projection rejected the private store");
      if (!this.#sealed || this.#pages < 1) {
        return fail("the fixed projection session omitted its seal");
      }
    }
  }

  const captureValidator = new SessionValidator();
  if (admission !== undefined) beginBeeperMessageLikeMeHelperLaunch(admission);
  let result: WhatsAppMessageExportSessionHelperResult | undefined;
  let operationFailure: unknown;
  try {
    checkDeadline();
    result = await runHelper(Object.freeze({
      ...invocationBase,
      stdin: `${canonicalJson({
        operation: "message-like-me.export-session",
        request: initialRequest,
      })}\n`,
      maxOutputBytes: WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDOUT_BYTES,
      onCanonicalFrame: (frame) => { captureValidator.accept(frame); },
      ...(admission === undefined
        ? {}
        : { onSpawned: (pid: number) => bindBeeperMessageLikeMeHelperOwner(admission, pid) }),
    }));
    checkDeadline();
    if (result.exitCode !== 0 || result.stderr.length !== 0) {
      return fail("fixed read-only projection session failed before reviewed output");
    }
    captureValidator.finish();
    const replayValidator = new SessionValidator();
    for await (const page of result.spool.replay(
      (frame) => replayValidator.accept(frame),
    )) {
      if (page !== null) yield page;
      checkDeadline();
    }
    replayValidator.finish();
  } catch (error) {
    operationFailure = error;
  } finally {
    let cleanupFailure: unknown;
    try {
      await result?.spool.close();
    } catch (error) {
      cleanupFailure = error;
    }
    const combinedFailure = operationFailure === undefined
      ? cleanupFailure
      : cleanupFailure === undefined
        ? operationFailure
        : new AggregateError(
            [operationFailure, cleanupFailure],
            "WhatsApp projection session operation and spool cleanup both failed",
          );
    if (admission !== undefined) {
      try {
        if (
          combinedFailure !== undefined
          && containsWhatsAppContactProjectionCleanupUnverified(combinedFailure)
        ) {
          markBeeperMessageLikeMeHelperCleanupUnsafe(admission);
        } else {
          settleBeeperMessageLikeMeHelper(admission);
        }
      } catch (lifecycleError) {
        if (combinedFailure !== undefined) {
          throw new AggregateError(
            [combinedFailure, lifecycleError],
            "WhatsApp helper lifecycle failed closed",
          );
        }
        throw lifecycleError;
      }
    }
    if (cleanupFailure !== undefined) {
      if (operationFailure !== undefined) {
        throw new AggregateError(
          [operationFailure, cleanupFailure],
          "WhatsApp projection session operation and spool cleanup both failed",
        );
      }
      throw cleanupFailure;
    }
  }
  if (operationFailure !== undefined) throw operationFailure;
}

export function createWhatsAppMessageLikeMeSource(
  request: WhatsAppMessageLikeMeSourceRequest,
): WhatsAppMessageLikeMeExportSource {
  const auth = requireAuth(request.auth);
  const accountJid = canonicalWhatsAppAccountSubjectJid(auth.subject);
  const accountId = localId("account", accountJid);
  const selfParticipantId = participantId(accountJid, accountJid);
  let consumed = false;
  let completion: WhatsAppMessageBundleV2Completion | undefined;

  const records = (async function* (): AsyncGenerator<WhatsAppMessageBundleV2Record> {
    if (consumed) return fail("record stream is single-use");
    consumed = true;
    throwIfAborted(request.signal);
    request.onProgress?.(Object.freeze({ phase: "preparing" }));
    const observedAt = new Date().toISOString();
    const monotonicNow = request.dependencies?.monotonicNow
      ?? (() => performance.now());
    const exportStartedAt = monotonicNow();
    if (!Number.isFinite(exportStartedAt) || exportStartedAt < 0) {
      return fail("the total export clock is unavailable");
    }
    const checkExportDeadline = (): void => {
      throwIfAborted(request.signal);
      remainingExportTimeout(exportStartedAt, request.dependencies, false);
    };
    const recordLimit = request.dependencies?.recordLimit
      ?? WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.records;
    if (
      !Number.isSafeInteger(recordLimit)
      || recordLimit < 1
      || recordLimit > WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.records
    ) return fail("the v2 record bound is invalid");
    const store = await validateWhatsAppStoreDirectory(auth.path, "projection");
    checkExportDeadline();
    const identities = await boundIdentities(store);
    checkExportDeadline();
    const fixed = fixedHelperFiles(request.dependencies);
    const run = request.dependencies?.runHelper;
    const participants = new Map<string, ParticipantFact>();
    participants.set(accountJid, { jid: accountJid, displayName: null, isSelf: true });
    const conversations = new Map<string, ConversationFact>();
    let cursor = "0";
    let cursorAnchor: string | null = null;
    let expectedGeneration: WhatsAppMessageExportProjectionGeneration | null = null;
    let page = 0;
    let messageRows = 0;
    let messageRecords = 0;
    let observedFrom: string | null = null;
    let observedThrough: string | null = null;
    let unprovenReactionStateRows = 0;
    let excludedSelfChatRows = 0;
    let payloadPurgedRows = 0;
    let nonConversationChatsExcluded: boolean | undefined;
    let accountJidAliases: ReadonlySet<string> | null = null;

    yield Object.freeze({
      schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      kind: "account",
      id: accountId,
      accountId,
      network: WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK,
      provenance: provenance(accountJid, accountJid, observedAt, null),
      displayName: null,
      handle: userHandle(accountJid),
      selfParticipantId,
    });
    checkExportDeadline();

    let sessionIterator: AsyncIterator<unknown> | undefined;
    try {
    for (;;) {
      checkExportDeadline();
      page += 1;
      if (page > 1_000) return fail("the fixed projection session exceeded its page bound");
      request.onProgress?.(Object.freeze({ phase: "page-started", page, messages: messageRows }));
      const projectionRequest = parseWhatsAppMessageExportProjectionRequest({
        schemaVersion: WHATSAPP_MESSAGE_EXPORT_PROJECTION_PROTOCOL_VERSION,
        operation: "message-like-me.export",
        accountSubject: auth.subject,
        cursor,
        cursorAnchor,
        limit: PAGE_LIMIT,
        expectedGeneration,
        storeIdentity: identities.store,
        sessionIdentity: identities.session,
        messageStoreIdentity: identities.message,
      }) satisfies WhatsAppMessageExportProjectionRequest;
      const invocation = Object.freeze({
        command: Object.freeze([
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--no-macros",
          "--no-addons",
          `--config=${fixed.config}`,
          fixed.helper,
        ]),
        cwd: store,
        environment: Object.freeze({
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          TZ: "UTC",
        }),
        stdin: `${JSON.stringify(projectionRequest)}\n`,
        timeoutMs: remainingExportTimeout(
          exportStartedAt,
          request.dependencies,
          run !== undefined,
        ),
        maxOutputBytes: WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }) satisfies WhatsAppContactProjectionHelperInvocation;
      let response: ReturnType<typeof parseWhatsAppMessageExportProjectionResponse>;
      if (run !== undefined) {
        const result = await run(invocation);
        throwIfAborted(request.signal);
        remainingExportTimeout(exportStartedAt, request.dependencies, true);
        if (result.exitCode !== 0 || result.stderr.length !== 0) {
          return fail("fixed read-only projection helper failed before reviewed output");
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(result.stdout.trim()) as unknown;
        } catch {
          return fail("fixed read-only projection helper returned malformed output");
        }
        response = parseWhatsAppMessageExportProjectionResponse(decoded, projectionRequest);
      } else {
        sessionIterator ??= runMessageExportSession(
          projectionRequest,
          Object.freeze({
            command: invocation.command,
            cwd: invocation.cwd,
            environment: invocation.environment,
            timeoutMs: invocation.timeoutMs,
            maxStderrBytes: invocation.maxStderrBytes,
            ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
          }),
          request.dependencies?.runSessionHelper
            ?? runWhatsAppMessageExportSessionHelperChild,
          request.admission,
          checkExportDeadline,
        )[Symbol.asyncIterator]();
        const pageResult = await sessionIterator.next();
        if (pageResult.done) {
          return fail("fixed read-only projection session omitted a page");
        }
        if (
          typeof pageResult.value !== "object"
          || pageResult.value === null
          || Array.isArray(pageResult.value)
          || Object.keys(pageResult.value).sort().join("\0") !== "response\0selfChatsExcluded"
          || !("response" in pageResult.value)
          || !("selfChatsExcluded" in pageResult.value)
          || (pageResult.value.selfChatsExcluded !== "none-detected"
            && pageResult.value.selfChatsExcluded !== "present-excluded")
        ) return fail("fixed read-only projection session returned an unsupported page");
        if (pageResult.value.selfChatsExcluded === "present-excluded") {
          excludedSelfChatRows = Math.max(1, excludedSelfChatRows);
        }
        // SessionValidator already produced the one final parsed page graph.
        // Re-parsing it here would retain a second full page during conversion.
        response = pageResult.value.response as ReturnType<
          typeof parseWhatsAppMessageExportProjectionResponse
        >;
      }
      if (response.status === "failed") {
        return fail(`fixed read-only projection rejected the store (${response.errorCode})`);
      }
      if (
        response.localInsertPageComplete
        && response.messages.length === 0
        && projectionRequest.cursor !== "0"
      ) return fail("the fixed projection contradicted its prior lookahead");
      expectedGeneration = response.projectionGeneration;
      if (nonConversationChatsExcluded === undefined) {
        nonConversationChatsExcluded = response.nonConversationChatsExcluded;
      } else if (nonConversationChatsExcluded !== response.nonConversationChatsExcluded) {
        return fail("fixed projection non-conversation exclusion changed inside its snapshot");
      }
      const pageAliases = new Set([
        response.accountJidAliases.pnJid,
        response.accountJidAliases.lidJid,
      ].filter((jid): jid is string => jid !== null));
      if (accountJidAliases === null) {
        accountJidAliases = pageAliases;
      } else if (
        accountJidAliases.size !== pageAliases.size
        || [...accountJidAliases].some((jid) => !pageAliases.has(jid))
      ) {
        return fail("bound account aliases changed inside the fixed snapshot");
      }

      for (const item of response.messages) {
        checkExportDeadline();
        messageRows += 1;
        if (messageRows > 500_000) {
          return fail("the fixed projection session exceeded its message bound");
        }
        if (
          item.chatKind === "dm"
          && accountJidAliases.has(canonicalWhatsAppParticipantJid(item.chatJid))
        ) {
          excludedSelfChatRows += 1;
          continue;
        }
        if (item.reactionToMessageId !== null) {
          // Wacli 0.15 may retain the prior emoji when the same reaction row is
          // removed, so no projected reaction row proves current active state.
          unprovenReactionStateRows += 1;
          continue;
        }
        observedFrom = earliest(observedFrom, item.timestamp);
        observedThrough = latest(observedThrough, item.timestamp);
        let conversation = conversations.get(item.chatJid);
        if (conversation === undefined) {
          conversation = {
            jid: item.chatJid,
            type: item.chatKind === "dm" ? "direct" : "group",
            title: item.chatName,
            participantJids: new Set([accountJid]),
            startedAt: item.timestamp,
            lastMessageAt: item.timestamp,
          };
          conversations.set(item.chatJid, conversation);
        } else {
          if (conversation.type !== (item.chatKind === "dm" ? "direct" : "group")) {
            return fail("one chat changed kind inside the fixed snapshot");
          }
          conversation.title ??= item.chatName;
          if (item.timestamp < conversation.startedAt) conversation.startedAt = item.timestamp;
          if (item.timestamp > conversation.lastMessageAt) conversation.lastMessageAt = item.timestamp;
        }
        const directPeer = item.chatKind === "dm"
          ? canonicalWhatsAppParticipantJid(item.chatJid)
          : null;
        if (directPeer !== null) {
          conversation.participantJids.add(directPeer);
          if (!participants.has(directPeer)) {
            participants.set(directPeer, { jid: directPeer, displayName: item.chatName, isSelf: false });
          }
        }
        const resolvedSenderJid = senderJid(item, accountJid, accountJidAliases, directPeer);
        if (resolvedSenderJid !== null) {
          conversation.participantJids.add(resolvedSenderJid);
          const current = participants.get(resolvedSenderJid);
          if (current === undefined) {
            participants.set(resolvedSenderJid, {
              jid: resolvedSenderJid,
              displayName: item.senderName,
              isSelf: resolvedSenderJid === accountJid,
            });
          } else current.displayName ??= item.senderName;
        }
        if (
          conversation.participantJids.size
            > WHATSAPP_MESSAGE_BUNDLE_V2_LIMITS.participantsPerConversation
        ) return fail("one conversation exceeded its participant bound");

        const providerId = messageProviderId(item);
        const deletion = messageDeletion(item, observedAt);
        const payloadPurged = item.payloadPurgedAt !== null;
        const bodyTruncated = payloadPurged && deletion === null;
        if (bodyTruncated) payloadPurgedRows += 1;
        const edit = item.edited && item.editedAt !== null
          ? Object.freeze({
              kind: "in-place" as const,
              editedAt: item.editedAt,
              providerRevision: item.editedAt,
            })
          : null;
        messageRecords += 1;
        if (
          1 + messageRecords + participants.size + conversations.size
            > recordLimit
        ) return fail("the fixed projection exceeded the v2 record bound");
        const messageRecord = Object.freeze({
          schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
          kind: "message",
          id: localId("message", accountJid, item.chatJid, item.messageId),
          accountId,
          network: WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK,
          provenance: provenance(
            providerId,
            accountJid,
            observedAt,
            item.editedAt ?? item.deletedAt ?? item.payloadPurgedAt,
          ),
          conversationId: localId("conversation", accountJid, item.chatJid),
          senderParticipantId: resolvedSenderJid === null
            ? null
            : participantId(accountJid, resolvedSenderJid),
          direction: item.fromMe ? "outgoing" : "incoming",
          sentAt: item.timestamp,
          sortKey: item.rowid.padStart(19, "0"),
          body: payloadPurged ? null : body(item),
          bodyTruncated,
          replyTo: item.quotedMessageId === null
            ? null
            : Object.freeze({
                messageId: null,
                providerId: `${item.chatJid}/${item.quotedMessageId}`,
              }),
          edit,
          deletion,
          attachments: attachment(item),
        });
        checkExportDeadline();
        yield messageRecord;
        checkExportDeadline();
      }
      request.onProgress?.(Object.freeze({ phase: "page-completed", page, messages: messageRows }));
      cursor = response.checkpoint.cursor;
      cursorAnchor = response.checkpoint.anchor;
      if (response.localInsertPageComplete) {
        if (sessionIterator !== undefined) {
          const sealed = await sessionIterator.next();
          if (!sealed.done) return fail("fixed projection session emitted data after its terminal page");
        }
        break;
      }
      if (response.nextCursor === null || response.nextCursor !== cursor) {
        return fail("paged projection omitted its next cursor");
      }
    }
    } finally {
      await sessionIterator?.return?.();
    }

    for (const participant of [...participants.values()].sort((left, right) => left.jid.localeCompare(right.jid))) {
      checkExportDeadline();
      const participantRecord = Object.freeze({
        schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
        kind: "participant",
        id: participantId(accountJid, participant.jid),
        accountId,
        network: WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK,
        provenance: provenance(participant.jid, accountJid, observedAt, null),
        displayName: participant.displayName,
        handle: userHandle(participant.jid),
        isSelf: participant.isSelf,
      });
      checkExportDeadline();
      yield participantRecord;
      checkExportDeadline();
    }
    for (const conversation of [...conversations.values()].sort((left, right) => left.jid.localeCompare(right.jid))) {
      checkExportDeadline();
      const participantIds = [...conversation.participantJids]
        .sort()
        .map((jid) => participantId(accountJid, jid));
      const record: WhatsAppMessageBundleV2Conversation = Object.freeze({
        schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
        kind: "conversation",
        id: localId("conversation", accountJid, conversation.jid),
        accountId,
        network: WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK,
        provenance: provenance(conversation.jid, accountJid, observedAt, null),
        type: conversation.type,
        title: conversation.title,
        participantIds: Object.freeze(participantIds),
        participantsComplete: conversation.type === "direct",
        startedAt: conversation.startedAt,
        lastMessageAt: conversation.lastMessageAt,
      });
      checkExportDeadline();
      yield record;
      checkExportDeadline();
    }
    if (
      1 + messageRecords + participants.size + conversations.size
        > recordLimit
    ) return fail("the fixed projection exceeded the v2 record bound");
    const warnings = Object.freeze([
      "remote-history-incomplete",
      ...(unprovenReactionStateRows > 0 ? ["reaction-state-unproven"] : []),
      ...(excludedSelfChatRows > 0 ? ["self-chat-excluded"] : []),
      ...(payloadPurgedRows > 0 ? ["message-payload-purged"] : []),
      ...(nonConversationChatsExcluded === true ? ["non-conversation-chats-excluded"] : []),
    ]);
    const completed = Object.freeze({
      completeness: Object.freeze({
        kind: "bounded-local",
        reason: "local-store-coverage-unknown",
        observedFrom,
        observedThrough,
      }),
      warnings,
    });
    request.onProgress?.(Object.freeze({
      phase: "conversion-completed",
      messages: messageRows,
      conversations: conversations.size,
      participants: participants.size,
    }));
    checkExportDeadline();
    completion = completed;
  })();

  return Object.freeze({
    descriptor: Object.freeze({
      source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
      provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
    }),
    records,
    completion: async () => completion ?? fail("record stream did not complete"),
  });
}
