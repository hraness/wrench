import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { WrenchAuth } from "./auth";
import { sha256 } from "./canonical-json";
import {
  runWhatsAppContactProjectionHelperChild,
  validateWhatsAppStoreDirectory,
  type WhatsAppContactProjectionHelperInvocation,
  type WhatsAppContactProjectionHelperResult,
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
  type WhatsAppMessageBundleV2Attachment,
  type WhatsAppMessageBundleV2Completion,
  type WhatsAppMessageBundleV2Conversation,
  type WhatsAppMessageBundleV2Record,
} from "./whatsapp-message-bundle-v2";

const PAGE_LIMIT = 500;
const PAGE_TIMEOUT_MS = 5 * 60_000;
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
}>;

export type WhatsAppMessageLikeMeSourceRequest = Readonly<{
  auth: WrenchAuth;
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
    || !/^whatsapp:(?:pn:[0-9]{5,20}|lid:[0-9]{5,32})$/u.test(value.subject)
  ) return fail("a bound WhatsApp linked-device-store auth locator is required");
  return value as WhatsAppAuth & Readonly<{ subject: string }>;
}

function selfJid(subject: string): string {
  const match = /^whatsapp:(pn|lid):([0-9]+)$/u.exec(subject);
  if (match?.[1] === "pn") return `${match[2]}@s.whatsapp.net`;
  if (match?.[1] === "lid") return `${match[2]}@lid`;
  return fail("bound account subject is malformed");
}

