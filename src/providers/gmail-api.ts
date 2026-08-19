import { types as nodeTypes } from "node:util";

import { bearerHeaders, type ProviderHttpClient } from "../provider-http";
import { isGmailAccountSubject } from "../provider-subject";

const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";
const GMAIL_API_HOSTS = ["gmail.googleapis.com"] as const;
const PEOPLE_API_ORIGIN = "https://people.googleapis.com";
const PEOPLE_API_HOSTS = ["people.googleapis.com"] as const;
const GMAIL_WEB_ORIGIN = "https://mail.google.com";
const MAX_RESPONSE_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_DIRECT_BODY_BYTES = 7 * 1024 * 1024;
const MAX_MIME_PARTS = 10_000;
const MAX_MIME_DEPTH = 32;
const MAX_MIME_ATTACHMENTS = 512;
const MAX_HEADERS = 2_048;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ATTACHMENT_RESPONSE_ENVELOPE_BYTES = 32 * 1024;
const HTML_DEADLINE_CHECKPOINT_CODE_UNITS = 4_096;

const GMAIL_PROFILE_FIELDS = "emailAddress,messagesTotal,threadsTotal,historyId";
const GMAIL_SEND_AS_FIELDS = "sendAs(sendAsEmail,verificationStatus)";
const GMAIL_THREAD_LIST_FIELDS = "threads(id,snippet,historyId),nextPageToken,resultSizeEstimate";
const GMAIL_MESSAGE_LIST_FIELDS = "messages(id,threadId),nextPageToken,resultSizeEstimate";
const GMAIL_MESSAGE_FIELDS = "id,threadId,labelIds,snippet,historyId,internalDate,payload(partId,mimeType,filename,headers(name,value),body(attachmentId,size,data),parts),sizeEstimate";
const GMAIL_INTERACTION_MESSAGE_FIELDS = "id,threadId,labelIds,internalDate,payload(headers(name,value))";
const GMAIL_THREAD_FIELDS = `id,snippet,historyId,messages(${GMAIL_MESSAGE_FIELDS})`;
const GMAIL_ATTACHMENT_FIELDS = "attachmentId,size,data";
const PEOPLE_CONNECTION_LIST_FIELDS = "connections(resourceName),nextPageToken,totalItems";
const PEOPLE_CORE_PERSON_FIELDS = "metadata,names,emailAddresses,phoneNumbers,organizations,photos";
const PEOPLE_DATES_PERSON_FIELDS = `${PEOPLE_CORE_PERSON_FIELDS},birthdays,events`;
const PEOPLE_CORE_PERSON_PROJECTION = "resourceName,etag,metadata(sources(type,id,etag,updateTime),deleted),names(displayName,givenName,familyName,metadata(primary,sourcePrimary,verified,source(type,id))),emailAddresses(value,type,metadata(primary,sourcePrimary,verified,source(type,id))),phoneNumbers(value,type,canonicalForm,metadata(primary,sourcePrimary,verified,source(type,id))),organizations(name,title,department,type,current),photos(url,default)";
const PEOPLE_DATES_PERSON_PROJECTION = "resourceName,etag,metadata(sources(type,id,etag,updateTime),deleted),names(displayName,givenName,middleName,familyName,honorificPrefix,honorificSuffix,metadata(primary,sourcePrimary,verified,source(type,id))),emailAddresses(value,type,metadata(primary,sourcePrimary,verified,source(type,id))),phoneNumbers(value,type,canonicalForm,metadata(primary,sourcePrimary,verified,source(type,id))),organizations(name,title,department,type,current),photos(url,default),birthdays(date(year,month,day),text,metadata(primary,sourcePrimary,verified,source(type,id))),events(date(year,month,day),type,formattedType,metadata(primary,sourcePrimary,verified,source(type,id)))";
const PEOPLE_OTHER_PERSON_PROJECTION = "resourceName,etag,metadata(sources(type,id,etag,updateTime),deleted),names(displayName,givenName,familyName,metadata(primary,sourcePrimary,verified,source(type,id))),emailAddresses(value,type,metadata(primary,sourcePrimary,verified,source(type,id))),phoneNumbers(value,type,canonicalForm,metadata(primary,sourcePrimary,verified,source(type,id))),photos(url,default)";
const PEOPLE_OTHER_LIST_FIELDS = `otherContacts(${PEOPLE_OTHER_PERSON_PROJECTION}),nextPageToken,totalSize`;

const inlineAttachmentBytes = new WeakMap<GmailAttachment, Uint8Array>();
const parsedThreadBodies = new WeakMap<GmailThread, ParsedThreadBodyState>();

type JsonRecord = Readonly<Record<string, unknown>>;

export type GmailApiClient = Readonly<{
  http: ProviderHttpClient;
  accessToken: string;
  /** Canonical Gmail email address declared by the OAuth locator. */
  subject: string;
}>;

export type GmailProfile = Readonly<{
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}>;

/** List every configured primary or custom send-as address for self exclusion. */
export async function listGmailSendAsAliases(
  client: GmailApiClient,
  maximumResponseBytes?: number,
): Promise<readonly string[]> {
  const url = gmailUrl("/gmail/v1/users/me/settings/sendAs");
  url.searchParams.set("fields", GMAIL_SEND_AS_FIELDS);
  const source = record(
    await gmailGet(client, url, maximumResponseBytes),
    "send-as aliases response",
  );
  exactKeys(source, ["sendAs"], [], "send-as aliases response");
  if (!Array.isArray(source.sendAs) || source.sendAs.length < 1 || source.sendAs.length > 100) {
    return fail("send-as aliases response.sendAs", "must contain 1-100 aliases");
  }
  const aliases = new Set<string>();
  for (const [index, value] of source.sendAs.entries()) {
    const alias = record(value, `send-as aliases response.sendAs[${index}]`);
    exactKeys(
      alias,
      ["sendAsEmail"],
      ["verificationStatus"],
      `send-as aliases response.sendAs[${index}]`,
    );
    const email = text(
      alias.sendAsEmail,
      `send-as aliases response.sendAs[${index}].sendAsEmail`,
      254,
    ).toLowerCase();
    if (!isGmailAccountSubject(email)) {
      return fail(
        `send-as aliases response.sendAs[${index}].sendAsEmail`,
        "must be an exact email address",
      );
    }
    if (
      alias.verificationStatus !== undefined
      && alias.verificationStatus !== "accepted"
      && alias.verificationStatus !== "pending"
      && alias.verificationStatus !== "verificationStatusUnspecified"
    ) {
      return fail(
        `send-as aliases response.sendAs[${index}].verificationStatus`,
        "is unsupported",
      );
    }
    aliases.add(email);
  }
  if (!aliases.has(client.subject.toLowerCase())) {
    return fail("send-as aliases response", "does not contain the authenticated subject");
  }
  return Object.freeze([...aliases].sort());
}

export type GmailThreadView = "all" | "inbox";

export type ParsedGmailThreadUrl = Readonly<{
  accountLocator: string;
  /** Canonical navigation view. Non-inbox source views normalize to all. */
  view: GmailThreadView;
  /** Exact reviewed source-view prefix observed in the copied URL. */
  sourceView?: string;
  threadId: string;
  canonicalUrl: string;
}>;

export type GmailAttachment = Readonly<{
  attachmentId: string | null;
  /** Exact Gmail MIME-part identity, unique within its parent message. */
  partId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  /** Validated and case-normalized MIME disposition type, when declared. */
  contentDisposition: "attachment" | "inline" | null;
  size: number;
}>;

export type GmailThreadParseOptions = Readonly<{
  /** Root is depth zero. The reviewed implementation permits at most 32. */
  maxDepth?: number;
  /** Aggregate decoded MIME and render-safe UTF-8 body bytes across the thread. */
  maxBodyBytes?: number;
  /** Synchronous operation-deadline checkpoint used during bounded MIME/HTML projection. */
  deadlineCheckpoint?: () => void;
}>;

/** One bounded render-safe body projection with an explicit MIME basis. */
export type GmailBodyProjection = Readonly<{
  text: string | null;
  source: "text/plain" | "text/html" | "none";
}>;

export type GmailMessage = Readonly<{
  id: string;
  threadId: string | null;
  historyId: string | null;
  internalDate: string | null;
  labelIds: readonly string[];
  snippet: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  body: GmailBodyProjection;
  attachments: readonly GmailAttachment[];
}>;

export type GmailThread = Readonly<{
  id: string;
  snippet: string | null;
  historyId: string | null;
  messages: readonly GmailMessage[];
}>;

export type GmailThreadStub = Readonly<{
  id: string;
  snippet: string | null;
  historyId: string | null;
}>;

export type GmailMessageStub = Readonly<{
  id: string;
  threadId: string | null;
}>;

