import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";
import { OmniMaterializerDriftError } from "../omni-model";
import type {
  OmniAttachmentV1,
  OmniParticipantV1,
  ProviderConversationV1,
  ProviderMaterializedPageV1,
  ProviderMessageV1,
} from "../omni-model";
import { isGmailAccountSubject } from "../provider-subject";
import { parseGmailThreadUrl } from "./gmail-api";

type JsonRecord = Readonly<Record<string, unknown>>;
type GmailListView = "inbox" | "search";

const GMAIL_OMNI_BODY_BYTES = 256 * 1024;
const GMAIL_AGGREGATE_BODY_BYTES = 7 * 1024 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

type ParsedListInput = Readonly<{
  view: GmailListView;
  query: string | null;
  cursor: string | null;
  limit: number;
  includeSpamTrash: boolean;
}>;

type ParsedParticipant = Readonly<{
  email: string;
  displayName: null;
}>;

type ParsedThreadSummary = Readonly<{
  id: string;
  historyId: string | null;
  snippet: string | null;
  subject: string | null;
  orderedAt: string | null;
  messageCount: number;
  participants: readonly ParsedParticipant[];
  unread: boolean;
  archived: boolean | null;
}>;

type ParsedAttachment = Readonly<{
  partId: string;
  contentDisposition: "attachment" | "inline" | null;
  attachmentId: string | null;
  messageId: string;
  filename: string;
  mimeType: string;
  size: number;
}>;

type ParsedMessage = Readonly<{
  id: string;
  threadId: string | null;
  historyId: string | null;
  internalDate: string | null;
  labelIds: readonly string[];
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  text: string | null;
  bodyTruncated: boolean;
  originalBodyBytes: number;
  attachments: readonly ParsedAttachment[];
}>;

function drift(path: string, message: string): never {
  throw new OmniMaterializerDriftError("gmail", path, message);
}

function record(value: unknown, path: string): JsonRecord {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return drift(path, "must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return drift(path, "must not have symbol properties");
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return drift(`${path}.${key}`, "must be an enumerable data property");
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return drift(path, "contains an unreviewed property");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return drift(`${path}.${key}`, "is required");
  }
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) return drift(path, `must be an array of at most ${maximum} items`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).length !== expected.size
    || Reflect.ownKeys(descriptors).some((key) => !expected.has(key))
  ) return drift(path, "must be a dense array without named properties");
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return drift(`${path}[${index}]`, "must be an enumerable data property");
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function hasUnsafeControl(value: string, allowLayout = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code <= 0x1f && !(allowLayout && (code === 0x09 || code === 0x0a || code === 0x0d)))
      || code === 0x7f
      || (code >= 0x80 && code <= 0x9f)
      || code === 0x061c
      || code === 0x200e
      || code === 0x200f
      || (code >= 0x2028 && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
    ) return true;
  }
  return false;
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function string(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
  allowLayout = false,
): string {
  if (
    typeof value !== "string"
    || !isWellFormedText(value)
    || Buffer.byteLength(value, "utf8") > maximum
    || (!allowEmpty && value.length === 0)
    || hasUnsafeControl(value, allowLayout)
  ) return drift(path, "must be bounded text without unsafe controls");
  return value;
}

function inputString(value: unknown, path: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || !isWellFormedText(value)
    || hasUnsafeControl(value)
  ) return drift(path, "must be bounded input text without unsafe controls");
  return value;
}

function nullableString(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
  allowLayout = false,
): string | null {
  return value === null
    ? null
    : string(value, path, maximum, allowEmpty, allowLayout);
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return drift(path, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return drift(path, "must be boolean");
  return value;
}

function nullableBoolean(value: unknown, path: string): boolean | null {
  return value === null ? null : boolean(value, path);
}

function gmailId(value: unknown, path: string): string {
  const result = string(value, path, 256);
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(result)) {
    return drift(path, "must be an exact Gmail ID");
  }
  return result;
}

function attachmentId(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path, 4_096);
}

