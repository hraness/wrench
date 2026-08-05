import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";
import type { ProviderActionContext } from "../provider-context";
import {
  buildGmailThreadUrl,
  createGmailApiClient,
  extractGmailEmailAddresses,
  fetchGmailContacts,
  fetchGmailMessageList,
  fetchGmailMessageMetadata,
  fetchGmailThread,
  fetchGmailThreadList,
  fetchGmailThreadMetadata,
  getAuthenticatedGmailProfile,
  parseGmailId,
  parseGmailThread,
  resolveGmailThreadBodies,
  type GmailApiClient,
  type GmailContact,
  type GmailProfile,
  type GmailThread,
} from "./gmail-api";

const CONTACTS_DEFAULT_LIMIT = 20;
const CONTACTS_MAX_LIMIT = 100;
const CONTACTS_DEFAULT_STATS_SCAN_LIMIT = 100;
const CONTACTS_MAX_STATS_SCAN_LIMIT = 2_000;
const CONTACT_STATS_MAX_DIRECTION_PRODUCT = 2_000;
const MESSAGING_DEFAULT_LIMIT = 50;
const MESSAGING_MAX_LIMIT = 100;
const GMAIL_LIST_PAGE_MAXIMUM = 500;
const CONTACT_STATS_QUERY_MAX_BYTES = 4_096;
const MAX_CONCURRENT_GMAIL_READS = 4;
const GMAIL_MESSAGING_READ_BODY_BYTES = 7 * 1024 * 1024;

type JsonRecord = Readonly<Record<string, unknown>>;
type GmailListView = "inbox" | "search";
type ContactDirection = "sent" | "received";

type ParsedContactsInput = Readonly<{
  cursor: string | null;
  limit: number;
  statsScanLimit: number;
}>;

type ParsedMessagingListInput = Readonly<{
  view: GmailListView;
  query: string | null;
  cursor: string | null;
  limit: number;
  includeSpamTrash: boolean;
}>;

type DirectionStats = Readonly<{
  count: number;
  complete: boolean;
  lowerBound: boolean;
  truncated: boolean;
  lastAt: string | null;
  lastAtComplete: boolean;
  lastAtBasis: "bounded-matched-message-internal-date" | "unavailable";
  incompleteReasons: readonly (
    | "message-internal-date-unavailable"
    | "no-contact-addresses"
    | "scan-limit-reached"
    | "unsupported-contact-addresses"
  )[];
}>;

type ContactEmailCoverage = Readonly<{
  emails: readonly string[];
  kind: "complete" | "partial" | "unavailable" | "unsupported";
  unsupportedAddressCount: number;
}>;

type ConcurrentAdmission = <T>(action: () => Promise<T>) => Promise<T>;

export type GmailThreadSummary = Readonly<{
  id: string;
  historyId: string | null;
  snippet: string | null;
  subject: string | null;
  orderedAt: string | null;
  messageCount: number;
  participants: readonly Readonly<{
    email: string;
    displayName: null;
  }>[];
  unread: boolean;
  archived: boolean | null;
  threadUrl: string;
  readInput: Readonly<{ thread_id: string }>;
}>;

export type GmailMessagingListOutput = Readonly<{
  provider: "gmail";
  operation: "messaging.list";
  accountSubject: string;
  view: GmailListView;
  query: string | null;
  includeSpamTrash: boolean;
  threads: readonly GmailThreadSummary[];
  nextCursor: string | null;
  resultSizeEstimate: number;
}>;

export type GmailMessagingReadOutput = Readonly<{
  provider: "gmail";
  operation: "messaging.read";
  accountSubject: string;
  thread: GmailThread;
  threadUrl: string;
}>;