export type GmailThreadListPage = Readonly<{
  threads: readonly GmailThreadStub[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}>;

export type GmailMessageListPage = Readonly<{
  messages: readonly GmailMessageStub[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}>;

export type GmailContact = Readonly<{
  resourceName: string;
  etag: string | null;
  metadata: Readonly<{
    deleted: boolean | null;
    sources: readonly GmailContactSource[];
  }> | null;
  displayName: string | null;
  name?: Readonly<{
    displayName: string | null;
    givenName: string | null;
    middleName: string | null;
    familyName: string | null;
    honorificPrefix: string | null;
    honorificSuffix: string | null;
    metadata: GmailContactFieldMetadata | null;
  }> | null;
  emailAddresses: readonly Readonly<{
    /** Exact People API value retained for display and audit. */
    value: string;
    /** Case-folded validated address used only for dedupe and Gmail search. */
    canonicalValue: string | null;
    type: string | null;
    metadata: GmailContactFieldMetadata | null;
  }>[];
  phoneNumbers: readonly Readonly<{
    value: string;
    canonicalForm: string | null;
    type: string | null;
    metadata: GmailContactFieldMetadata | null;
  }>[];
  organizations: readonly Readonly<{
    name: string | null;
    title: string | null;
    department: string | null;
    type: string | null;
    current: boolean | null;
  }>[];
  photoUrl: string | null;
  birthdays?: readonly GmailContactDate[];
  events?: readonly Readonly<GmailContactDate & {
    type: string | null;
    formattedType: string | null;
  }>[];
}>;

export type GmailContactDate = Readonly<{
  date: Readonly<{
    year: number;
    month: number;
    day: number;
  }> | null;
  text: string | null;
  metadata: GmailContactFieldMetadata | null;
}>;

export type GmailContactSource = Readonly<{
  type: "SOURCE_TYPE_UNSPECIFIED" | "ACCOUNT" | "PROFILE" | "DOMAIN_PROFILE" | "CONTACT" | "OTHER_CONTACT" | "DOMAIN_CONTACT";
  id: string;
  etag: string | null;
  updateTime: string | null;
}>;

export type GmailContactFieldMetadata = Readonly<{
  primary: boolean | null;
  sourcePrimary: boolean | null;
  verified: boolean | null;
  source: Readonly<Pick<GmailContactSource, "type" | "id">> | null;
}>;

export type GmailContactPage = Readonly<{
  contacts: readonly GmailContact[];
  nextPageToken: string | null;
  totalItems: number | null;
}>;

export type GmailContactCollection = "contacts" | "other-contacts";
export type GmailContactProjection = "core" | "dates";

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

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum
  ) return fail(label, `must be a dense array of at most ${maximum} items`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = new Set<PropertyKey>([
    "length",
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(descriptors).length !== expected.size
    || Reflect.ownKeys(descriptors).some((key) => !expected.has(key))
  ) return fail(label, "must be a dense array without named properties");
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || !descriptor.enumerable
    ) return fail(`${label}[${index}]`, "must be an enumerable data property");
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

function text(
  value: unknown,
  label: string,
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
  ) return fail(label, "must be bounded text without unsafe controls");
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
  allowLayout = false,
): string | null {
  return value === undefined
    ? null
    : text(value, label, maximum, allowEmpty, allowLayout);
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return fail(label, `must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function optionalInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null {
  return value === undefined ? null : integer(value, label, minimum, maximum);
}

function historyId(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[0-9]{1,64}$/u.test(result)) return fail(label, "must be a decimal history ID");
  return result;
}

function optionalHistoryId(value: unknown, label: string): string | null {
  return value === undefined ? null : historyId(value, label);
}

export function parseGmailId(value: unknown, label = "ID"): string {
  const result = text(value, label, 256);
  if (!/^[A-Za-z0-9_-]{1,256}$/u.test(result)) {
    return fail(label, "must be an exact bounded Gmail ID");
  }
  return result;
}

export function parseGmailAttachmentId(value: unknown, label = "attachment ID"): string {
  return text(value, label, 4_096);
}

function pageToken(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || !isWellFormedText(value)
    || hasUnsafeControl(value)
  ) return fail(label, "must be bounded text without unsafe controls");
  return value;
}

function optionalPageToken(value: unknown, label: string): string | null {
  return value === undefined ? null : pageToken(value, label);
}

function encodedPathSegment(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
}

function gmailUrl(path: string): URL {
  return new URL(path, GMAIL_API_ORIGIN);
}

function peopleUrl(path: string): URL {
  return new URL(path, PEOPLE_API_ORIGIN);
}

function apiHeaders(client: GmailApiClient): Headers {
  return bearerHeaders(client.accessToken, { Accept: "application/json" });
}

async function gmailGet(
  client: GmailApiClient,
  url: URL,
  maximumResponseBytes?: number,
): Promise<unknown> {
  const response = await client.http.request(
    url,
    { method: "GET", headers: apiHeaders(client) },
    [200],
    GMAIL_API_HOSTS,
    maximumResponseBytes,
    "application/json",
  );
  return response.body;
}

async function peopleGet(client: GmailApiClient, url: URL): Promise<unknown> {
  const response = await client.http.request(
    url,
    { method: "GET", headers: apiHeaders(client) },
    [200],
    PEOPLE_API_HOSTS,
    undefined,
    "application/json",
  );
  return response.body;
}

/** Create a context-independent official Gmail/People API client. */
export function createGmailApiClient(input: {
  readonly http: ProviderHttpClient;
  readonly accessToken: string;
  readonly subject: string;
}): GmailApiClient {
  if (!(input.http && typeof input.http.request === "function")) {
    throw new Error("official Gmail API client requires a ProviderHttpClient");
  }
  if (
    typeof input.accessToken !== "string"
    || Buffer.byteLength(input.accessToken, "utf8") < 8
    || Buffer.byteLength(input.accessToken, "utf8") > 16 * 1024
    || [...input.accessToken].some((character) => {
      const code = character.codePointAt(0) ?? -1;
      return code <= 0x20 || code === 0x7f;
    })
  ) throw new Error("official Gmail API client requires a bounded access token");
  if (!isGmailAccountSubject(input.subject)) {
    throw new Error("official Gmail API client subject must be an exact Gmail email address");
  }
  return Object.freeze({
    http: input.http,
    accessToken: input.accessToken,
    subject: input.subject,
  });
}

/** Naming-compatible alias for capture consumers that immediately run profile preflight. */
export const createAuthenticatedGmailClient = createGmailApiClient;

function parseGmailProfile(value: unknown): GmailProfile {
  const source = record(value, "profile response");
  exactKeys(source, [
    "emailAddress",
    "messagesTotal",
    "threadsTotal",
    "historyId",
  ], [], "profile response");
  const emailAddress = text(source.emailAddress, "profile response.emailAddress", 254);
  if (!isGmailAccountSubject(emailAddress)) {
    return fail("profile response.emailAddress", "must be an exact Gmail email address");
  }
  return Object.freeze({
    emailAddress,
    messagesTotal: integer(source.messagesTotal, "profile response.messagesTotal"),
    threadsTotal: integer(source.threadsTotal, "profile response.threadsTotal"),
    historyId: historyId(source.historyId, "profile response.historyId"),
  });
}

/**
 * Preflight the authenticated mailbox and bind it to the OAuth locator subject.
 * Every supported official read calls this before any operation-specific API.
 */
export async function getAuthenticatedGmailProfile(
  client: GmailApiClient,
  maximumResponseBytes?: number,
): Promise<GmailProfile> {
  const url = gmailUrl("/gmail/v1/users/me/profile");
  url.searchParams.set("fields", GMAIL_PROFILE_FIELDS);
  const profile = parseGmailProfile(await gmailGet(client, url, maximumResponseBytes));
  if (profile.emailAddress.toLowerCase() !== client.subject.toLowerCase()) {
    throw new Error("official Gmail profile email does not match the OAuth locator subject");
  }
  return profile;
}

function gmailThreadWebUrl(accountLocator: string, threadId: string, view: GmailThreadView): string {
  const encodedAccount = encodedPathSegment(accountLocator);
  return `${GMAIL_WEB_ORIGIN}/mail/u/${encodedAccount}/#${view}/${threadId}`;
}

export function buildGmailThreadUrl(
  accountEmail: string,
  threadIdValue: string,
  view: GmailThreadView = "all",
): string {
  if (!isGmailAccountSubject(accountEmail)) {
    throw new Error("Gmail thread URL account must be an exact email address");
  }
  const threadId = parseGmailId(threadIdValue, "thread URL thread ID");
  if (view !== "all" && view !== "inbox") {
    throw new Error("Gmail thread URL view must be all or inbox");
  }
  return gmailThreadWebUrl(accountEmail, threadId, view);
}

export function parseGmailThreadUrl(url: URL): ParsedGmailThreadUrl {
  if (
    !(url instanceof URL)
    || url.protocol !== "https:"
    || url.hostname !== "mail.google.com"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
  ) throw new Error("Gmail thread URL must use the exact credential-free mail.google.com origin");
  const pathMatch = /^\/mail\/u\/([^/]+)\/$/u.exec(url.pathname);
  const fragmentSegments = url.hash.startsWith("#")
    ? url.hash.slice(1).split("/")
    : [];
  if (pathMatch === null) {
    throw new Error("Gmail thread URL must target one exact account locator");
  }
  const simpleViews = new Set([
    "all",
    "inbox",
    "sent",
    "drafts",
    "spam",
    "trash",
    "starred",
    "important",
  ]);
  let sourceView: string;
  let rawThreadId: string;
  if (
    fragmentSegments.length === 2
    && simpleViews.has(fragmentSegments[0] ?? "")
  ) {
    sourceView = fragmentSegments[0] ?? "";
    rawThreadId = fragmentSegments[1] ?? "";
  } else if (
    fragmentSegments.length === 3
    && (fragmentSegments[0] === "category" || fragmentSegments[0] === "label" || fragmentSegments[0] === "search")
  ) {
    const kind = fragmentSegments[0];
    const encodedSelector = fragmentSegments[1] ?? "";
    if (encodedSelector.length === 0 || Buffer.byteLength(encodedSelector, "utf8") > 4_096) {
      throw new Error("Gmail thread URL has an invalid bounded view selector");
    }
    let selector: string;
    try {
      selector = decodeURIComponent(encodedSelector.replaceAll("+", "%20"));
    } catch (error) {
      throw new Error("Gmail thread URL has an invalid view selector encoding", { cause: error });
    }
    if (
      selector.length === 0
      || Buffer.byteLength(selector, "utf8") > 2_048
      || hasUnsafeControl(selector)
    ) throw new Error("Gmail thread URL has an unsafe or ambiguous view selector");
    sourceView = `${kind}/${encodedSelector}`;
    rawThreadId = fragmentSegments[2] ?? "";
  } else {
    throw new Error("Gmail thread URL must target one exact reviewed mailbox or search view");
  }
  let accountLocator: string;
  try {
    accountLocator = decodeURIComponent(pathMatch[1] ?? "");
  } catch (error) {
    throw new Error("Gmail thread URL has an invalid account locator encoding", { cause: error });
  }
  if (!/^[0-9]{1,8}$/u.test(accountLocator) && !isGmailAccountSubject(accountLocator)) {
    throw new Error("Gmail thread URL account locator must be an email address or numeric account slot");
  }
  const view: GmailThreadView = sourceView === "inbox" ? "inbox" : "all";
  const threadId = parseGmailId(rawThreadId, "thread URL thread ID");
  return Object.freeze({
    accountLocator,
    view,
    sourceView,
    threadId,
    canonicalUrl: gmailThreadWebUrl(accountLocator, threadId, view),
  });
}

function parseThreadStub(value: unknown, label: string): GmailThreadStub {
  const source = record(value, label);
  exactKeys(source, ["id"], ["snippet", "historyId"], label);
  return Object.freeze({
    id: parseGmailId(source.id, `${label}.id`),
    snippet: optionalText(source.snippet, `${label}.snippet`, 64 * 1024, true, true),
    historyId: optionalHistoryId(source.historyId, `${label}.historyId`),
  });
}

function parseMessageStub(value: unknown, label: string): GmailMessageStub {
  const source = record(value, label);
  exactKeys(source, ["id"], ["threadId"], label);
  return Object.freeze({
    id: parseGmailId(source.id, `${label}.id`),
    threadId: source.threadId === undefined
      ? null
      : parseGmailId(source.threadId, `${label}.threadId`),
  });
}

function uniqueIds(values: readonly { readonly id: string }[], label: string): void {
  const ids = values.map((value) => value.id);
  if (new Set(ids).size !== ids.length) return fail(label, "contains duplicate stable IDs");
}

function parseThreadListPage(value: unknown, maximum: number): GmailThreadListPage {
  const source = record(value, "thread list response");
  exactKeys(source, [], ["threads", "nextPageToken", "resultSizeEstimate"], "thread list response");
  const threads = source.threads === undefined
    ? Object.freeze([])
    : Object.freeze(array(source.threads, "thread list response.threads", maximum)
        .map((entry, index) => parseThreadStub(entry, `thread list response.threads[${index}]`)));
  uniqueIds(threads, "thread list response.threads");
  return Object.freeze({
    threads,
    nextPageToken: optionalPageToken(source.nextPageToken, "thread list response.nextPageToken"),
    resultSizeEstimate: optionalInteger(
      source.resultSizeEstimate,
      "thread list response.resultSizeEstimate",
    ) ?? threads.length,
  });
}

function parseMessageListPage(value: unknown, maximum: number): GmailMessageListPage {
  const source = record(value, "message list response");
  exactKeys(source, [], ["messages", "nextPageToken", "resultSizeEstimate"], "message list response");
  const messages = source.messages === undefined
    ? Object.freeze([])
    : Object.freeze(array(source.messages, "message list response.messages", maximum)
        .map((entry, index) => parseMessageStub(entry, `message list response.messages[${index}]`)));
  uniqueIds(messages, "message list response.messages");
  return Object.freeze({
    messages,
    nextPageToken: optionalPageToken(source.nextPageToken, "message list response.nextPageToken"),
    resultSizeEstimate: optionalInteger(
      source.resultSizeEstimate,
      "message list response.resultSizeEstimate",
    ) ?? messages.length,
  });
}

export async function fetchGmailThreadList(
  client: GmailApiClient,
  input: Readonly<{
    limit: number;
    pageToken: string | null;
    query: string | null;
    labelIds: readonly string[];
    includeSpamTrash: boolean;
  }>,
): Promise<GmailThreadListPage> {
  const limit = integer(input.limit, "thread list limit", 1, 500);
  const url = gmailUrl("/gmail/v1/users/me/threads");
  url.searchParams.set("maxResults", String(limit));
  url.searchParams.set("includeSpamTrash", String(input.includeSpamTrash));
  if (input.pageToken !== null) url.searchParams.set("pageToken", pageToken(input.pageToken, "thread list page token"));
  if (input.query !== null) url.searchParams.set("q", text(input.query, "thread list query", 4_096));
  for (const label of input.labelIds) {
    url.searchParams.append("labelIds", text(label, "thread list label ID", 256));
  }
  url.searchParams.set("fields", GMAIL_THREAD_LIST_FIELDS);
  return parseThreadListPage(await gmailGet(client, url), limit);
}

export async function fetchGmailMessageList(
  client: GmailApiClient,
  input: Readonly<{
    limit: number;
    pageToken: string | null;
    query: string;
    includeSpamTrash?: boolean;
  }>,
): Promise<GmailMessageListPage> {
  const limit = integer(input.limit, "message list limit", 1, 500);
  const url = gmailUrl("/gmail/v1/users/me/messages");
  url.searchParams.set("maxResults", String(limit));
  url.searchParams.set("q", text(input.query, "message list query", 4_096));
  url.searchParams.set("includeSpamTrash", String(input.includeSpamTrash ?? false));
  if (input.pageToken !== null) url.searchParams.set("pageToken", pageToken(input.pageToken, "message list page token"));
  url.searchParams.set("fields", GMAIL_MESSAGE_LIST_FIELDS);
  return parseMessageListPage(await gmailGet(client, url), limit);
}

function decodeBase64Url(value: unknown, label: string, maximumBytes = 100 * 1024 * 1024): Uint8Array {
  const encoded = text(value, label, Math.ceil(maximumBytes * 4 / 3) + 4, true);
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(encoded)) {
    return fail(label, "must be canonical base64url data");
  }
  const withoutPadding = encoded.replace(/=+$/u, "");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(withoutPadding, "base64url");
  } catch (error) {
    throw new Error(`official Gmail ${label} is not valid base64url data`, { cause: error });
  }
  if (
    decoded.byteLength > maximumBytes
    || decoded.toString("base64url") !== withoutPadding
  ) return fail(label, "must be canonical bounded base64url data");
  return new Uint8Array(decoded);
}