function historyId(value: unknown, path: string): string | null {
  if (value === null) return null;
  const result = string(value, path, 64);
  if (!/^[0-9]{1,64}$/u.test(result)) return drift(path, "must be a decimal history ID");
  return result;
}

function timestamp(value: unknown, path: string): string | null {
  if (value === null) return null;
  const result = string(value, path, 64);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) {
    return drift(path, "must be a canonical ISO timestamp or null");
  }
  return result;
}

function accountSubject(value: unknown, path: string): string {
  const result = string(value, path, 254);
  if (!isGmailAccountSubject(result)) return drift(path, "must be an exact Gmail email subject");
  return result;
}

function parseListInput(input: OperationInput): ParsedListInput {
  const source = record(input, "messaging.list input");
  exactKeys(source, ["view"], [
    "query",
    "cursor",
    "limit",
    "include_spam_trash",
  ], "messaging.list input");
  if (source.view !== "inbox" && source.view !== "search") {
    return drift("messaging.list input.view", "must be inbox or search");
  }
  const query = source.query === undefined
    ? null
    : inputString(source.query, "messaging.list input.query", 512);
  if (source.view === "search" && query === null) {
    return drift("messaging.list input.query", "is required when view is search");
  }
  if (source.view === "inbox" && query !== null) {
    return drift("messaging.list input.query", "is not accepted when view is inbox");
  }
  if (query !== null && query.trim().length === 0) {
    return drift("messaging.list input.query", "must contain a non-whitespace expression");
  }
  const includeSpamTrash = source.include_spam_trash === undefined
    ? false
    : boolean(source.include_spam_trash, "messaging.list input.include_spam_trash");
  if (source.view === "inbox" && source.include_spam_trash !== undefined) {
    return drift("messaging.list input.include_spam_trash", "is accepted only for search");
  }
  return Object.freeze({
    view: source.view,
    query,
    cursor: source.cursor === undefined
      ? null
      : inputString(source.cursor, "messaging.list input.cursor", 4_096),
    limit: source.limit === undefined
      ? 50
      : integer(source.limit, "messaging.list input.limit", 1, 100),
    includeSpamTrash,
  });
}

function parseReadInput(input: OperationInput): string {
  const source = record(input, "messaging.read input");
  exactKeys(source, ["thread_id"], [], "messaging.read input");
  return gmailId(source.thread_id, "messaging.read input.thread_id");
}

function parseParticipant(value: unknown, path: string): ParsedParticipant {
  const source = record(value, path);
  exactKeys(source, ["email", "displayName"], [], path);
  if (source.displayName !== null) return drift(`${path}.displayName`, "must be null in the reviewed projection");
  return Object.freeze({
    email: accountSubject(source.email, `${path}.email`).toLowerCase(),
    displayName: null,
  });
}

function parseThreadUrl(
  value: unknown,
  path: string,
  account: string,
  expectedThreadId: string,
  expectedView: "all" | "inbox",
): void {
  const raw = string(value, path, 8_192);
  let parsed;
  try {
    parsed = parseGmailThreadUrl(new URL(raw));
  } catch {
    return drift(path, "must be an exact reviewed Gmail thread URL");
  }
  if (
    parsed.threadId !== expectedThreadId
    || parsed.view !== expectedView
    || parsed.accountLocator.toLowerCase() !== account.toLowerCase()
    || parsed.canonicalUrl !== raw
  ) return drift(path, "must bind the output account, view, and thread ID");
}