function canonicalParticipantJid(value: string): string {
  const match = /^([0-9]{5,32})(?::[0-9]{1,5})?@(s\.whatsapp\.net|lid)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return fail("message sender is not a canonical WhatsApp participant JID");
  }
  return `${match[1]}@${match[2]}`;
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
  const phone = /^([0-9]{5,20})@s\.whatsapp\.net$/u.exec(jid);
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
  if (item.mediaType?.toLowerCase() === "audio") {
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

function earliest(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function latest(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

export function createWhatsAppMessageLikeMeSource(
  request: WhatsAppMessageLikeMeSourceRequest,
): WhatsAppMessageLikeMeExportSource {
  const auth = requireAuth(request.auth);
  const accountJid = selfJid(auth.subject);
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
    const store = await validateWhatsAppStoreDirectory(auth.path, "projection");
    const identities = await boundIdentities(store);
    const fixed = fixedHelperFiles(request.dependencies);
    const run = request.dependencies?.runHelper ?? runWhatsAppContactProjectionHelperChild;
    const participants = new Map<string, ParticipantFact>();
    participants.set(accountJid, { jid: accountJid, displayName: null, isSelf: true });
    const conversations = new Map<string, ConversationFact>();
    let cursor = "0";
    let cursorAnchor: string | null = null;
    let expectedGeneration: WhatsAppMessageExportProjectionGeneration | null = null;
    let page = 0;
    let messageRows = 0;
    let observedFrom: string | null = null;
    let observedThrough: string | null = null;
    let skippedReactionRows = 0;
    let unprovenReactionActorRows = 0;
    let excludedSelfChatRows = 0;

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

    for (;;) {
      page += 1;
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
        timeoutMs: PAGE_TIMEOUT_MS,
        maxOutputBytes: WHATSAPP_MESSAGE_EXPORT_PROJECTION_MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }) satisfies WhatsAppContactProjectionHelperInvocation;
      const result = await run(invocation);
      throwIfAborted(request.signal);
      if (result.exitCode !== 0 || result.stderr.length !== 0) {
        return fail("fixed read-only projection helper failed before reviewed output");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(result.stdout.trim()) as unknown;
      } catch {
        return fail("fixed read-only projection helper returned malformed output");
      }
      const response = parseWhatsAppMessageExportProjectionResponse(raw, projectionRequest);
      if (response.status === "failed") {
        return fail(`fixed read-only projection rejected the store (${response.errorCode})`);
      }
      expectedGeneration = response.projectionGeneration;

      for (const item of response.messages) {
        messageRows += 1;
        if (
          item.chatKind === "dm"
          && canonicalParticipantJid(item.chatJid) === accountJid
        ) {
          excludedSelfChatRows += 1;
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
        const directPeer = item.chatKind === "dm" ? canonicalParticipantJid(item.chatJid) : null;
        if (directPeer !== null) {
          conversation.participantJids.add(directPeer);
          if (!participants.has(directPeer)) {
            participants.set(directPeer, { jid: directPeer, displayName: item.chatName, isSelf: false });
          }
        }
        const senderJid = item.fromMe
          ? accountJid
          : item.senderJid === null
            ? directPeer
            : canonicalParticipantJid(item.senderJid);
        if (senderJid !== null) {
          conversation.participantJids.add(senderJid);
          const current = participants.get(senderJid);
          if (current === undefined) {
            participants.set(senderJid, {
              jid: senderJid,
              displayName: item.senderName,
              isSelf: senderJid === accountJid,
            });
          } else current.displayName ??= item.senderName;
        }

        const providerId = messageProviderId(item);
        const targetProviderId = item.reactionToMessageId === null
          ? null
          : `${item.chatJid}/${item.reactionToMessageId}`;
        if (targetProviderId !== null) {
          if (item.reactionEmoji === null || item.reactionEmoji.length === 0) {
            skippedReactionRows += 1;
            continue;
          }
          if (senderJid === null) {
            unprovenReactionActorRows += 1;
            continue;
          }
          yield Object.freeze({
            schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
            kind: "reaction",
            id: localId("reaction", accountJid, item.chatJid, item.messageId),
            accountId,
            network: WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK,
            provenance: provenance(providerId, accountJid, observedAt, null),
            messageId: null,
            messageProviderId: targetProviderId,
            participantId: participantId(accountJid, senderJid),
            body: item.reactionEmoji,
            reactedAt: item.timestamp,
            state: "active",
          });
          continue;
        }

        const deletion = messageDeletion(item, observedAt);
        const edit = item.edited && item.editedAt !== null
          ? Object.freeze({
              kind: "in-place" as const,
              editedAt: item.editedAt,
              providerRevision: item.editedAt,
            })
          : null;
        yield Object.freeze({
          schemaVersion: WHATSAPP_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
          kind: "message",
          id: localId("message", accountJid, item.chatJid, item.messageId),
          accountId,
          network: WHATSAPP_MESSAGE_BUNDLE_V2_NETWORK,
          provenance: provenance(
            providerId,
            accountJid,
            observedAt,
            item.editedAt ?? item.deletedAt,
          ),
          conversationId: localId("conversation", accountJid, item.chatJid),
          senderParticipantId: senderJid === null ? null : participantId(accountJid, senderJid),
          direction: item.fromMe ? "outgoing" : "incoming",
          sentAt: item.timestamp,
          sortKey: item.rowid.padStart(19, "0"),
          body: body(item),
          bodyTruncated: false,
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
      }
      request.onProgress?.(Object.freeze({ phase: "page-completed", page, messages: messageRows }));
      cursor = response.checkpoint.cursor;
      cursorAnchor = response.checkpoint.anchor;
      if (response.localInsertPageComplete) break;
      if (response.nextCursor === null || response.nextCursor !== cursor) {
        return fail("paged projection omitted its next cursor");
      }
    }

    for (const participant of [...participants.values()].sort((left, right) => left.jid.localeCompare(right.jid))) {
      yield Object.freeze({
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
    }
    for (const conversation of [...conversations.values()].sort((left, right) => left.jid.localeCompare(right.jid))) {
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
      yield record;
    }
    const warnings = Object.freeze([
      "remote-history-incomplete",
      ...(skippedReactionRows > 0 ? ["reaction-removal-unproven"] : []),
      ...(unprovenReactionActorRows > 0 ? ["reaction-actor-unproven"] : []),
      ...(excludedSelfChatRows > 0 ? ["self-chat-excluded"] : []),
    ]);
    completion = Object.freeze({
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