function internalDate(value: unknown, label: string): string {
  const raw = text(value, label, 32);
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(raw)) {
    return fail(label, "must be a decimal epoch-millisecond timestamp");
  }
  const milliseconds = Number(raw);
  if (!Number.isSafeInteger(milliseconds)) return fail(label, "must be a safe epoch-millisecond timestamp");
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return fail(label, "must be a valid epoch-millisecond timestamp");
  return date.toISOString();
}

function optionalInternalDate(value: unknown, label: string): string | null {
  return value === undefined ? null : internalDate(value, label);
}

type ParsedHeader = Readonly<{ name: string; value: string }>;

function parseHeaders(value: unknown, label: string): readonly ParsedHeader[] {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(array(value, label, MAX_HEADERS).map((entry, index) => {
    const path = `${label}[${index}]`;
    const source = record(entry, path);
    exactKeys(source, ["name", "value"], [], path);
    return Object.freeze({
      name: text(source.name, `${path}.name`, 256),
      value: text(source.value, `${path}.value`, MAX_HEADER_BYTES, true, true),
    });
  }));
}

function interactionMetadataHeaders(
  value: unknown,
  label: string,
): readonly ParsedHeader[] {
  const merged: ParsedHeader[] = [];
  const destinationIndexes = new Map<string, number>();
  const sources = value === undefined ? [] : array(value, label, MAX_HEADERS);
  for (const [sourceIndex, entry] of sources.entries()) {
    const path = `${label}[${sourceIndex}]`;
    const source = record(entry, path);
    exactKeys(source, ["name", "value"], [], path);
    const headerName = text(source.name, `${path}.name`, 256);
    if (typeof source.value !== "string") {
      return fail(`${path}.value`, "must be bounded text without unsafe controls");
    }
    const name = headerName.toLowerCase();
    if (name !== "from" && name !== "to" && name !== "cc" && name !== "bcc") {
      return fail(`${path}.name`, "is outside the reviewed interaction projection");
    }
    if (
      !isWellFormedText(source.value)
      || Buffer.byteLength(source.value, "utf8") > MAX_HEADER_BYTES
      || hasUnsafeControl(source.value, true)
    ) continue;
    const header = Object.freeze({ name: headerName, value: source.value });
    if (name === "from") {
      merged.push(header);
      continue;
    }
    const destinationIndex = destinationIndexes.get(name);
    if (destinationIndex === undefined) {
      destinationIndexes.set(name, merged.length);
      merged.push(header);
      continue;
    }
    const prior = merged[destinationIndex];
    if (prior === undefined) {
      throw new Error("interaction header merge index is unavailable");
    }
    merged[destinationIndex] = Object.freeze({
      name: prior.name,
      value: text(
        `${prior.value}, ${header.value}`,
        `${label}.${prior.name}`,
        MAX_HEADER_BYTES,
        true,
        true,
      ),
    });
  }
  return Object.freeze(merged);
}

function normalizedHeaderValue(value: string): string {
  return value
    .replace(/\r\n[\t ]+/gu, " ")
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\t ]+/gu, " ")
    .trim();
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function calendarMonthDays(year: number, month: number): number {
  if (month === 2) return leapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const RFC_5322_MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;
const RFC_5322_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const RFC_5322_NAMED_ZONE_MINUTES = new Map<string, number>([
  ["UT", 0],
  ["GMT", 0],
  ["EST", -5 * 60],
  ["EDT", -4 * 60],
  ["CST", -6 * 60],
  ["CDT", -5 * 60],
  ["MST", -7 * 60],
  ["MDT", -6 * 60],
  ["PST", -8 * 60],
  ["PDT", -7 * 60],
]);
const MAX_RFC_5322_COMMENT_DEPTH = 16;

/**
 * Remove semantically invisible RFC 5322 CFWS for syntax review. The source
 * header is returned separately with only layout whitespace normalized.
 */
function dateWithoutCfws(value: string, label: string): string {
  let syntax = "";
  let pendingSpace = false;
  let commentDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    const code = character.charCodeAt(0);
    if (
      code > 0x7e
      || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    ) return fail(label, "must contain only reviewed RFC 5322 ASCII text");

    if (character === "\r") {
      if (
        value[index + 1] !== "\n"
        || (value[index + 2] !== " " && value[index + 2] !== "\t")
      ) return fail(label, "contains an unsafe or ambiguous line fold");
      if (commentDepth === 0) pendingSpace = true;
      index += 2;
      continue;
    }
    if (character === "\n") return fail(label, "contains an unsafe bare line feed");

    if (commentDepth > 0) {
      if (character === "\\") {
        const quoted = value[index + 1];
        if (quoted === undefined || !/^[\t\x20-\x7e]$/u.test(quoted)) {
          return fail(label, "contains a malformed quoted pair in a comment");
        }
        index += 1;
      } else if (character === "(") {
        commentDepth += 1;
        if (commentDepth > MAX_RFC_5322_COMMENT_DEPTH) {
          return fail(label, "exceeds the reviewed RFC 5322 comment depth");
        }
      } else if (character === ")") {
        commentDepth -= 1;
        if (commentDepth === 0) pendingSpace = true;
      }
      continue;
    }

    if (character === "(") {
      commentDepth = 1;
      pendingSpace = true;
      continue;
    }
    if (character === ")") return fail(label, "contains an unmatched comment terminator");
    if (character === " " || character === "\t") {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && syntax.length > 0) syntax += " ";
    syntax += character;
    pendingSpace = false;
  }

  if (commentDepth !== 0) return fail(label, "contains an unterminated comment");
  return syntax;
}

function interpretedRfc5322Year(value: string, label: string): number {
  const numeric = Number(value);
  const year = value.length === 2
    ? numeric + (numeric < 50 ? 2_000 : 1_900)
    : value.length === 3
      ? numeric + 1_900
      : numeric;
  if (!Number.isSafeInteger(year) || year < 1_900 || year > 9_999) {
    return fail(label, "contains a year outside the reviewed instant range");
  }
  return year;
}

function gmailDateHeader(value: string, label: string): string {
  const syntax = dateWithoutCfws(value, label);
  const match = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*,\s*)?([0-9]{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-9]{2,6})\s+([0-9]{2})\s*:\s*([0-9]{2})(?:\s*:\s*([0-9]{2}))?\s+(?:([+-])([0-9]{2})([0-9]{2})|([A-Za-z]{1,5}))$/iu.exec(syntax);
  if (match === null) return fail(label, "must be a reviewed RFC 5322 date-time");
  const weekday = match[1]?.toLowerCase();
  const day = Number(match[2]);
  const month = RFC_5322_MONTHS.indexOf((match[3] ?? "").toLowerCase() as typeof RFC_5322_MONTHS[number]) + 1;
  const year = interpretedRfc5322Year(match[4] ?? "", label);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = match[7] === undefined ? 0 : Number(match[7]);
  const zoneMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    month < 1
    || day < 1
    || day > calendarMonthDays(year, month)
    || hour > 23
    || minute > 59
    || second > 60
    || zoneMinute > 59
  ) return fail(label, "contains an invalid calendar date, time, or numeric zone");

  let zoneOffsetMinutes: number;
  if (match[11] !== undefined) {
    const namedZone = match[11].toUpperCase();
    const namedOffset = RFC_5322_NAMED_ZONE_MINUTES.get(namedZone);
    if (namedOffset !== undefined) {
      zoneOffsetMinutes = namedOffset;
    } else if (/^[A-IK-Z]$/u.test(namedZone)) {
      // RFC 5322 assigns military zones unknown-zone (-0000) semantics unless
      // out-of-band information establishes an offset. This parser has none.
      zoneOffsetMinutes = 0;
    } else {
      return fail(label, "uses an ambiguous or unsupported named zone");
    }
  } else {
    const zoneHours = Number(match[9]);
    const direction = match[8] === "-" ? -1 : 1;
    zoneOffsetMinutes = direction * (zoneHours * 60 + zoneMinute);
  }

  const representedSecond = Math.min(second, 59);
  const localMilliseconds = Date.UTC(year, month - 1, day, hour, minute, representedSecond);
  const localDate = new Date(localMilliseconds);
  if (
    !Number.isFinite(localDate.getTime())
    || localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== representedSecond
  ) return fail(label, "does not identify an exact representable local date-time");
  if (
    weekday !== undefined
    && RFC_5322_WEEKDAYS[localDate.getUTCDay()] !== weekday
  ) return fail(label, "contains a day-of-week inconsistent with its calendar date");

  const instantMilliseconds = localMilliseconds
    - zoneOffsetMinutes * 60_000
    + (second === 60 ? 1_000 : 0);
  if (
    !Number.isSafeInteger(instantMilliseconds)
    || !Number.isFinite(new Date(instantMilliseconds).getTime())
  ) return fail(label, "does not identify an exact representable instant");
  return normalizedHeaderValue(value);
}

function selectedHeaders(headers: readonly ParsedHeader[], label: string): Readonly<{
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  inReplyTo: string | null;
}> {
  const wanted = new Map<string, "from" | "to" | "cc" | "bcc" | "subject" | "date" | "messageId" | "inReplyTo">([
    ["from", "from"],
    ["to", "to"],
    ["cc", "cc"],
    ["bcc", "bcc"],
    ["subject", "subject"],
    ["date", "date"],
    ["message-id", "messageId"],
    ["in-reply-to", "inReplyTo"],
  ]);
  const result: Record<string, string | null> = {
    from: null,
    to: null,
    cc: null,
    bcc: null,
    subject: null,
    date: null,
    messageId: null,
    inReplyTo: null,
  };
  for (const header of headers) {
    const key = wanted.get(header.name.toLowerCase());
    if (key === undefined) continue;
    if (result[key] !== null) return fail(`${label}.${header.name}`, "must not be duplicated");
    result[key] = key === "date"
      ? gmailDateHeader(header.value, `${label}.${header.name}`)
      : normalizedHeaderValue(header.value);
  }
  return Object.freeze(result) as ReturnType<typeof selectedHeaders>;
}

function headerValue(headers: readonly ParsedHeader[], name: string): string | null {
  const values = headers
    .filter((header) => header.name.toLowerCase() === name.toLowerCase())
    .map((header) => normalizedHeaderValue(header.value));
  if (values.length > 1) return fail(`MIME header ${name}`, "must not be duplicated");
  return values[0] ?? null;
}

function isMimeTokenCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 33
    && code <= 126
    && !"()<>@,;:\\\"/[]?=".includes(character);
}

function unfoldMimeHeader(value: string, label: string): string {
  let unfolded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character === "\n") return fail(label, "contains an unsafe bare line feed");
    if (character !== "\r") {
      unfolded += character;
      continue;
    }
    if (value[index + 1] !== "\n" || (value[index + 2] !== " " && value[index + 2] !== "\t")) {
      return fail(label, "contains an unsafe or ambiguous line fold");
    }
    index += 2;
    while (value[index + 1] === " " || value[index + 1] === "\t") index += 1;
    unfolded += " ";
  }
  return unfolded;
}

type DispositionParameter = Readonly<{
  quoted: boolean;
  value: string;
}>;