function parseThreadSummary(
  value: unknown,
  path: string,
  account: string,
  view: GmailListView,
): ParsedThreadSummary {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "historyId",
    "snippet",
    "subject",
    "orderedAt",
    "messageCount",
    "participants",
    "unread",
    "archived",
    "threadUrl",
    "readInput",
  ], [], path);
  const id = gmailId(source.id, `${path}.id`);
  const readInput = record(source.readInput, `${path}.readInput`);
  exactKeys(readInput, ["thread_id"], [], `${path}.readInput`);
  if (gmailId(readInput.thread_id, `${path}.readInput.thread_id`) !== id) {
    return drift(`${path}.readInput.thread_id`, "must bind the summary thread ID");
  }
  parseThreadUrl(
    source.threadUrl,
    `${path}.threadUrl`,
    account,
    id,
    view === "inbox" ? "inbox" : "all",
  );
  const participants = Object.freeze(array(source.participants, `${path}.participants`, 256)
    .map((entry, index) => parseParticipant(entry, `${path}.participants[${index}]`)));
  const participantIds = participants.map((participant) => participant.email);
  if (new Set(participantIds).size !== participantIds.length) {
    return drift(`${path}.participants`, "contains duplicate canonical email identities");
  }
  return Object.freeze({
    id,
    historyId: historyId(source.historyId, `${path}.historyId`),
    snippet: nullableString(source.snippet, `${path}.snippet`, 64 * 1024, true, true),
    subject: nullableString(source.subject, `${path}.subject`, 8_192, true, true),
    orderedAt: timestamp(source.orderedAt, `${path}.orderedAt`),
    messageCount: integer(source.messageCount, `${path}.messageCount`, 1, Number.MAX_SAFE_INTEGER),
    participants,
    unread: boolean(source.unread, `${path}.unread`),
    archived: nullableBoolean(source.archived, `${path}.archived`),
  });
}

function materializedParticipant(value: ParsedParticipant): OmniParticipantV1 {
  return Object.freeze({
    providerId: value.email,
    displayName: value.displayName,
    handle: value.email,
  });
}

function materializedConversation(value: ParsedThreadSummary): ProviderConversationV1 {
  return Object.freeze({
    kind: "conversation",
    providerId: value.id,
    providerRevision: value.historyId,
    orderedAt: value.orderedAt,
    detail: "summary",
    title: value.subject,
    summary: value.snippet,
    participants: Object.freeze(value.participants.map(materializedParticipant)),
    unread: value.unread,
    unreadCount: null,
    archived: value.archived,
    pending: null,
  });
}

function listPartition(account: string, input: ParsedListInput): string {
  if (input.view === "inbox") return `${account.toLowerCase()}:gmail:threads:inbox`;
  const digest = createHash("sha256")
    .update(input.query ?? "", "utf8")
    .digest("hex");
  return `${account.toLowerCase()}:gmail:threads:search:${input.includeSpamTrash ? "all" : "ordinary"}:${digest}`;
}

/** Strict Gmail thread-list normalization with replayable opaque pagination. */
export function materializeGmailMessagingList(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const parsedInput = parseListInput(input);
  const source = record(output, "messaging.list output");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "view",
    "query",
    "includeSpamTrash",
    "threads",
    "nextCursor",
    "resultSizeEstimate",
  ], [], "messaging.list output");
  if (source.provider !== "gmail") return drift("messaging.list output.provider", "must be gmail");
  if (source.operation !== "messaging.list") {
    return drift("messaging.list output.operation", "must be messaging.list");
  }
  const account = accountSubject(source.accountSubject, "messaging.list output.accountSubject");
  if (source.view !== parsedInput.view) {
    return drift("messaging.list output.view", "must bind messaging.list input.view");
  }
  if (source.query !== parsedInput.query) {
    return drift("messaging.list output.query", "must bind messaging.list input.query");
  }
  if (source.includeSpamTrash !== parsedInput.includeSpamTrash) {
    return drift(
      "messaging.list output.includeSpamTrash",
      "must bind messaging.list input.include_spam_trash",
    );
  }
  const summaries = Object.freeze(array(
    source.threads,
    "messaging.list output.threads",
    parsedInput.limit,
  ).map((entry, index) => parseThreadSummary(
    entry,
    `messaging.list output.threads[${index}]`,
    account,
    parsedInput.view,
  )));
  const ids = summaries.map((thread) => thread.id);
  if (new Set(ids).size !== ids.length) {
    return drift("messaging.list output.threads", "contains duplicate stable thread IDs");
  }
  const nextCursor = nullableString(
    source.nextCursor,
    "messaging.list output.nextCursor",
    4_096,
  );
  if (nextCursor !== null && nextCursor === parsedInput.cursor) {
    return drift("messaging.list output.nextCursor", "must advance beyond the input cursor");
  }
  integer(
    source.resultSizeEstimate,
    "messaging.list output.resultSizeEstimate",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const complete = parsedInput.cursor === null && nextCursor === null;
  const nextInput = nextCursor === null
    ? null
    : parsedInput.view === "inbox"
      ? Object.freeze({
          view: "inbox" as const,
          cursor: nextCursor,
          limit: parsedInput.limit,
        })
      : Object.freeze({
          view: "search" as const,
          query: parsedInput.query ?? "",
          cursor: nextCursor,
          limit: parsedInput.limit,
          include_spam_trash: parsedInput.includeSpamTrash,
        });
  return Object.freeze({
    schemaVersion: 1,
    partition: listPartition(account, parsedInput),
    completeness: Object.freeze({
      kind: complete ? "complete" : "page",
      reason: complete
        ? "Gmail returned the complete requested thread collection in one root page."
        : nextCursor === null
          ? "Gmail returned a terminal continuation page without standalone partition completeness."
          : "Gmail returned an opaque cursor for an older thread-list page.",
    }),
    cursor: Object.freeze({
      direction: "backward",
      request: parsedInput.cursor,
      nextInput,
    }),
    entities: Object.freeze(summaries.map(materializedConversation)),
    tombstones: Object.freeze([]),
  });
}