function fail(label: string, message: string): never {
  throw new Error(`official Gmail ${label} ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    nodeTypes.isProxy(value)
    || typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(label, "must be a plain object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(label, "must not contain symbol properties");
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}.${key}`, "must be an enumerable data property");
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return fail(label, `contains unreviewed property ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return fail(`${label}.${key}`, "is required");
  }
}

function hasUnsafeControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x1f
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

function boundedInputText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || !isWellFormedText(value)
    || hasUnsafeControl(value)
  ) return fail(label, `must be non-empty text of at most ${maximum} code units without unsafe controls`);
  return value;
}

function optionalInputText(value: unknown, label: string, maximum: number): string | null {
  return value === undefined ? null : boundedInputText(value, label, maximum);
}

function inputInteger(
  value: unknown,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? fallback : value;
  if (
    typeof candidate !== "number"
    || !Number.isSafeInteger(candidate)
    || candidate < minimum
    || candidate > maximum
  ) return fail(label, `must be an integer from ${minimum} through ${maximum}`);
  return candidate;
}

function parseContactsInput(input: OperationInput): ParsedContactsInput {
  const source = record(input, "contacts.list input");
  exactKeys(source, [], ["cursor", "limit", "stats_scan_limit"], "contacts.list input");
  const limit = inputInteger(
      source.limit,
      "contacts.list input.limit",
      CONTACTS_DEFAULT_LIMIT,
      1,
      CONTACTS_MAX_LIMIT,
    );
  const statsScanLimit = inputInteger(
      source.stats_scan_limit,
      "contacts.list input.stats_scan_limit",
      CONTACTS_DEFAULT_STATS_SCAN_LIMIT,
      1,
      CONTACTS_MAX_STATS_SCAN_LIMIT,
    );
  if (limit * statsScanLimit > CONTACT_STATS_MAX_DIRECTION_PRODUCT) {
    return fail(
      "contacts.list input",
      `limit multiplied by stats_scan_limit must not exceed the ${CONTACT_STATS_MAX_DIRECTION_PRODUCT}-entry per-direction work budget`,
    );
  }
  return Object.freeze({
    cursor: optionalInputText(source.cursor, "contacts.list input.cursor", 4_096),
    limit,
    statsScanLimit,
  });
}

function parseMessagingListInput(input: OperationInput): ParsedMessagingListInput {
  const source = record(input, "messaging.list input");
  exactKeys(source, ["view"], [
    "query",
    "cursor",
    "limit",
    "include_spam_trash",
  ], "messaging.list input");
  if (source.view !== "inbox" && source.view !== "search") {
    return fail("messaging.list input.view", "must be inbox or search");
  }
  const query = optionalInputText(source.query, "messaging.list input.query", 512);
  if (source.view === "search" && query === null) {
    return fail("messaging.list input.query", "is required when view is search");
  }
  if (source.view === "inbox" && query !== null) {
    return fail("messaging.list input.query", "is not accepted when view is inbox");
  }
  if (query !== null && query.trim().length === 0) {
    return fail("messaging.list input.query", "must contain a non-whitespace expression");
  }
  const includeSpamTrash = source.include_spam_trash === undefined
    ? false
    : source.include_spam_trash;
  if (typeof includeSpamTrash !== "boolean") {
    return fail("messaging.list input.include_spam_trash", "must be boolean");
  }
  if (source.view === "inbox" && source.include_spam_trash !== undefined) {
    return fail(
      "messaging.list input.include_spam_trash",
      "is accepted only when view is search",
    );
  }
  return Object.freeze({
    view: source.view,
    query,
    cursor: optionalInputText(source.cursor, "messaging.list input.cursor", 4_096),
    limit: inputInteger(
      source.limit,
      "messaging.list input.limit",
      MESSAGING_DEFAULT_LIMIT,
      1,
      MESSAGING_MAX_LIMIT,
    ),
    includeSpamTrash,
  });
}

function parseMessagingReadInput(input: OperationInput): string {
  const source = record(input, "messaging.read input");
  exactKeys(source, ["thread_id"], [], "messaging.read input");
  return parseGmailId(source.thread_id, "messaging.read input.thread_id");
}

async function authenticatedClient(context: ProviderActionContext): Promise<{
  readonly client: GmailApiClient;
  readonly profile: GmailProfile;
}> {
  if (context.auth.subject === undefined) {
    throw new Error("official Gmail reads require an OAuth locator with an exact email subject");
  }
  const client = createGmailApiClient({
    http: context.http,
    accessToken: context.token.accessToken,
    subject: context.auth.subject,
  });
  const profile = await getAuthenticatedGmailProfile(client);
  return Object.freeze({ client, profile });
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  maximum: number,
  worker: (
    value: T,
    index: number,
    admit: ConcurrentAdmission,
  ) => Promise<R>,
): Promise<readonly R[]> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Gmail concurrent mapping requires a positive worker bound");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const noFailure = Symbol("no Gmail concurrent failure");
  let firstFailure: unknown = noFailure;
  const rememberFailure = (error: unknown): void => {
    if (firstFailure === noFailure) firstFailure = error;
  };
  const admit: ConcurrentAdmission = async <V>(action: () => Promise<V>): Promise<V> => {
    if (firstFailure !== noFailure) throw firstFailure;
    try {
      return await action();
    } catch (error) {
      rememberFailure(error);
      throw error;
    }
  };
  const run = async (): Promise<void> => {
    while (firstFailure === noFailure && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        rememberFailure(new Error("Gmail concurrent mapping lost a dense input item"));
        return;
      }
      try {
        results[index] = await worker(value, index, admit);
      } catch (error) {
        rememberFailure(error);
        return;
      }
    }
  };
  const settlements = await Promise.allSettled(Array.from(
    { length: Math.min(maximum, values.length) },
    () => run(),
  ));
  for (const settlement of settlements) {
    if (settlement.status === "rejected") rememberFailure(settlement.reason);
  }
  if (firstFailure !== noFailure) throw firstFailure;
  return Object.freeze(results);
}

function contactEmailCoverage(contact: GmailContact): ContactEmailCoverage {
  const emails = Object.freeze([...new Set(contact.emailAddresses.flatMap((email) =>
    email.canonicalValue === null ? [] : [email.canonicalValue]))]);
  const unsupportedAddressCount = contact.emailAddresses.reduce(
    (count, email) => count + (email.canonicalValue === null ? 1 : 0),
    0,
  );
  return Object.freeze({
    emails,
    kind: contact.emailAddresses.length === 0
      ? "unavailable"
      : emails.length === 0
        ? "unsupported"
        : unsupportedAddressCount === 0
          ? "complete"
          : "partial",
    unsupportedAddressCount,
  });
}

function contactQuery(direction: ContactDirection, emails: readonly string[]): string {
  const terms = direction === "received"
    ? emails.map((email) => `from:"${email}"`)
    : emails.flatMap((email) => [`to:"${email}"`, `cc:"${email}"`, `bcc:"${email}"`]);
  const prefix = direction === "received" ? "-in:sent " : "in:sent ";
  return `${prefix}{${terms.join(" ")}}`;
}

function contactQueryChunks(
  direction: ContactDirection,
  emails: readonly string[],
): readonly string[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const email of emails) {
    const candidate = [...current, email];
    if (
      current.length > 0
      && Buffer.byteLength(contactQuery(direction, candidate), "utf8") > CONTACT_STATS_QUERY_MAX_BYTES
    ) {
      chunks.push(current);
      current = [email];
    } else current = candidate;
    if (Buffer.byteLength(contactQuery(direction, current), "utf8") > CONTACT_STATS_QUERY_MAX_BYTES) {
      return fail("contacts.list stats query", "cannot represent one validated contact address within the query bound");
    }
  }
  if (current.length > 0) chunks.push(current);
  return Object.freeze(chunks.map((chunk) => contactQuery(direction, chunk)));
}

async function scanContactDirection(
  client: GmailApiClient,
  addressCoverage: ContactEmailCoverage,
  direction: ContactDirection,
  scanLimit: number,
  admit: ConcurrentAdmission,
): Promise<DirectionStats> {
  const queries = contactQueryChunks(direction, addressCoverage.emails);
  if (queries.length === 0) {
    const addressCoverageComplete = addressCoverage.kind === "complete";
    const incompleteReasons: DirectionStats["incompleteReasons"] = addressCoverageComplete
      ? Object.freeze([])
      : addressCoverage.kind === "unavailable"
        ? Object.freeze(["no-contact-addresses"] as const)
        : Object.freeze(["unsupported-contact-addresses"] as const);
    return Object.freeze({
      count: 0,
      complete: addressCoverageComplete,
      lowerBound: !addressCoverageComplete,
      truncated: false,
      lastAt: null,
      lastAtComplete: addressCoverageComplete,
      lastAtBasis: "unavailable",
      incompleteReasons,
    });
  }
  const messageIds = new Set<string>();
  let scannedEntries = 0;
  let complete = true;
  for (const [queryIndex, query] of queries.entries()) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    while (scannedEntries < scanLimit) {
      const pageLimit = Math.min(GMAIL_LIST_PAGE_MAXIMUM, scanLimit - scannedEntries);
      const page = await admit(() => fetchGmailMessageList(client, {
        limit: pageLimit,
        pageToken: cursor,
        query,
        includeSpamTrash: false,
      }));
      if (page.messages.length === 0 && page.nextPageToken !== null) {
        return fail("contacts.list stats pagination", "returned an empty non-terminal page");
      }
      scannedEntries += page.messages.length;
      for (const message of page.messages) messageIds.add(message.id);
      if (page.nextPageToken === null) break;
      if (seenCursors.has(page.nextPageToken)) {
        return fail("contacts.list stats pagination", "repeated a page token");
      }
      seenCursors.add(page.nextPageToken);
      cursor = page.nextPageToken;
      if (scannedEntries >= scanLimit) {
        complete = false;
        break;
      }
    }
    if (scannedEntries >= scanLimit && queryIndex < queries.length - 1) complete = false;
    if (!complete) break;
  }
  let lastAt: string | null = null;
  let metadataDatesComplete = true;
  for (const messageId of messageIds) {
    const message = await admit(() => fetchGmailMessageMetadata(client, messageId));
    if (message.id !== messageId) {
      return fail("contacts.list stats metadata", "returned a message other than the requested ID");
    }
    if (message.internalDate === null) metadataDatesComplete = false;
    else if (lastAt === null || message.internalDate > lastAt) {
      lastAt = message.internalDate;
    }
  }
  const addressCoverageComplete = addressCoverage.kind === "complete";
  const countComplete = complete && addressCoverageComplete;
  const lastAtComplete = countComplete && metadataDatesComplete;
  const incompleteReasons: DirectionStats["incompleteReasons"] = Object.freeze([
    ...(addressCoverageComplete ? [] : ["unsupported-contact-addresses" as const]),
    ...(complete ? [] : ["scan-limit-reached" as const]),
    ...(metadataDatesComplete ? [] : ["message-internal-date-unavailable" as const]),
  ]);
  return Object.freeze({
    count: messageIds.size,
    complete: countComplete,
    lowerBound: !countComplete,
    truncated: !complete,
    lastAt,
    lastAtComplete,
    lastAtBasis: lastAt === null ? "unavailable" : "bounded-matched-message-internal-date",
    incompleteReasons,
  });
}

function contactWithStats(
  contact: GmailContact,
  sent: DirectionStats,
  received: DirectionStats,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...contact,
    sentCount: sent.count,
    sentCountComplete: sent.complete,
    sentCountLowerBound: sent.lowerBound,
    sentCountTruncated: sent.truncated,
    receivedCount: received.count,
    receivedCountComplete: received.complete,
    receivedCountLowerBound: received.lowerBound,
    receivedCountTruncated: received.truncated,
    lastSentAt: sent.lastAt,
    lastSentAtComplete: sent.lastAtComplete,
    lastSentAtBasis: sent.lastAtBasis,
    sentStatsIncompleteReasons: sent.incompleteReasons,
    lastReceivedAt: received.lastAt,
    lastReceivedAtComplete: received.lastAtComplete,
    lastReceivedAtBasis: received.lastAtBasis,
    receivedStatsIncompleteReasons: received.incompleteReasons,
  });
}

async function executeContactsList(context: ProviderActionContext): Promise<void> {
  const input = parseContactsInput(context.input);
  const { client, profile } = await authenticatedClient(context);
  const page = await fetchGmailContacts(client, {
    limit: input.limit,
    pageToken: input.cursor,
  });
  const tasks = page.contacts.flatMap((contact) => {
    const addressCoverage = contactEmailCoverage(contact);
    return (["sent", "received"] as const).map((direction) => Object.freeze({
      addressCoverage,
      resourceName: contact.resourceName,
      direction,
    }));
  });
  const stats = await mapConcurrent(
    tasks,
    MAX_CONCURRENT_GMAIL_READS,
    async (task, _index, admit) => Object.freeze({
      resourceName: task.resourceName,
      direction: task.direction,
      stats: await scanContactDirection(
        client,
        task.addressCoverage,
        task.direction,
        input.statsScanLimit,
        admit,
      ),
    }),
  );
  const byContact = new Map<string, Partial<Record<ContactDirection, DirectionStats>>>();
  for (const entry of stats) {
    const current = byContact.get(entry.resourceName) ?? {};
    current[entry.direction] = entry.stats;
    byContact.set(entry.resourceName, current);
  }
  const contacts = page.contacts.map((contact) => {
    const values = byContact.get(contact.resourceName);
    if (values?.sent === undefined || values.received === undefined) {
      return fail("contacts.list stats", "did not settle both directions for one contact");
    }
    const addressCoverage = contactEmailCoverage(contact);
    return Object.freeze({
      ...contactWithStats(contact, values.sent, values.received),
      statsAddressCoverage: addressCoverage.kind,
      statsSupportedAddressCount: addressCoverage.emails.length,
      statsUnsupportedAddressCount: addressCoverage.unsupportedAddressCount,
    });
  });
  context.setOutput(Object.freeze({
    provider: "gmail",
    operation: "contacts.list",
    accountSubject: profile.emailAddress,
    contacts: Object.freeze(contacts),
    nextCursor: page.nextPageToken,
    totalItems: page.totalItems,
    statsScanLimit: input.statsScanLimit,
    statsScope: "per-contact-gmail-search-excluding-spam-trash",
  }));
}

function threadOrderedAt(thread: GmailThread): string | null {
  let result: string | null = null;
  for (const message of thread.messages) {
    if (message.internalDate !== null && (result === null || message.internalDate > result)) {
      result = message.internalDate;
    }
  }
  return result;
}

function threadParticipants(
  thread: GmailThread,
  accountSubject: string,
): GmailThreadSummary["participants"] {
  const account = accountSubject.toLowerCase();
  const emails = new Set<string>();
  for (const message of thread.messages) {
    for (const header of [message.from, message.to, message.cc, message.bcc]) {
      for (const email of extractGmailEmailAddresses(header)) {
        if (email !== account) emails.add(email);
      }
    }
  }
  return Object.freeze([...emails].sort().map((email) => Object.freeze({
    email,
    displayName: null,
  })));
}

function summarizeThread(
  thread: GmailThread,
  accountSubject: string,
  view: GmailListView,
): GmailThreadSummary {
  const labels = new Set(thread.messages.flatMap((message) => message.labelIds));
  const archived = labels.has("INBOX")
    ? false
    : labels.has("SPAM") || labels.has("TRASH")
      ? null
      : true;
  return Object.freeze({
    id: thread.id,
    historyId: thread.historyId,
    snippet: thread.snippet,
    subject: thread.messages.find((message) => message.subject !== null)?.subject ?? null,
    orderedAt: threadOrderedAt(thread),
    messageCount: thread.messages.length,
    participants: threadParticipants(thread, accountSubject),
    unread: labels.has("UNREAD"),
    archived,
    threadUrl: buildGmailThreadUrl(
      accountSubject,
      thread.id,
      view === "inbox" ? "inbox" : "all",
    ),
    readInput: Object.freeze({ thread_id: thread.id }),
  });
}

async function executeMessagingList(context: ProviderActionContext): Promise<void> {
  const input = parseMessagingListInput(context.input);
  const { client, profile } = await authenticatedClient(context);
  const page = await fetchGmailThreadList(client, {
    limit: input.limit,
    pageToken: input.cursor,
    query: input.query,
    labelIds: input.view === "inbox" ? ["INBOX"] : [],
    includeSpamTrash: input.includeSpamTrash,
  });
  const threads = await mapConcurrent(
    page.threads,
    MAX_CONCURRENT_GMAIL_READS,
    async (stub, _index, admit) => {
      const thread = parseGmailThread(
        await admit(() => fetchGmailThreadMetadata(client, stub.id)),
        { deadlineCheckpoint: () => client.http.throwIfUnavailable() },
      );
      if (thread.id !== stub.id) {
        return fail("messaging.list metadata", "returned a thread other than the requested ID");
      }
      return summarizeThread(thread, profile.emailAddress, input.view);
    },
  );
  const output: GmailMessagingListOutput = Object.freeze({
    provider: "gmail",
    operation: "messaging.list",
    accountSubject: profile.emailAddress,
    view: input.view,
    query: input.query,
    includeSpamTrash: input.includeSpamTrash,
    threads,
    nextCursor: page.nextPageToken,
    resultSizeEstimate: page.resultSizeEstimate,
  });
  context.setOutput(output);
}

async function executeMessagingRead(context: ProviderActionContext): Promise<void> {
  const threadId = parseMessagingReadInput(context.input);
  const { client, profile } = await authenticatedClient(context);
  const parsedThread = parseGmailThread(
    await fetchGmailThread(client, threadId),
    {
      maxBodyBytes: GMAIL_MESSAGING_READ_BODY_BYTES,
      deadlineCheckpoint: () => client.http.throwIfUnavailable(),
    },
  );
  const thread = await resolveGmailThreadBodies(client, parsedThread);
  if (thread.id !== threadId) {
    return fail("messaging.read response", "returned a thread other than the requested ID");
  }
  if (thread.messages.length === 0) {
    return fail("messaging.read response.messages", "must contain at least one message");
  }
  const threadUrl = buildGmailThreadUrl(profile.emailAddress, thread.id);
  const output: GmailMessagingReadOutput = Object.freeze({
    provider: "gmail",
    operation: "messaging.read",
    accountSubject: profile.emailAddress,
    thread,
    threadUrl,
  });
  context.setOutput(output);
  context.setFinalUrl(threadUrl);
}

/** Execute one reviewed official Gmail or People read without acknowledgement mutation. */
export async function executeGmailProvider(context: ProviderActionContext): Promise<void> {
  const action = context.recipe.action;
  if (action === "contacts.list") await executeContactsList(context);
  else if (action === "messaging.list") await executeMessagingList(context);
  else if (action === "messaging.read") await executeMessagingRead(context);
  else throw new Error(`official Gmail provider does not implement ${action}`);
}