function dispositionParameters(
  rawValue: string,
  label: string,
): Readonly<{
  type: "attachment" | "inline";
  parameters: ReadonlyMap<string, DispositionParameter>;
}> {
  const value = unfoldMimeHeader(rawValue, label);
  let index = 0;
  const skipWhitespace = (): void => {
    while (value[index] === " " || value[index] === "\t") index += 1;
  };
  const token = (tokenLabel: string): string => {
    const start = index;
    while (index < value.length && isMimeTokenCharacter(value[index] ?? "")) index += 1;
    if (start === index) return fail(tokenLabel, "must be a nonempty MIME token");
    return value.slice(start, index);
  };
  const parameterValue = (parameterLabel: string): DispositionParameter => {
    if (value[index] !== "\"") {
      return Object.freeze({ quoted: false, value: token(parameterLabel) });
    }
    index += 1;
    let parsed = "";
    let closed = false;
    while (index < value.length) {
      const character = value[index] ?? "";
      index += 1;
      if (character === "\"") {
        closed = true;
        break;
      }
      if (character === "\\") {
        if (index >= value.length) return fail(parameterLabel, "ends with an ambiguous quoted escape");
        const escaped = value[index] ?? "";
        index += 1;
        if (hasUnsafeControl(escaped)) return fail(parameterLabel, "contains an unsafe quoted escape");
        parsed += escaped;
        continue;
      }
      if (hasUnsafeControl(character)) return fail(parameterLabel, "contains unsafe quoted text");
      parsed += character;
    }
    if (!closed) return fail(parameterLabel, "contains an unterminated quoted value");
    return Object.freeze({ quoted: true, value: parsed });
  };

  skipWhitespace();
  const rawType = token(`${label} type`).toLowerCase();
  if (rawType !== "attachment" && rawType !== "inline") {
    return fail(`${label} type`, "must be attachment or inline");
  }
  const parameters = new Map<string, DispositionParameter>();
  while (true) {
    skipWhitespace();
    if (index === value.length) break;
    if (value[index] !== ";") return fail(label, "contains ambiguous text after its disposition type");
    index += 1;
    skipWhitespace();
    if (index === value.length) return fail(label, "contains an empty trailing parameter");
    const rawName = token(`${label} parameter name`);
    const name = rawName.toLowerCase();
    skipWhitespace();
    if (value[index] !== "=") return fail(`${label} parameter ${rawName}`, "must contain an equals sign");
    index += 1;
    skipWhitespace();
    const parsed = parameterValue(`${label} parameter ${rawName}`);
    skipWhitespace();
    if (parameters.has(name)) return fail(`${label} parameter ${rawName}`, "must not be duplicated");
    parameters.set(name, parsed);
  }
  return Object.freeze({ type: rawType, parameters });
}

function decodeExtendedDispositionFilename(parameter: DispositionParameter, label: string): string {
  if (parameter.quoted) return fail(label, "must use unquoted RFC 5987 syntax");
  const firstQuote = parameter.value.indexOf("'");
  const secondQuote = firstQuote < 0 ? -1 : parameter.value.indexOf("'", firstQuote + 1);
  if (firstQuote <= 0 || secondQuote < 0) return fail(label, "must contain charset, language, and value components");
  const charset = parameter.value.slice(0, firstQuote).toLowerCase();
  const language = parameter.value.slice(firstQuote + 1, secondQuote);
  if (charset !== "utf-8" && charset !== "us-ascii") {
    return fail(label, "uses an unsupported filename charset");
  }
  if (language !== "" && !/^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(language)) {
    return fail(label, "contains an invalid filename language tag");
  }
  const encoded = parameter.value.slice(secondQuote + 1);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index] ?? "";
    if (character === "%") {
      const pair = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/u.test(pair)) return fail(label, "contains invalid filename percent encoding");
      bytes.push(Number.parseInt(pair, 16));
      index += 2;
      continue;
    }
    if (!/^[A-Za-z0-9!#$&+.^_`|~-]$/u.test(character)) {
      return fail(label, "contains an invalid unescaped filename character");
    }
    bytes.push(character.charCodeAt(0));
  }
  if (bytes.length > 8_192) return fail(label, "exceeds the filename byte bound");
  if (charset === "us-ascii" && bytes.some((byte) => byte > 0x7f)) {
    return fail(label, "contains non-ASCII bytes for its declared charset");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder(charset as "utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch (error) {
    throw new Error(`official Gmail ${label} is not valid ${charset} text`, { cause: error });
  }
  return text(decoded, label, 8_192, true);
}

function contentDisposition(
  headers: readonly ParsedHeader[],
  filename: string,
  label: string,
): "attachment" | "inline" | null {
  const matching = headers.filter((header) => header.name.toLowerCase() === "content-disposition");
  if (matching.length > 1) return fail(label, "must not be duplicated");
  const rawValue = matching[0]?.value;
  if (rawValue === undefined) return null;
  const parsed = dispositionParameters(rawValue, label);
  for (const name of parsed.parameters.keys()) {
    if (/^filename\*(?:[0-9]+\*?)?$/u.test(name) && name !== "filename*") {
      return fail(`${label} parameter ${name}`, "uses ambiguous segmented filename syntax");
    }
  }
  const ordinary = parsed.parameters.get("filename");
  const extended = parsed.parameters.get("filename*");
  if (ordinary !== undefined && extended !== undefined) {
    return fail(label, "must not contain both filename and filename* parameters");
  }
  const declaredFilename = ordinary === undefined
    ? extended === undefined
      ? null
      : decodeExtendedDispositionFilename(extended, `${label} parameter filename*`)
    : text(ordinary.value, `${label} parameter filename`, 8_192, true);
  if (declaredFilename !== null && declaredFilename !== filename) {
    return fail(label, "filename does not match the Gmail MIME filename");
  }
  return parsed.type;
}

function contentCharset(
  headers: readonly ParsedHeader[],
  expectedMimeType: "text/plain" | "text/html",
  label: string,
): "utf-8" {
  const rawContentType = headerValue(headers, "content-type");
  if (rawContentType === null) return "utf-8";
  const value = unfoldMimeHeader(rawContentType, label);
  let index = 0;
  const skipWhitespace = (): void => {
    while (value[index] === " " || value[index] === "\t") index += 1;
  };
  const token = (tokenLabel: string): string => {
    const start = index;
    while (index < value.length && isMimeTokenCharacter(value[index] ?? "")) index += 1;
    if (start === index) return fail(tokenLabel, "must be a nonempty MIME token");
    return value.slice(start, index);
  };
  const parameterValue = (parameterLabel: string): string => {
    if (value[index] !== "\"") return token(parameterLabel);
    index += 1;
    let result = "";
    let closed = false;
    while (index < value.length) {
      const character = value[index] ?? "";
      index += 1;
      if (character === "\"") {
        closed = true;
        break;
      }
      if (character === "\\") {
        if (index >= value.length) return fail(parameterLabel, "ends with an ambiguous quoted escape");
        const escaped = value[index] ?? "";
        index += 1;
        if (hasUnsafeControl(escaped)) return fail(parameterLabel, "contains an unsafe quoted escape");
        result += escaped;
      } else {
        if (hasUnsafeControl(character)) return fail(parameterLabel, "contains unsafe quoted text");
        result += character;
      }
    }
    if (!closed) return fail(parameterLabel, "contains an unterminated quoted value");
    return result;
  };

  skipWhitespace();
  const type = token(`${label} type`).toLowerCase();
  if (value[index] !== "/") return fail(label, "must contain an exact type/subtype separator");
  index += 1;
  const subtype = token(`${label} subtype`).toLowerCase();
  if (`${type}/${subtype}` !== expectedMimeType) {
    return fail(label, "does not match the Gmail MIME part type");
  }
  const parameters = new Map<string, string>();
  while (true) {
    skipWhitespace();
    if (index === value.length) break;
    if (value[index] !== ";") return fail(label, "contains ambiguous text after its media type");
    index += 1;
    skipWhitespace();
    if (index === value.length) return fail(label, "contains an empty trailing parameter");
    const rawName = token(`${label} parameter name`);
    const name = rawName.toLowerCase();
    skipWhitespace();
    if (value[index] !== "=") return fail(`${label} parameter ${rawName}`, "must contain an equals sign");
    index += 1;
    skipWhitespace();
    const parsed = parameterValue(`${label} parameter ${rawName}`);
    if (parameters.has(name)) return fail(`${label} parameter ${rawName}`, "must not be duplicated");
    parameters.set(name, parsed);
  }
  const charset = parameters.get("charset");
  if (charset !== undefined && charset.toLowerCase() !== "utf-8") {
    return fail(`${label} charset`, "must be UTF-8 when declared");
  }
  return "utf-8";
}

function decodeText(bytes: Uint8Array, label: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`official Gmail ${label} must contain valid UTF-8 text`, { cause: error });
  }
  let safe = "";
  for (const character of decoded.replace(/\r\n?/gu, "\n")) {
    const code = character.codePointAt(0) ?? -1;
    if (
      code === 0
      || (code >= 1 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || (code >= 127 && code <= 159)
    ) continue;
    safe += character;
  }
  return safe.trimEnd();
}

function decodeHtmlEntity(entity: string): string {
  const lower = entity.toLowerCase();
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  if (named[lower] !== undefined) return named[lower];
  const numeric = lower.startsWith("#x")
    ? Number.parseInt(lower.slice(2), 16)
    : lower.startsWith("#")
      ? Number.parseInt(lower.slice(1), 10)
      : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0x10ffff) return `&${entity};`;
  try {
    return String.fromCodePoint(numeric);
  } catch {
    return "�";
  }
}

type DeadlineCheckpoint = (() => void) | undefined;

function checkpointHtmlScan(checkpoint: DeadlineCheckpoint, index: number): void {
  if (checkpoint !== undefined && index % HTML_DEADLINE_CHECKPOINT_CODE_UNITS === 0) checkpoint();
}