function parseHeader(value: unknown, path: string): string | null {
  return nullableString(value, path, 64 * 1024, true, true);
}

function parseBody(
  value: unknown,
  path: string,
): Readonly<{
  text: string | null;
  truncated: boolean;
  originalBytes: number;
}> {
  const source = record(value, path);
  exactKeys(source, ["text", "source"], [], path);
  if (
    source.source !== "text/plain"
    && source.source !== "text/html"
    && source.source !== "none"
  ) return drift(`${path}.source`, "must be text/plain, text/html, or none");
  if (source.text === null) {
    if (source.source !== "none") {
      return drift(path, "must bind body text to its MIME projection source");
    }
    return Object.freeze({ text: null, truncated: false, originalBytes: 0 });
  }
  if (
    typeof source.text !== "string"
    || source.text.length > GMAIL_AGGREGATE_BODY_BYTES
    || !isWellFormedText(source.text)
    || hasUnsafeControl(source.text, true)
  ) return drift(`${path}.text`, "must be bounded text without unsafe controls");
  if (source.source === "none") {
    return drift(path, "must bind body text to its MIME projection source");
  }
  const originalBytes = Buffer.byteLength(source.text, "utf8");
  if (originalBytes > GMAIL_AGGREGATE_BODY_BYTES) {
    return drift(
      `${path}.text`,
      `must not exceed the ${GMAIL_AGGREGATE_BODY_BYTES}-byte Gmail aggregate body ceiling`,
    );
  }
  const encoded = Buffer.from(source.text, "utf8");
  if (fatalUtf8Decoder.decode(encoded) !== source.text) {
    return drift(`${path}.text`, "must contain valid Unicode scalar text");
  }
  if (encoded.byteLength <= GMAIL_OMNI_BODY_BYTES) {
    return Object.freeze({
      text: source.text,
      truncated: false,
      originalBytes: encoded.byteLength,
    });
  }
  let prefixBytes = GMAIL_OMNI_BODY_BYTES;
  while (
    prefixBytes > 0
    && (encoded[prefixBytes]! & 0xc0) === 0x80
  ) prefixBytes -= 1;
  return Object.freeze({
    text: fatalUtf8Decoder.decode(encoded.subarray(0, prefixBytes)),
    truncated: true,
    originalBytes: encoded.byteLength,
  });
}

function parseAttachment(
  value: unknown,
  path: string,
  messageIdValue: string,
): ParsedAttachment {
  const source = record(value, path);
  exactKeys(source, [
    "partId",
    "contentDisposition",
    "attachmentId",
    "messageId",
    "filename",
    "mimeType",
    "size",
  ], [], path);
  const messageId = gmailId(source.messageId, `${path}.messageId`);
  if (messageId !== messageIdValue) {
    return drift(`${path}.messageId`, "must bind its containing Gmail message");
  }
  const mimeType = string(source.mimeType, `${path}.mimeType`, 256);
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;.*)?$/u.test(mimeType)) {
    return drift(`${path}.mimeType`, "must be a bounded MIME type");
  }
  if (
    source.contentDisposition !== null
    && source.contentDisposition !== "attachment"
    && source.contentDisposition !== "inline"
  ) {
    return drift(`${path}.contentDisposition`, "must be attachment, inline, or null");
  }
  return Object.freeze({
    partId: string(source.partId, `${path}.partId`, 256),
    contentDisposition: source.contentDisposition,
    attachmentId: attachmentId(source.attachmentId, `${path}.attachmentId`),
    messageId,
    filename: string(source.filename, `${path}.filename`, 8_192, true, true),
    mimeType,
    size: integer(source.size, `${path}.size`, 0, Number.MAX_SAFE_INTEGER),
  });
}

function parseMessage(
  value: unknown,
  path: string,
  expectedThreadId: string,
): ParsedMessage {
  const source = record(value, path);
  exactKeys(source, [
    "id",
    "threadId",
    "historyId",
    "internalDate",
    "labelIds",
    "snippet",
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "date",
    "messageId",
    "inReplyTo",
    "body",
    "attachments",
  ], [], path);
  const id = gmailId(source.id, `${path}.id`);
  const threadId = source.threadId === null
    ? null
    : gmailId(source.threadId, `${path}.threadId`);
  if (threadId !== null && threadId !== expectedThreadId) {
    return drift(`${path}.threadId`, "must bind its containing Gmail thread");
  }
  const labelIds = Object.freeze(array(source.labelIds, `${path}.labelIds`, 1_000)
    .map((entry, index) => string(entry, `${path}.labelIds[${index}]`, 256)));
  if (new Set(labelIds).size !== labelIds.length) {
    return drift(`${path}.labelIds`, "contains duplicate label IDs");
  }
  // Validate the snippet even though full message bodies are authoritative.
  nullableString(source.snippet, `${path}.snippet`, 64 * 1024, true, true);
  const body = parseBody(source.body, `${path}.body`);
  return Object.freeze({
    id,
    threadId: threadId ?? expectedThreadId,
    historyId: historyId(source.historyId, `${path}.historyId`),
    internalDate: timestamp(source.internalDate, `${path}.internalDate`),
    labelIds,
    from: parseHeader(source.from, `${path}.from`),
    to: parseHeader(source.to, `${path}.to`),
    cc: parseHeader(source.cc, `${path}.cc`),
    bcc: parseHeader(source.bcc, `${path}.bcc`),
    subject: parseHeader(source.subject, `${path}.subject`),
    date: parseHeader(source.date, `${path}.date`),
    messageId: parseHeader(source.messageId, `${path}.messageId`),
    inReplyTo: parseHeader(source.inReplyTo, `${path}.inReplyTo`),
    text: body.text,
    bodyTruncated: body.truncated,
    originalBodyBytes: body.originalBytes,
    attachments: Object.freeze(array(source.attachments, `${path}.attachments`, 512)
      .map((entry, index) => parseAttachment(entry, `${path}.attachments[${index}]`, id))),
  });
}

function extractEmails(value: string | null): readonly string[] {
  if (value === null) return Object.freeze([]);
  const matches = value.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/gu) ?? [];
  return Object.freeze([...new Set(matches
    .filter((candidate) => isGmailAccountSubject(candidate))
    .map((candidate) => candidate.toLowerCase()))]);
}

function participant(email: string): OmniParticipantV1 {
  return Object.freeze({ providerId: email, displayName: null, handle: email });
}