function htmlTagEnd(html: string, start: number, checkpoint: DeadlineCheckpoint): number {
  let quote: "\"" | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    checkpointHtmlScan(checkpoint, index);
    const character = html[index] ?? "";
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function parsedHtmlTag(value: string): Readonly<{
  name: string;
  closing: boolean;
  selfClosing: boolean;
}> | null {
  let index = 0;
  while (value[index] === " " || value[index] === "\t" || value[index] === "\r" || value[index] === "\n") index += 1;
  let closing = false;
  if (value[index] === "/") {
    closing = true;
    index += 1;
    while (value[index] === " " || value[index] === "\t") index += 1;
  }
  const start = index;
  while (/[A-Za-z0-9-]/u.test(value[index] ?? "")) index += 1;
  if (start === index) return null;
  const selfClosing = /\/\s*$/u.test(value);
  return Object.freeze({
    name: value.slice(start, index).toLowerCase(),
    closing,
    selfClosing,
  });
}

function normalizedHtmlText(value: string, checkpoint: DeadlineCheckpoint): string {
  const chunks: string[] = [];
  let buffer = "";
  const append = (textValue: string): void => {
    if (textValue === "") return;
    if (buffer.length + textValue.length >= 8_192) {
      if (buffer !== "") chunks.push(buffer);
      if (textValue.length >= 8_192) chunks.push(textValue);
      else buffer = textValue;
      if (textValue.length >= 8_192) buffer = "";
    } else buffer += textValue;
  };
  let horizontalStart: number | null = null;
  let consecutiveNewlines = 0;
  for (let index = 0; index < value.length; index += 1) {
    checkpointHtmlScan(checkpoint, index);
    const character = value[index] ?? "";
    if (character === " " || character === "\t") {
      if (horizontalStart === null) horizontalStart = index;
      continue;
    }
    if (character === "\n") {
      horizontalStart = null;
      if (consecutiveNewlines < 2) append("\n");
      consecutiveNewlines += 1;
      continue;
    }
    if (horizontalStart !== null) append(value.slice(horizontalStart, index));
    horizontalStart = null;
    consecutiveNewlines = 0;
    append(character === "\u00a0" ? " " : character);
  }
  if (horizontalStart !== null) append(value.slice(horizontalStart));
  if (buffer !== "") chunks.push(buffer);
  checkpoint?.();
  return chunks.join("").trimEnd();
}

function htmlToText(html: string, checkpoint?: () => void): string {
  const hiddenElements = new Set(["head", "script", "style"]);
  const blockElements = new Set([
    "address", "article", "aside", "blockquote", "div", "footer", "h1", "h2", "h3",
    "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p", "pre", "section",
    "table", "tr", "ul",
  ]);
  const output: string[] = [];
  const hiddenStack: string[] = [];
  let textStart = 0;
  let index = 0;
  checkpoint?.();
  while (index < html.length) {
    checkpointHtmlScan(checkpoint, index);
    const character = html[index] ?? "";
    if (character === "<") {
      if (hiddenStack.length === 0 && textStart < index) output.push(html.slice(textStart, index));
      const end = htmlTagEnd(html, index + 1, checkpoint);
      if (end < 0) {
        if (hiddenStack.length === 0) output.push(html.slice(index));
        textStart = html.length;
        break;
      }
      const tag = parsedHtmlTag(html.slice(index + 1, end));
      if (tag !== null) {
        const hidden = hiddenStack.at(-1);
        if (hidden !== undefined) {
          if (tag.closing && tag.name === hidden) hiddenStack.pop();
          else if (!tag.closing && !tag.selfClosing && hiddenElements.has(tag.name)) {
            hiddenStack.push(tag.name);
          }
        } else if (!tag.closing && !tag.selfClosing && hiddenElements.has(tag.name)) {
          hiddenStack.push(tag.name);
        } else if (tag.name === "br" && !tag.closing) output.push("\n");
        else if (tag.closing && blockElements.has(tag.name)) output.push("\n");
      }
      index = end + 1;
      textStart = index;
      continue;
    }
    if (character === "&" && hiddenStack.length === 0) {
      let end = index + 1;
      const maximum = Math.min(html.length, index + 35);
      while (end < maximum && html[end] !== ";") {
        checkpointHtmlScan(checkpoint, end);
        end += 1;
      }
      if (html[end] === ";") {
        const entity = html.slice(index + 1, end);
        if (/^(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,8}|#x[0-9A-Fa-f]{1,6})$/u.test(entity)) {
          if (textStart < index) output.push(html.slice(textStart, index));
          output.push(decodeHtmlEntity(entity));
          index = end + 1;
          textStart = index;
          continue;
        }
      }
    }
    index += 1;
  }
  if (hiddenStack.length === 0 && textStart < html.length) output.push(html.slice(textStart));
  checkpoint?.();
  return normalizedHtmlText(output.join(""), checkpoint);
}

type ExternalBodyFragment = Readonly<{
  readonly kind: "external";
  readonly attachmentId: string;
  readonly messageId: string;
  readonly mimeType: "text/plain" | "text/html";
  readonly charset: "utf-8";
  readonly size: number;
}>;

type BodyFragment = string | ExternalBodyFragment;

type BodyBudget = {
  readonly maxBodyBytes: number;
  readonly deadlineCheckpoint: DeadlineCheckpoint;
  directBodyBytes: number;
  decodedBodyBytes: number;
  renderedBodyBytes: number;
};

type ParsedMessageBodyState = Readonly<{
  readonly plain: readonly BodyFragment[];
  readonly html: readonly BodyFragment[];
}>;

type ParsedThreadBodyState = Readonly<{
  readonly maxBodyBytes: number;
  readonly decodedBodyBytes: number;
  readonly renderedBodyBytes: number;
  readonly messages: readonly ParsedMessageBodyState[];
}>;

type MimeAccumulator = {
  readonly plain: BodyFragment[];
  readonly html: BodyFragment[];
  readonly attachments: GmailAttachment[];
  readonly partIds: Set<string>;
  readonly bodyBudget: BodyBudget;
  nodes: number;
};

function bodyBudgetFailure(maxBodyBytes: number): never {
  return fail(
    "MIME body",
    `exceeds ${maxBodyBytes} rendered bytes or decoded MIME bytes`,
  );
}

function reserveDecodedBodyBytes(bodyBudget: BodyBudget, bytes: number): void {
  const nextBytes = bodyBudget.decodedBodyBytes + bytes;
  if (!Number.isSafeInteger(nextBytes) || nextBytes > bodyBudget.maxBodyBytes) {
    return bodyBudgetFailure(bodyBudget.maxBodyBytes);
  }
  bodyBudget.decodedBodyBytes = nextBytes;
}

function reserveDirectBodyBytes(bodyBudget: BodyBudget, bytes: number): void {
  const nextBytes = bodyBudget.directBodyBytes + bytes;
  if (!Number.isSafeInteger(nextBytes) || nextBytes > MAX_DIRECT_BODY_BYTES) {
    return fail(
      "direct MIME body",
      `exceeds the ${MAX_DIRECT_BODY_BYTES}-byte decoded body.data aggregate`,
    );
  }
  bodyBudget.directBodyBytes = nextBytes;
  reserveDecodedBodyBytes(bodyBudget, bytes);
}

function appendRenderedBodyText(
  bodyBudget: BodyBudget,
  target: BodyFragment[],
  value: string,
): void {
  if (value === "") return;
  const nextBytes = bodyBudget.renderedBodyBytes + Buffer.byteLength(value, "utf8");
  if (!Number.isSafeInteger(nextBytes) || nextBytes > bodyBudget.maxBodyBytes) {
    return bodyBudgetFailure(bodyBudget.maxBodyBytes);
  }
  bodyBudget.renderedBodyBytes = nextBytes;
  target.push(value);
}

function parseMimePart(
  value: unknown,
  path: string,
  messageId: string,
  depth: number,
  maxDepth: number,
  accumulator: MimeAccumulator,
): void {
  accumulator.bodyBudget.deadlineCheckpoint?.();
  accumulator.nodes += 1;
  if (depth > maxDepth || accumulator.nodes > MAX_MIME_PARTS) {
    return fail(path, "exceeds the reviewed MIME tree bound");
  }
  const source = record(value, path);
  exactKeys(source, [], ["partId", "mimeType", "filename", "headers", "body", "parts"], path);
  const partId = optionalText(source.partId, `${path}.partId`, 256, true) ?? "";
  const mimeType = (optionalText(source.mimeType, `${path}.mimeType`, 256) ?? "application/octet-stream").toLowerCase();
  const filename = optionalText(source.filename, `${path}.filename`, 8_192, true, true) ?? "";
  const headers = parseHeaders(source.headers, `${path}.headers`);
  const normalizedDisposition = contentDisposition(
    headers,
    filename,
    `${path}.headers.Content-Disposition`,
  );
  let attachmentId: string | null = null;
  let size = 0;
  let bodyData: Uint8Array | null = null;
  if (source.body !== undefined) {
    const body = record(source.body, `${path}.body`);
    exactKeys(body, [], ["attachmentId", "size", "data"], `${path}.body`);
    attachmentId = body.attachmentId === undefined
      ? null
      : parseGmailAttachmentId(body.attachmentId, `${path}.body.attachmentId`);
    size = optionalInteger(body.size, `${path}.body.size`) ?? 0;
    if (body.data !== undefined) {
      bodyData = decodeBase64Url(body.data, `${path}.body.data`);
      if (bodyData.byteLength !== size) return fail(`${path}.body`, "size does not match decoded data");
    }
    if (attachmentId !== null && bodyData !== null) {
      return fail(`${path}.body`, "cannot contain both inline data and an external attachment ID");
    }
  }
  const isText = mimeType === "text/plain" || mimeType === "text/html";
  const isAttachment = filename !== ""
    || normalizedDisposition === "attachment"
    || (!isText && (attachmentId !== null || bodyData !== null));
  if (isAttachment) {
    if (partId === "") return fail(`${path}.partId`, "must be nonempty for an attachment part");
    if (accumulator.partIds.has(partId)) {
      return fail(`${path}.partId`, "must be unique within its message");
    }
    accumulator.partIds.add(partId);
    if (accumulator.attachments.length >= MAX_MIME_ATTACHMENTS) {
      return fail(path, `contains more than ${MAX_MIME_ATTACHMENTS} attachments`);
    }
    const attachment = Object.freeze({
      attachmentId,
      partId,
      messageId,
      filename,
      mimeType,
      contentDisposition: normalizedDisposition,
      size,
    });
    accumulator.attachments.push(attachment);
    if (attachmentId === null && bodyData !== null) {
      inlineAttachmentBytes.set(attachment, bodyData);
    }
  } else if (isText) {
    const target = mimeType === "text/plain" ? accumulator.plain : accumulator.html;
    if (bodyData !== null) {
      reserveDirectBodyBytes(accumulator.bodyBudget, bodyData.byteLength);
      contentCharset(headers, mimeType, `${path}.headers.Content-Type`);
      const decoded = decodeText(bodyData, `${path}.body.data`);
      appendRenderedBodyText(
        accumulator.bodyBudget,
        target,
        mimeType === "text/plain"
          ? decoded
          : htmlToText(decoded, accumulator.bodyBudget.deadlineCheckpoint),
      );
    } else if (attachmentId !== null) {
      reserveDecodedBodyBytes(accumulator.bodyBudget, size);
      target.push(Object.freeze({
        kind: "external",
        attachmentId,
        messageId,
        mimeType,
        charset: contentCharset(headers, mimeType, `${path}.headers.Content-Type`),
        size,
      }));
    }
  }
  if (source.parts !== undefined) {
    const parts = array(source.parts, `${path}.parts`, MAX_MIME_PARTS);
    for (const [index, part] of parts.entries()) {
      parseMimePart(part, `${path}.parts[${index}]`, messageId, depth + 1, maxDepth, accumulator);
    }
  }
  if (partId === "" && source.parts === undefined && source.body === undefined && source.mimeType === undefined) {
    return fail(path, "must contain reviewed MIME part data");
  }
}

function joinedBody(parts: readonly BodyFragment[]): string | null {
  const nonempty = parts.filter((part): part is string =>
    typeof part === "string" && part !== "");
  return nonempty.length === 0 ? null : nonempty.join("\n\n");
}

function bodyProjection(state: ParsedMessageBodyState): GmailBodyProjection {
  const plainText = joinedBody(state.plain);
  const htmlText = plainText === null ? joinedBody(state.html) : null;
  return Object.freeze({
    text: plainText ?? htmlText,
    source: plainText !== null
      ? "text/plain" as const
      : htmlText !== null
        ? "text/html" as const
        : "none" as const,
  });
}

type ParsedMessage = Readonly<{
  readonly message: GmailMessage;
  readonly bodyState: ParsedMessageBodyState;
}>;

function parseMessage(
  value: unknown,
  label: string,
  maxDepth: number,
  bodyBudget: BodyBudget,
): ParsedMessage {
  const source = record(value, label);
  exactKeys(source, ["id"], [
    "threadId",
    "labelIds",
    "snippet",
    "historyId",
    "internalDate",
    "payload",
    "sizeEstimate",
    "classificationLabelValues",
  ], label);
  if (source.classificationLabelValues !== undefined) {
    // The runtime never requests classification label values. Reject a
    // response that widens beyond the reviewed data projection.
    return fail(`${label}.classificationLabelValues`, "is outside the reviewed Gmail projection");
  }
  if (source.sizeEstimate !== undefined) integer(source.sizeEstimate, `${label}.sizeEstimate`);
  const id = parseGmailId(source.id, `${label}.id`);
  const labelIds = source.labelIds === undefined
    ? Object.freeze([])
    : Object.freeze(array(source.labelIds, `${label}.labelIds`, 1_000).map((entry, index) =>
        text(entry, `${label}.labelIds[${index}]`, 256)));
  if (new Set(labelIds).size !== labelIds.length) return fail(`${label}.labelIds`, "contains duplicates");
  const accumulator: MimeAccumulator = {
    plain: [],
    html: [],
    attachments: [],
    partIds: new Set(),
    bodyBudget,
    nodes: 0,
  };
  let headers: readonly ParsedHeader[] = Object.freeze([]);
  if (source.payload !== undefined) {
    const payload = record(source.payload, `${label}.payload`);
    headers = parseHeaders(payload.headers, `${label}.payload.headers`);
    parseMimePart(payload, `${label}.payload`, id, 0, maxDepth, accumulator);
  }
  const selected = selectedHeaders(headers, `${label}.headers`);
  const bodyState = Object.freeze({
    plain: Object.freeze(accumulator.plain),
    html: Object.freeze(accumulator.html),
  });
  const message = Object.freeze({
    id,
    threadId: source.threadId === undefined
      ? null
      : parseGmailId(source.threadId, `${label}.threadId`),
    historyId: optionalHistoryId(source.historyId, `${label}.historyId`),
    internalDate: optionalInternalDate(source.internalDate, `${label}.internalDate`),
    labelIds,
    snippet: optionalText(source.snippet, `${label}.snippet`, 64 * 1024, true, true),
    ...selected,
    body: bodyProjection(bodyState),
    attachments: Object.freeze(accumulator.attachments),
  });
  return Object.freeze({ message, bodyState });
}

/** Parse one full or metadata Gmail thread response from unknown. */
export function parseGmailThread(
  value: unknown,
  options: GmailThreadParseOptions = {},
): GmailThread {
  const optionSource = record(options, "thread parse options");
  exactKeys(
    optionSource,
    [],
    ["maxDepth", "maxBodyBytes", "deadlineCheckpoint"],
    "thread parse options",
  );
  if (
    optionSource.deadlineCheckpoint !== undefined
    && typeof optionSource.deadlineCheckpoint !== "function"
  ) return fail("thread parse options.deadlineCheckpoint", "must be a function");
  const deadlineCheckpoint = optionSource.deadlineCheckpoint as DeadlineCheckpoint;
  deadlineCheckpoint?.();
  const maxDepth = optionalInteger(
    optionSource.maxDepth,
    "thread parse options.maxDepth",
    0,
    MAX_MIME_DEPTH,
  ) ?? MAX_MIME_DEPTH;
  const maxBodyBytes = optionalInteger(
    optionSource.maxBodyBytes,
    "thread parse options.maxBodyBytes",
    1,
    MAX_CONFIGURED_RESPONSE_TEXT_BYTES,
  ) ?? MAX_RESPONSE_TEXT_BYTES;
  const source = record(value, "thread response");
  exactKeys(source, ["id", "messages"], ["snippet", "historyId"], "thread response");
  const id = parseGmailId(source.id, "thread response.id");
  const bodyBudget: BodyBudget = {
    maxBodyBytes,
    deadlineCheckpoint,
    directBodyBytes: 0,
    decodedBodyBytes: 0,
    renderedBodyBytes: 0,
  };
  const parsedMessages = array(source.messages, "thread response.messages", 1_000)
    .map((entry, index) => parseMessage(
      entry,
      `thread response.messages[${index}]`,
      maxDepth,
      bodyBudget,
    ));
  const messages = Object.freeze(parsedMessages.map((entry) => entry.message));
  uniqueIds(messages, "thread response.messages");
  for (const message of messages) {
    if (message.threadId !== null && message.threadId !== id) {
      return fail("thread response.messages", "contains a message bound to another thread");
    }
  }
  const thread = Object.freeze({
    id,
    snippet: optionalText(source.snippet, "thread response.snippet", 64 * 1024, true, true),
    historyId: optionalHistoryId(source.historyId, "thread response.historyId"),
    messages,
  });
  parsedThreadBodies.set(thread, Object.freeze({
    maxBodyBytes,
    decodedBodyBytes: bodyBudget.decodedBodyBytes,
    renderedBodyBytes: bodyBudget.renderedBodyBytes,
    messages: Object.freeze(parsedMessages.map((entry) => entry.bodyState)),
  }));
  return thread;
}

/** Return render-safe body text, preferring the original text/plain projection. */
export function renderGmailBodyProjection(body: GmailBodyProjection): string | null {
  if (
    (body.source !== "text/plain" && body.source !== "text/html" && body.source !== "none")
    || (body.source === "none") !== (body.text === null)
  ) {
    throw new Error("Gmail body projection source must bind its rendered text");
  }
  return body.text;
}

export async function fetchGmailThread(
  client: GmailApiClient,
  threadIdValue: string,
  maximumResponseBytes?: number,
): Promise<unknown> {
  const threadId = parseGmailId(threadIdValue, "thread fetch ID");
  const url = gmailUrl(`/gmail/v1/users/me/threads/${encodedPathSegment(threadId)}`);
  url.searchParams.set("format", "full");
  url.searchParams.set("fields", GMAIL_THREAD_FIELDS);
  return gmailGet(client, url, maximumResponseBytes);
}

export async function fetchGmailThreadMetadata(
  client: GmailApiClient,
  threadIdValue: string,
): Promise<unknown> {
  const threadId = parseGmailId(threadIdValue, "thread metadata fetch ID");
  const url = gmailUrl(`/gmail/v1/users/me/threads/${encodedPathSegment(threadId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of ["From", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID", "In-Reply-To"]) {
    url.searchParams.append("metadataHeaders", header);
  }
  url.searchParams.set("fields", GMAIL_THREAD_FIELDS);
  return gmailGet(client, url);
}

export async function fetchGmailMessageMetadata(
  client: GmailApiClient,
  messageIdValue: string,
): Promise<GmailMessage> {
  const messageId = parseGmailId(messageIdValue, "message metadata fetch ID");
  const url = gmailUrl(`/gmail/v1/users/me/messages/${encodedPathSegment(messageId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of ["From", "To", "Cc", "Bcc", "Subject", "Date", "Message-ID", "In-Reply-To"]) {
    url.searchParams.append("metadataHeaders", header);
  }
  url.searchParams.set("fields", GMAIL_MESSAGE_FIELDS);
  const bodyBudget: BodyBudget = {
    maxBodyBytes: MAX_RESPONSE_TEXT_BYTES,
    deadlineCheckpoint: () => client.http.throwIfUnavailable(),
    directBodyBytes: 0,
    decodedBodyBytes: 0,
    renderedBodyBytes: 0,
  };
  return parseMessage(
    await gmailGet(client, url),
    "message metadata response",
    MAX_MIME_DEPTH,
    bodyBudget,
  ).message;
}

/**
 * Fetch only the message metadata needed to project contact interactions.
 * The Gmail partial-response mask can yield a headers-only payload, so the
 * code-owned MIME defaults below adapt that exact projection before the
 * ordinary strict Gmail message parser validates it.
 */
export async function fetchGmailMessageInteractionMetadata(
  client: GmailApiClient,
  messageIdValue: string,
): Promise<GmailMessage> {
  const messageId = parseGmailId(messageIdValue, "interaction message metadata fetch ID");
  const url = gmailUrl(`/gmail/v1/users/me/messages/${encodedPathSegment(messageId)}`);
  url.searchParams.set("format", "metadata");
  for (const header of ["From", "To", "Cc", "Bcc"]) {
    url.searchParams.append("metadataHeaders", header);
  }
  url.searchParams.set("fields", GMAIL_INTERACTION_MESSAGE_FIELDS);
  const response = record(
    await gmailGet(client, url),
    "interaction message metadata response",
  );
  let projectedResponse: JsonRecord = response;
  if (response.payload !== undefined) {
    const payload = record(
      response.payload,
      "interaction message metadata response.payload",
    );
    exactKeys(
      payload,
      [],
      ["headers"],
      "interaction message metadata response.payload",
    );
    const headers = interactionMetadataHeaders(
      payload.headers,
      "interaction message metadata response.payload.headers",
    );
    projectedResponse = Object.freeze({
      ...response,
      payload: Object.freeze({
        partId: "",
        mimeType: "application/octet-stream",
        headers,
      }),
    });
  }
  const bodyBudget: BodyBudget = {
    maxBodyBytes: MAX_RESPONSE_TEXT_BYTES,
    deadlineCheckpoint: () => client.http.throwIfUnavailable(),
    directBodyBytes: 0,
    decodedBodyBytes: 0,
    renderedBodyBytes: 0,
  };
  return parseMessage(
    projectedResponse,
    "interaction message metadata response",
    MAX_MIME_DEPTH,
    bodyBudget,
  ).message;
}

export async function fetchGmailAttachmentBytes(
  client: GmailApiClient,
  messageIdValue: string,
  attachmentIdValue: string,
  maximumResponseBytes?: number,
): Promise<Uint8Array> {
  const messageId = parseGmailId(messageIdValue, "attachment message ID");
  const attachmentId = parseGmailAttachmentId(attachmentIdValue, "attachment ID");
  const url = gmailUrl(
    `/gmail/v1/users/me/messages/${encodedPathSegment(messageId)}/attachments/${encodedPathSegment(attachmentId)}`,
  );
  url.searchParams.set("fields", GMAIL_ATTACHMENT_FIELDS);
  const raw = await gmailGet(
    client,
    url,
    maximumResponseBytes,
  );
  const source = record(raw, "attachment response");
  exactKeys(source, ["size", "data"], ["attachmentId"], "attachment response");
  if (source.attachmentId !== undefined) {
    const returned = parseGmailAttachmentId(source.attachmentId, "attachment response.attachmentId");
    if (returned !== attachmentId) return fail("attachment response.attachmentId", "does not match the requested attachment");
  }
  const size = integer(source.size, "attachment response.size");
  const bytes = decodeBase64Url(source.data, "attachment response.data");
  if (bytes.byteLength !== size) return fail("attachment response", "size does not match decoded data");
  return bytes;
}

/**
 * Resolve one parsed attachment without exposing its bytes in the normal
 * thread projection. Inline MIME bytes are retained only in this module's
 * weak side table; external attachments use the reviewed GET endpoint.
 */
export async function resolveGmailAttachmentBytes(
  client: GmailApiClient,
  attachment: GmailAttachment,
  maximumResponseBytes?: number,
): Promise<Uint8Array> {
  const inline = inlineAttachmentBytes.get(attachment);
  if (inline !== undefined) return new Uint8Array(inline);
  if (attachment.attachmentId === null) {
    throw new Error("Gmail inline attachment bytes are unavailable outside their parsed thread lifetime");
  }
  return fetchGmailAttachmentBytes(
    client,
    attachment.messageId,
    attachment.attachmentId,
    maximumResponseBytes,
  );
}

function externalBodyResponseMaximumBytes(decodedBytes: number): number {
  const encodedBytes = Math.ceil(decodedBytes / 3) * 4;
  const maximum = encodedBytes + MAX_ATTACHMENT_RESPONSE_ENVELOPE_BYTES;
  if (!Number.isSafeInteger(maximum)) {
    return fail("external MIME body", "has an unsafe response byte bound");
  }
  return maximum;
}

function containsExternalBody(state: ParsedThreadBodyState): boolean {
  return state.messages.some((message) =>
    [...message.plain, ...message.html].some((fragment) => typeof fragment !== "string"));
}

/**
 * Resolve externally stored text/plain and text/html MIME leaves into the
 * render-safe thread projection. Gmail uses the attachment endpoint for these
 * large body leaves even though they are message bodies, not file attachments.
 * The parser's one aggregate thread budget remains authoritative.
 */
export async function resolveGmailThreadBodies(
  client: GmailApiClient,
  thread: GmailThread,
  maximumResponseBytes?: number,
): Promise<GmailThread> {
  const state = parsedThreadBodies.get(thread);
  if (state === undefined) {
    throw new Error("Gmail thread body resolution requires the exact parsed thread object");
  }
  if (!containsExternalBody(state)) return thread;
  const configuredMaximum = maximumResponseBytes === undefined
    ? null
    : integer(
        maximumResponseBytes,
        "external MIME body response maximum",
        1,
        Number.MAX_SAFE_INTEGER,
      );
  const bodyBudget: BodyBudget = {
    maxBodyBytes: state.maxBodyBytes,
    deadlineCheckpoint: () => client.http.throwIfUnavailable(),
    directBodyBytes: 0,
    decodedBodyBytes: state.decodedBodyBytes,
    renderedBodyBytes: state.renderedBodyBytes,
  };
  const bytesByEndpoint = new Map<string, Uint8Array>();
  const resolvedStates: ParsedMessageBodyState[] = [];

  const resolveFragments = async (
    fragments: readonly BodyFragment[],
  ): Promise<readonly BodyFragment[]> => {
    const resolved: BodyFragment[] = [];
    for (const fragment of fragments) {
      if (typeof fragment === "string") {
        resolved.push(fragment);
        continue;
      }
      const endpointIdentity = `${fragment.messageId}\0${fragment.attachmentId}`;
      let bytes = bytesByEndpoint.get(endpointIdentity);
      if (bytes === undefined) {
        const derivedMaximum = externalBodyResponseMaximumBytes(fragment.size);
        bytes = await fetchGmailAttachmentBytes(
          client,
          fragment.messageId,
          fragment.attachmentId,
          configuredMaximum === null
            ? derivedMaximum
            : Math.min(configuredMaximum, derivedMaximum),
        );
        if (bytes.byteLength !== fragment.size) {
          return fail("external MIME body", "does not match its declared byte size");
        }
        bytesByEndpoint.set(endpointIdentity, bytes);
      } else if (bytes.byteLength !== fragment.size) {
        return fail("external MIME body", "reuses an attachment ID with a conflicting declared size");
      }
      bodyBudget.deadlineCheckpoint?.();
      const decoded = decodeText(bytes, "external MIME body");
      const rendered = fragment.mimeType === "text/plain"
        ? decoded
        : htmlToText(decoded, bodyBudget.deadlineCheckpoint);
      appendRenderedBodyText(bodyBudget, resolved, rendered);
    }
    return Object.freeze(resolved);
  };

  for (const messageState of state.messages) {
    resolvedStates.push(Object.freeze({
      plain: await resolveFragments(messageState.plain),
      html: await resolveFragments(messageState.html),
    }));
  }
  const messages = Object.freeze(thread.messages.map((message, index) => {
    const bodyState = resolvedStates[index];
    if (bodyState === undefined) {
      throw new Error("Gmail parsed thread body state lost a message");
    }
    return Object.freeze({
      ...message,
      body: bodyProjection(bodyState),
    });
  }));
  const resolvedThread = Object.freeze({
    ...thread,
    messages,
  });
  parsedThreadBodies.set(resolvedThread, Object.freeze({
    maxBodyBytes: state.maxBodyBytes,
    decodedBodyBytes: bodyBudget.decodedBodyBytes,
    renderedBodyBytes: bodyBudget.renderedBodyBytes,
    messages: Object.freeze(resolvedStates),
  }));
  return resolvedThread;
}

function optionalPersonText(value: unknown, label: string, maximum: number): string | null {
  return value === undefined ? null : text(value, label, maximum, true, true);
}

function optionalBoolean(value: unknown, label: string): boolean | null {
  if (value === undefined) return null;
  if (typeof value !== "boolean") return fail(label, "must be boolean");
  return value;
}

function contactSourceType(value: unknown, label: string): GmailContactSource["type"] {
  const result = text(value, label, 64);
  const values: readonly GmailContactSource["type"][] = [
    "SOURCE_TYPE_UNSPECIFIED",
    "ACCOUNT",
    "PROFILE",
    "DOMAIN_PROFILE",
    "CONTACT",
    "OTHER_CONTACT",
    "DOMAIN_CONTACT",
  ];
  if (!values.includes(result as GmailContactSource["type"])) {
    return fail(label, "must be a reviewed People source type");
  }
  return result as GmailContactSource["type"];
}

function peopleTimestamp(value: unknown, label: string): string {
  const result = text(value, label, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u.exec(result);
  if (match === null) return fail(label, "must be a UTC RFC3339 timestamp");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > calendarMonthDays(year, month)
    || hour > 23
    || minute > 59
    || second > 59
  ) return fail(label, "must contain a valid UTC calendar date and time");
  return result;
}

function parseContactSource(value: unknown, label: string): GmailContactSource {
  const source = record(value, label);
  exactKeys(source, ["type", "id"], ["etag", "updateTime"], label);
  return Object.freeze({
    type: contactSourceType(source.type, `${label}.type`),
    id: text(source.id, `${label}.id`, 512),
    etag: optionalPersonText(source.etag, `${label}.etag`, 1_024),
    updateTime: source.updateTime === undefined
      ? null
      : peopleTimestamp(source.updateTime, `${label}.updateTime`),
  });
}

function parseFieldMetadata(value: unknown, label: string): GmailContactFieldMetadata | null {
  if (value === undefined) return null;
  const source = record(value, label);
  exactKeys(source, [], ["primary", "sourcePrimary", "verified", "source"], label);
  let parsedSource: GmailContactFieldMetadata["source"] = null;
  if (source.source !== undefined) {
    const item = record(source.source, `${label}.source`);
    exactKeys(item, ["type", "id"], [], `${label}.source`);
    parsedSource = Object.freeze({
      type: contactSourceType(item.type, `${label}.source.type`),
      id: text(item.id, `${label}.source.id`, 512),
    });
  }
  return Object.freeze({
    primary: optionalBoolean(source.primary, `${label}.primary`),
    sourcePrimary: optionalBoolean(source.sourcePrimary, `${label}.sourcePrimary`),
    verified: optionalBoolean(source.verified, `${label}.verified`),
    source: parsedSource,
  });
}

function parseContactMetadata(
  value: unknown,
  label: string,
): GmailContact["metadata"] {
  if (value === undefined) return null;
  const source = record(value, label);
  exactKeys(source, [], ["sources", "deleted"], label);
  const sources = source.sources === undefined
    ? Object.freeze([])
    : Object.freeze(array(source.sources, `${label}.sources`, 100).map((entry, index) =>
        parseContactSource(entry, `${label}.sources[${index}]`)));
  const identities = sources.map((item) => `${item.type}\0${item.id}`);
  if (new Set(identities).size !== identities.length) {
    return fail(`${label}.sources`, "contains duplicate source identities");
  }
  return Object.freeze({
    deleted: optionalBoolean(source.deleted, `${label}.deleted`),
    sources,
  });
}

function parseEmailAddresses(value: unknown, label: string): GmailContact["emailAddresses"] {
  if (value === undefined) return Object.freeze([]);
  const emails = array(value, label, 100).map((entry, index) => {
    const path = `${label}[${index}]`;
    const source = record(entry, path);
    exactKeys(source, ["value"], ["type", "metadata"], path);
    const candidate = text(source.value, `${path}.value`, 254);
    return Object.freeze({
      value: candidate,
      canonicalValue: isGmailAccountSubject(candidate) ? candidate.toLowerCase() : null,
      type: optionalPersonText(source.type, `${path}.type`, 128),
      metadata: parseFieldMetadata(source.metadata, `${path}.metadata`),
    });
  });
  const deduplicated = new Map<string, (typeof emails)[number]>();
  for (const email of emails) {
    const key = email.canonicalValue ?? email.value.toLowerCase();
    const existing = deduplicated.get(key);
    if (existing === undefined || (existing.metadata?.primary !== true && email.metadata?.primary === true)) {
      deduplicated.set(key, email);
    }
  }
  return Object.freeze([...deduplicated.values()]);
}

function parsePhoneNumbers(value: unknown, label: string): GmailContact["phoneNumbers"] {
  if (value === undefined) return Object.freeze([]);
  const phones = array(value, label, 100).map((entry, index) => {
    const path = `${label}[${index}]`;
    const source = record(entry, path);
    exactKeys(source, ["value"], ["type", "canonicalForm", "metadata"], path);
    return Object.freeze({
      value: text(source.value, `${path}.value`, 256),
      canonicalForm: optionalPersonText(source.canonicalForm, `${path}.canonicalForm`, 256),
      type: optionalPersonText(source.type, `${path}.type`, 128),
      metadata: parseFieldMetadata(source.metadata, `${path}.metadata`),
    });
  });
  const deduplicated = new Map<string, (typeof phones)[number]>();
  for (const phone of phones) {
    const key = phone.canonicalForm ?? phone.value;
    const existing = deduplicated.get(key);
    if (existing === undefined || (existing.metadata?.primary !== true && phone.metadata?.primary === true)) {
      deduplicated.set(key, phone);
    }
  }
  return Object.freeze([...deduplicated.values()]);
}

function parseOrganizations(value: unknown, label: string): GmailContact["organizations"] {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(array(value, label, 100).map((entry, index) => {
    const path = `${label}[${index}]`;
    const source = record(entry, path);
    exactKeys(source, [], ["name", "title", "department", "type", "current"], path);
    return Object.freeze({
      name: optionalPersonText(source.name, `${path}.name`, 2_048),
      title: optionalPersonText(source.title, `${path}.title`, 2_048),
      department: optionalPersonText(source.department, `${path}.department`, 2_048),
      type: optionalPersonText(source.type, `${path}.type`, 128),
      current: optionalBoolean(source.current, `${path}.current`),
    });
  }));
}

function parsePersonDate(
  value: unknown,
  label: string,
): NonNullable<GmailContactDate["date"]> {
  const source = record(value, label);
  exactKeys(source, [], ["year", "month", "day"], label);
  const year = source.year === undefined ? 0 : integer(source.year, `${label}.year`, 0, 9_999);
  const month = source.month === undefined ? 0 : integer(source.month, `${label}.month`, 0, 12);
  const day = source.day === undefined ? 0 : integer(source.day, `${label}.day`, 0, 31);
  if (year === 0 && month === 0 && day === 0) return fail(label, "must contain a date component");
  if (month === 0 && day !== 0) return fail(label, "cannot contain a day without a month");
  if (month !== 0 && day > calendarMonthDays(year === 0 ? 2_000 : year, month)) {
    return fail(label, "must contain a valid Gregorian date");
  }
  return Object.freeze({ year, month, day });
}

function parseContactDates(
  value: unknown,
  label: string,
): readonly GmailContactDate[] {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(array(value, label, 100).map((entry, index) => {
    const path = `${label}[${index}]`;
    const source = record(entry, path);
    exactKeys(source, [], ["date", "text", "metadata"], path);
    const date = source.date === undefined ? null : parsePersonDate(source.date, `${path}.date`);
    const textValue = optionalPersonText(source.text, `${path}.text`, 1_024);
    const text = textValue === "" ? null : textValue;
    if (date === null && text === null) return fail(path, "must contain a date or text value");
    return Object.freeze({
      date,
      text,
      metadata: parseFieldMetadata(source.metadata, `${path}.metadata`),
    });
  }));
}

function parseContactEvents(
  value: unknown,
  label: string,
): NonNullable<GmailContact["events"]> {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(array(value, label, 100).map((entry, index) => {
    const path = `${label}[${index}]`;
    const source = record(entry, path);
    exactKeys(source, ["date"], ["type", "formattedType", "metadata"], path);
    return Object.freeze({
      date: parsePersonDate(source.date, `${path}.date`),
      text: null,
      metadata: parseFieldMetadata(source.metadata, `${path}.metadata`),
      type: optionalPersonText(source.type, `${path}.type`, 128),
      formattedType: optionalPersonText(source.formattedType, `${path}.formattedType`, 256),
    });
  }));
}

function googlePhotoUrl(value: unknown, label: string): string | null {
  const raw = optionalPersonText(value, label, 8_192);
  if (raw === null || raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.search !== ""
    || url.hash !== ""
    || (
      !/^lh[1-9]\.googleusercontent\.com$/u.test(url.hostname)
      && url.hostname !== "profiles.googleusercontent.com"
    )
  ) return null;
  return url.href;
}

function peopleResourceName(value: unknown, label: string): string {
  const resourceName = text(value, label, 512);
  if (!/^people\/[A-Za-z0-9_-]{1,256}$/u.test(resourceName)) {
    return fail(label, "must be an exact People resource name");
  }
  return resourceName;
}

function contactResourceName(value: unknown, label: string): string {
  const resourceName = text(value, label, 512);
  if (!/^(?:people|otherContacts)\/[A-Za-z0-9_-]{1,256}$/u.test(resourceName)) {
    return fail(label, "must be an exact contact resource name");
  }
  return resourceName;
}

function parseContact(
  value: unknown,
  label: string,
  projection: GmailContactProjection,
): GmailContact {
  const source = record(value, label);
  exactKeys(source, ["resourceName"], [
    "etag",
    "metadata",
    "names",
    "emailAddresses",
    "phoneNumbers",
    "organizations",
    "photos",
    ...(projection === "dates" ? ["birthdays", "events"] : []),
  ], label);
  const resourceName = contactResourceName(source.resourceName, `${label}.resourceName`);
  let displayName: string | null = null;
  let selectedName: NonNullable<GmailContact["name"]> | null = null;
  if (source.names !== undefined) {
    const names = array(source.names, `${label}.names`, 100);
    for (const [index, entry] of names.entries()) {
      const path = `${label}.names[${index}]`;
      const name = record(entry, path);
      exactKeys(name, [], [
        "displayName",
        "givenName",
        ...(projection === "dates" ? ["middleName"] : []),
        "familyName",
        ...(projection === "dates" ? ["honorificPrefix", "honorificSuffix"] : []),
        "metadata",
      ], path);
      const candidate = optionalPersonText(name.displayName, `${path}.displayName`, 2_048);
      const metadata = parseFieldMetadata(name.metadata, `${path}.metadata`);
      const parsedName = Object.freeze({
        displayName: candidate === "" ? null : candidate,
        givenName: optionalPersonText(name.givenName, `${path}.givenName`, 1_024),
        middleName: projection === "dates"
          ? optionalPersonText(name.middleName, `${path}.middleName`, 1_024)
          : null,
        familyName: optionalPersonText(name.familyName, `${path}.familyName`, 1_024),
        honorificPrefix: projection === "dates"
          ? optionalPersonText(name.honorificPrefix, `${path}.honorificPrefix`, 256)
          : null,
        honorificSuffix: projection === "dates"
          ? optionalPersonText(name.honorificSuffix, `${path}.honorificSuffix`, 256)
          : null,
        metadata,
      });
      if (
        candidate !== null
        && candidate !== ""
        && (displayName === null || metadata?.primary === true)
      ) {
        displayName = candidate;
        selectedName = parsedName;
      } else if (selectedName === null || metadata?.primary === true) selectedName = parsedName;
    }
  }
  let photoUrl: string | null = null;
  if (source.photos !== undefined) {
    const photos = array(source.photos, `${label}.photos`, 100);
    for (const [index, entry] of photos.entries()) {
      const path = `${label}.photos[${index}]`;
      const photo = record(entry, path);
      exactKeys(photo, ["url"], ["default"], path);
      if (photo.default !== undefined && typeof photo.default !== "boolean") {
        return fail(`${path}.default`, "must be boolean");
      }
      const candidate = googlePhotoUrl(photo.url, `${path}.url`);
      if (photoUrl === null && candidate !== null && photo.default !== true) photoUrl = candidate;
    }
  }
  return Object.freeze({
    resourceName,
    etag: optionalPersonText(source.etag, `${label}.etag`, 1_024),
    metadata: parseContactMetadata(source.metadata, `${label}.metadata`),
    displayName,
    ...(projection === "dates" ? { name: selectedName } : {}),
    emailAddresses: parseEmailAddresses(source.emailAddresses, `${label}.emailAddresses`),
    phoneNumbers: parsePhoneNumbers(source.phoneNumbers, `${label}.phoneNumbers`),
    organizations: parseOrganizations(source.organizations, `${label}.organizations`),
    photoUrl,
    ...(projection === "dates" ? {
      birthdays: parseContactDates(source.birthdays, `${label}.birthdays`),
      events: parseContactEvents(source.events, `${label}.events`),
    } : {}),
  });
}

type PeopleConnectionIndexPage = Readonly<{
  resourceNames: readonly string[];
  nextPageToken: string | null;
  totalItems: number | null;
}>;

function parseOtherContactsPage(value: unknown, maximum: number): GmailContactPage {
  const source = record(value, "People Other contacts response");
  exactKeys(source, [], [
    "otherContacts",
    "nextPageToken",
    "totalSize",
  ], "People Other contacts response");
  const contacts = source.otherContacts === undefined
    ? Object.freeze([])
    : Object.freeze(array(
        source.otherContacts,
        "People Other contacts response.otherContacts",
        maximum,
      ).map((entry, index) => {
        const contact = parseContact(
          entry,
          `People Other contacts response.otherContacts[${index}]`,
          "core",
        );
        if (!contact.resourceName.startsWith("otherContacts/")) {
          return fail(
            `People Other contacts response.otherContacts[${index}].resourceName`,
            "must identify an Other contact",
          );
        }
        return contact;
      }));
  const identities = contacts.map((contact) => contact.resourceName);
  if (new Set(identities).size !== identities.length) {
    return fail(
      "People Other contacts response.otherContacts",
      "contains duplicate resource names",
    );
  }
  return Object.freeze({
    contacts,
    nextPageToken: optionalPageToken(
      source.nextPageToken,
      "People Other contacts response.nextPageToken",
    ),
    totalItems: optionalInteger(
      source.totalSize,
      "People Other contacts response.totalSize",
    ),
  });
}

function parseConnectionIndexPage(value: unknown, maximum: number): PeopleConnectionIndexPage {
  const source = record(value, "People connections response");
  exactKeys(source, [], [
    "connections",
    "nextPageToken",
    "totalItems",
  ], "People connections response");
  const resourceNames = source.connections === undefined
    ? Object.freeze([])
    : Object.freeze(array(source.connections, "People connections response.connections", maximum)
        .map((entry, index) => {
          const path = `People connections response.connections[${index}]`;
          const connection = record(entry, path);
          exactKeys(connection, ["resourceName"], [], path);
          return peopleResourceName(connection.resourceName, `${path}.resourceName`);
        }));
  if (new Set(resourceNames).size !== resourceNames.length) {
    return fail("People connections response.connections", "contains duplicate resource names");
  }
  return Object.freeze({
    resourceNames,
    nextPageToken: optionalPageToken(
      source.nextPageToken,
      "People connections response.nextPageToken",
    ),
    totalItems: optionalInteger(source.totalItems, "People connections response.totalItems"),
  });
}

function parsePeopleBatch(
  value: unknown,
  requestedResourceNames: readonly string[],
  projection: GmailContactProjection,
): readonly GmailContact[] {
  const source = record(value, "People batch response");
  exactKeys(source, ["responses"], [], "People batch response");
  const requested = new Set(requestedResourceNames);
  const byRequestedName = new Map<string, GmailContact>();
  for (const [index, entry] of array(source.responses, "People batch response.responses", 200).entries()) {
    const path = `People batch response.responses[${index}]`;
    const response = record(entry, path);
    exactKeys(response, ["requestedResourceName"], [
      "httpStatusCode",
      "status",
      "person",
    ], path);
    const requestedResourceName = peopleResourceName(
      response.requestedResourceName,
      `${path}.requestedResourceName`,
    );
    if (!requested.has(requestedResourceName)) {
      return fail(`${path}.requestedResourceName`, "was not requested");
    }
    if (byRequestedName.has(requestedResourceName)) {
      return fail(`${path}.requestedResourceName`, "is duplicated");
    }
    let hasStatus = false;
    if (response.httpStatusCode !== undefined) {
      hasStatus = true;
      if (integer(response.httpStatusCode, `${path}.httpStatusCode`, 100, 599) !== 200) {
        return fail(`${path}.httpStatusCode`, "does not report a successful person response");
      }
    }
    if (response.status !== undefined) {
      hasStatus = true;
      const status = record(response.status, `${path}.status`);
      exactKeys(status, [], ["code"], `${path}.status`);
      const code = status.code === undefined
        ? 0
        : integer(status.code, `${path}.status.code`, 0, Number.MAX_SAFE_INTEGER);
      if (code !== 0) return fail(`${path}.status.code`, "does not report success");
    }
    if (!hasStatus) return fail(path, "must contain an exact per-person status");
    if (response.person === undefined) return fail(`${path}.person`, "is required for a successful response");
    const contact = parseContact(response.person, `${path}.person`, projection);
    if (!contact.resourceName.startsWith("people/")) {
      return fail(`${path}.person.resourceName`, "must identify a saved contact");
    }
    byRequestedName.set(requestedResourceName, contact);
  }
  for (const resourceName of requestedResourceNames) {
    if (!byRequestedName.has(resourceName)) {
      return fail("People batch response.responses", "is missing a requested resource name");
    }
  }
  const contacts = requestedResourceNames.map((resourceName) => {
    const contact = byRequestedName.get(resourceName);
    if (contact === undefined) throw new Error("People batch response lost a validated contact");
    return contact;
  });
  const returnedNames = contacts.map((contact) => contact.resourceName);
  if (new Set(returnedNames).size !== returnedNames.length) {
    return fail("People batch response.responses", "resolves multiple requests to one contact identity");
  }
  return Object.freeze(contacts);
}

export async function fetchGmailContacts(
  client: GmailApiClient,
  input: Readonly<{
    collection: GmailContactCollection;
    projection?: GmailContactProjection;
    limit: number;
    pageToken: string | null;
  }>,
): Promise<GmailContactPage> {
  const limit = integer(input.limit, "People connections limit", 1, 200);
  const projection = input.projection ?? "core";
  if (projection !== "core" && projection !== "dates") {
    return fail("People contact projection", "must be core or dates");
  }
  if (input.collection === "other-contacts") {
    if (projection !== "core") {
      return fail("People Other contacts projection", "does not support saved-contact dates");
    }
    const otherUrl = peopleUrl("/v1/otherContacts");
    otherUrl.searchParams.set("pageSize", String(limit));
    otherUrl.searchParams.set(
      "readMask",
      "metadata,names,emailAddresses,phoneNumbers,photos",
    );
    otherUrl.searchParams.set("sources", "READ_SOURCE_TYPE_CONTACT");
    otherUrl.searchParams.set("fields", PEOPLE_OTHER_LIST_FIELDS);
    if (input.pageToken !== null) {
      otherUrl.searchParams.set(
        "pageToken",
        pageToken(input.pageToken, "People Other contacts page token"),
      );
    }
    return parseOtherContactsPage(await peopleGet(client, otherUrl), limit);
  }
  if (input.collection !== "contacts") {
    return fail("People contact collection", "must be contacts or other-contacts");
  }
  const url = peopleUrl("/v1/people/me/connections");
  url.searchParams.set("pageSize", String(limit));
  // personFields is mandatory even though the exact partial-response mask keeps
  // this discovery call to stable resource names only.
  url.searchParams.set("personFields", "metadata");
  url.searchParams.set("sources", "READ_SOURCE_TYPE_CONTACT");
  url.searchParams.set("sortOrder", "LAST_MODIFIED_DESCENDING");
  url.searchParams.set("fields", PEOPLE_CONNECTION_LIST_FIELDS);
  if (input.pageToken !== null) {
    url.searchParams.set("pageToken", pageToken(input.pageToken, "People connections page token"));
  }
  const page = parseConnectionIndexPage(await peopleGet(client, url), limit);
  if (page.resourceNames.length === 0) {
    return Object.freeze({
      contacts: Object.freeze([]),
      nextPageToken: page.nextPageToken,
      totalItems: page.totalItems,
    });
  }
  const batchUrl = peopleUrl("/v1/people:batchGet");
  for (const resourceName of page.resourceNames) {
    batchUrl.searchParams.append("resourceNames", resourceName);
  }
  batchUrl.searchParams.set(
    "personFields",
    projection === "dates" ? PEOPLE_DATES_PERSON_FIELDS : PEOPLE_CORE_PERSON_FIELDS,
  );
  batchUrl.searchParams.set("sources", "READ_SOURCE_TYPE_CONTACT");
  const personProjection = projection === "dates"
    ? PEOPLE_DATES_PERSON_PROJECTION
    : PEOPLE_CORE_PERSON_PROJECTION;
  batchUrl.searchParams.set(
    "fields",
    `responses(requestedResourceName,httpStatusCode,status(code),person(${personProjection}))`,
  );
  return Object.freeze({
    contacts: parsePeopleBatch(
      await peopleGet(client, batchUrl),
      page.resourceNames,
      projection,
    ),
    nextPageToken: page.nextPageToken,
    totalItems: page.totalItems,
  });
}

/** Extract and canonicalize ordinary address-spec values from one RFC header. */
export function extractGmailEmailAddresses(value: string | null): readonly string[] {
  if (value === null) return Object.freeze([]);
  const header = text(value, "address header", MAX_HEADER_BYTES, true, true);
  const matches = header.match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/gu) ?? [];
  return Object.freeze([...new Set(matches
    .filter((candidate) => isGmailAccountSubject(candidate))
    .map((candidate) => candidate.toLowerCase()))]);
}