function attachmentKind(mimeType: string): OmniAttachmentV1["kind"] {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

function materializedAttachment(value: ParsedAttachment): OmniAttachmentV1 {
  return Object.freeze({
    kind: attachmentKind(value.mimeType),
    mimeType: value.mimeType,
    name: value.filename,
    sizeBytes: value.size,
  });
}

function materializedMessage(value: ParsedMessage): ProviderMessageV1 {
  const senderEmail = extractEmails(value.from)[0];
  const recipientEmails = [...new Set([
    ...extractEmails(value.to),
    ...extractEmails(value.cc),
    ...extractEmails(value.bcc),
  ])];
  return Object.freeze({
    kind: "message",
    providerId: value.id,
    providerRevision: value.historyId,
    orderedAt: value.internalDate,
    conversationProviderId: value.threadId,
    sender: senderEmail === undefined ? null : participant(senderEmail),
    recipients: Object.freeze(recipientEmails.map(participant)),
    direction: value.labelIds.includes("SENT") ? "outgoing" : "incoming",
    subject: value.subject,
    body: value.text,
    bodyTruncated: value.bodyTruncated,
    unread: value.labelIds.includes("UNREAD"),
    replyToProviderId: null,
    state: "active",
    attachments: Object.freeze(value.attachments.map(materializedAttachment)),
  });
}

/** Strict full-thread normalization with message and attachment metadata only. */
export function materializeGmailMessagingRead(
  input: OperationInput,
  output: unknown,
): ProviderMaterializedPageV1 {
  const requestedThreadId = parseReadInput(input);
  const source = record(output, "messaging.read output");
  exactKeys(source, [
    "provider",
    "operation",
    "accountSubject",
    "thread",
    "threadUrl",
  ], [], "messaging.read output");
  if (source.provider !== "gmail") return drift("messaging.read output.provider", "must be gmail");
  if (source.operation !== "messaging.read") {
    return drift("messaging.read output.operation", "must be messaging.read");
  }
  const account = accountSubject(source.accountSubject, "messaging.read output.accountSubject");
  const thread = record(source.thread, "messaging.read output.thread");
  exactKeys(thread, ["id", "snippet", "historyId", "messages"], [], "messaging.read output.thread");
  const threadId = gmailId(thread.id, "messaging.read output.thread.id");
  if (threadId !== requestedThreadId) {
    return drift("messaging.read output.thread.id", "must bind messaging.read input.thread_id");
  }
  nullableString(thread.snippet, "messaging.read output.thread.snippet", 64 * 1024, true, true);
  historyId(thread.historyId, "messaging.read output.thread.historyId");
  parseThreadUrl(
    source.threadUrl,
    "messaging.read output.threadUrl",
    account,
    threadId,
    "all",
  );
  let aggregateBodyBytes = 0;
  const messages = Object.freeze(array(
    thread.messages,
    "messaging.read output.thread.messages",
    1_000,
  ).map((entry, index) => {
    const path = `messaging.read output.thread.messages[${index}]`;
    const parsed = parseMessage(entry, path, threadId);
    if (parsed.originalBodyBytes > GMAIL_AGGREGATE_BODY_BYTES - aggregateBodyBytes) {
      return drift(
        `${path}.body.text`,
        `causes the thread to exceed the ${GMAIL_AGGREGATE_BODY_BYTES}-byte Gmail aggregate body ceiling`,
      );
    }
    aggregateBodyBytes += parsed.originalBodyBytes;
    return parsed;
  }));
  if (messages.length === 0) {
    return drift("messaging.read output.thread.messages", "must contain at least one message");
  }
  const ids = messages.map((message) => message.id);
  if (new Set(ids).size !== ids.length) {
    return drift("messaging.read output.thread.messages", "contains duplicate stable message IDs");
  }
  return Object.freeze({
    schemaVersion: 1,
    partition: `${account.toLowerCase()}:gmail:thread:${threadId}`,
    completeness: Object.freeze({
      kind: "complete",
      reason: "Gmail returned the complete full-MIME representation of the exact requested thread.",
    }),
    cursor: Object.freeze({ direction: "none", request: null, nextInput: null }),
    entities: Object.freeze(messages.map(materializedMessage)),
    tombstones: Object.freeze([]),
  });
}
