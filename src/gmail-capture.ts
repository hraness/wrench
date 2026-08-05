import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { CaptureArguments } from "@hraness/kb/capture";
import {
  abortCaptureBundle,
  beginCaptureBundle,
  commitCaptureBundle,
  redactSensitiveText,
  sanitizeArtifactUrl,
  type CaptureBundleTransaction,
  type CaptureManifestAsset,
  type CaptureManifestInput,
  writeCaptureBundle,
} from "@hraness/kb/clip/persist";
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
} from "@hraness/kb/clip/terminal";
import {
  type WrenchAuth,
} from "./auth";
import {
  loadOAuthToken,
  ProviderHttpClient,
  requireOAuthScopes,
  type ProviderFetch,
} from "./provider-http";
import {
  buildGmailThreadUrl,
  createGmailApiClient,
  fetchGmailThread,
  getAuthenticatedGmailProfile,
  parseGmailThread,
  parseGmailThreadUrl,
  resolveGmailAttachmentBytes,
  resolveGmailThreadBodies,
  type GmailApiClient,
  type GmailAttachment,
} from "./providers/gmail-api";

const GMAIL_READ_SCOPE_ALTERNATIVES = [
  ["https://www.googleapis.com/auth/gmail.readonly"],
  ["https://www.googleapis.com/auth/gmail.modify"],
  ["https://mail.google.com/"],
] as const;
const MAX_GMAIL_ATTACHMENT_FILES = 500;
const MAX_PUBLIC_DIAGNOSTIC_CODE_UNITS = 1_000;
const MAX_INLINE_FIELD_CODE_UNITS = 8_192;
const MAX_ATTACHMENT_LABEL_CODE_UNITS = 1_024;
const FILE_VERIFY_CHUNK_BYTES = 1024 * 1024;
const GMAIL_PROFILE_RESPONSE_MAX_BYTES = 64 * 1024;
const GMAIL_RESPONSE_ENVELOPE_MAX_BYTES = 32 * 1024;
const GMAIL_THREAD_STRUCTURE_MAX_BYTES = 8 * 1024 * 1024;
const GMAIL_INLINE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
const GMAIL_BODY_MAX_BYTES = 64 * 1024 * 1024;
const GMAIL_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
const GMAIL_PROVENANCE_FILENAME = "gmail.json";
const GMAIL_STORED_ATTACHMENT_EXTENSION = "bin";
const GMAIL_STORED_ATTACHMENT_MIME_TYPE = "application/octet-stream";

type GmailOAuthAuth = Extract<
  WrenchAuth,
  { readonly kind: "oauth-token-file" }
> & {
  readonly provider: "gmail";
  readonly subject: string;
};

type GmailCaptureOutput = {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

type GmailProfileProjection = {
  readonly emailAddress: string;
};

type GmailAttachmentProjection = {
  readonly providerAttachment: GmailAttachment;
  readonly partId: string;
  readonly contentDisposition: "attachment" | "inline" | null;
  readonly messageId: string;
  readonly attachmentId: string | null;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
};

type GmailMessageProjection = {
  readonly id: string;
  readonly historyId: string | null;
  readonly internalDate: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly cc: string | null;
  readonly bcc: string | null;
  readonly subject: string | null;
  readonly date: string | null;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly body: string;
  readonly attachments: readonly GmailAttachmentProjection[];
};

type GmailThreadProjection = {
  readonly id: string;
  readonly historyId: string | null;
  readonly messages: readonly GmailMessageProjection[];
};

type StagedAttachment = GmailAttachmentProjection & {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
};

type GmailCaptureOutcome = {
  readonly slug: string;
  readonly markdown: string;
  readonly messageCount: number;
  readonly discoveredAttachmentCount: number;
  readonly capturedAttachmentCount: number;
  readonly capturedFileCount: number;
  readonly capturedBytes: number;
  readonly warnings: readonly string[];
};

export type GmailCaptureDependencies = {
  readonly fetch?: ProviderFetch;
  readonly httpClient?: ProviderHttpClient;
  readonly now?: () => Date;
  readonly createClient?: (input: {
    readonly http: ProviderHttpClient;
    readonly accessToken: string;
    readonly subject: string;
  }) => GmailApiClient;
  readonly getProfile?: (
    client: GmailApiClient,
    maximumResponseBytes?: number,
  ) => Promise<GmailProfileProjection>;
  readonly parseThreadUrl?: typeof parseGmailThreadUrl;
  readonly buildThreadUrl?: typeof buildGmailThreadUrl;
  readonly fetchThread?: (
    client: GmailApiClient,
    threadId: string,
    maximumResponseBytes?: number,
  ) => Promise<unknown>;
  readonly parseThread?: (value: unknown) => unknown;
  readonly resolveThreadBodies?: typeof resolveGmailThreadBodies;
  readonly resolveAttachment?: (
    client: GmailApiClient,
    attachment: GmailAttachment,
    maximumResponseBytes?: number,
  ) => Promise<Uint8Array>;
};

export type GmailCaptureRunner = (
  options: CaptureArguments,
  auth: WrenchAuth,
  environment: Readonly<Record<string, string | undefined>>,
  output: GmailCaptureOutput,
  dependencies?: GmailCaptureDependencies,
) => Promise<number>;

class PublicGmailCaptureError extends Error {}

function publicFailure(message: string, options?: ErrorOptions): PublicGmailCaptureError {
  return new PublicGmailCaptureError(message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
  ) throw new Error(`Gmail ${label} is invalid`);
  return value;
}

function nullableString(
  value: unknown,
  label: string,
  maximum = MAX_INLINE_FIELD_CODE_UNITS,
): string | null {
  if (value === null || value === undefined) return null;
  return boundedString(value, label, maximum, true);
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Gmail ${label} is invalid`);
  }
  return value as number;
}

function requireGmailAuth(auth: WrenchAuth): asserts auth is GmailOAuthAuth {
  if (auth.kind !== "oauth-token-file" || auth.provider !== "gmail") {
    throw publicFailure("Gmail thread capture requires a stored Gmail OAuth auth locator");
  }
  if (auth.subject === undefined) {
    throw publicFailure("Gmail thread capture requires an auth locator bound to an account subject");
  }
  try {
    requireOAuthScopes(auth, GMAIL_READ_SCOPE_ALTERNATIVES);
  } catch (error) {
    throw publicFailure(
      "Gmail OAuth auth locator lacks a scope that permits full thread and attachment reads",
      { cause: error },
    );
  }
}

function validateCaptureOptions(options: CaptureArguments): URL {
  if (options.currentTab || options.url === null) {
    throw publicFailure("Gmail capture requires one exact Gmail thread URL; the current browser target is unsupported");
  }
  if (
    options.browserProfile !== undefined
    || options.browserLive
    || options.cdp !== undefined
    || options.cookieSources.length > 0
    || options.cookieProfile !== undefined
    || options.cookiesFile !== undefined
  ) {
    throw publicFailure("Gmail thread capture uses only stored OAuth auth; browser and cookie options are unsupported");
  }
  if (options.mode !== "auto" || options.htmlFile !== undefined) {
    throw publicFailure("Gmail thread capture uses the official API and accepts only --mode auto");
  }
  if (options.scope !== "auto" && options.scope !== "thread") {
    throw publicFailure("Gmail capture supports only thread scope");
  }
  if (options.evidence !== "none") {
    throw publicFailure("Gmail thread capture does not persist browser evidence");
  }
  if (options.media !== "all" && options.media !== "none") {
    throw publicFailure("Gmail thread attachments use --media all or --media none");
  }
  if (options.maxDepth > 32) {
    throw publicFailure("Gmail MIME traversal supports a maximum depth of 32");
  }
  if (options.maxHtmlBytes > GMAIL_BODY_MAX_BYTES) {
    throw publicFailure(`Gmail thread bodies support at most ${GMAIL_BODY_MAX_BYTES} decoded bytes`);
  }
  if (options.maxAssetBytes > GMAIL_ATTACHMENT_MAX_BYTES) {
    throw publicFailure(`Gmail attachments support at most ${GMAIL_ATTACHMENT_MAX_BYTES} bytes per file`);
  }
  return options.url;
}

function sameEmail(left: string, right: string): boolean {
  return left.normalize("NFKC").toLocaleLowerCase("en-US")
    === right.normalize("NFKC").toLocaleLowerCase("en-US");
}

function accountLocatorMatches(locator: string, emailAddress: string): boolean {
  return /^[0-9]{1,8}$/u.test(locator) || sameEmail(locator, emailAddress);
}

function base64WireBytes(decodedBytes: number): number {
  const encoded = Math.ceil(decodedBytes / 3) * 4;
  if (!Number.isSafeInteger(encoded)) {
    throw publicFailure("the Gmail response byte limit is too large");
  }
  return encoded;
}

function checkedResponseBytes(...values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw publicFailure("the Gmail response byte limit is too large");
  }
  return total;
}

function threadResponseMaximumBytes(options: CaptureArguments): number {
  const inlineAttachmentBytes = Math.min(
    options.maxTotalAssetBytes,
    GMAIL_INLINE_ATTACHMENT_MAX_BYTES,
  );
  return checkedResponseBytes(
    base64WireBytes(options.maxHtmlBytes),
    base64WireBytes(inlineAttachmentBytes),
    GMAIL_THREAD_STRUCTURE_MAX_BYTES,
  );
}

function attachmentResponseMaximumBytes(options: CaptureArguments): number {
  return checkedResponseBytes(
    base64WireBytes(options.maxAssetBytes),
    GMAIL_RESPONSE_ENVELOPE_MAX_BYTES,
  );
}

function responseMaximumBytes(options: CaptureArguments): number {
  return Math.max(
    GMAIL_PROFILE_RESPONSE_MAX_BYTES,
    threadResponseMaximumBytes(options),
    attachmentResponseMaximumBytes(options),
  );
}

function defaultFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}

function projectAttachment(
  value: unknown,
  parentMessageId: string,
): GmailAttachmentProjection {
  if (!isRecord(value)) throw new Error("Gmail attachment projection is invalid");
  const messageId = nullableString(value.messageId, "attachment message ID", 512)
    ?? parentMessageId;
  if (messageId !== parentMessageId) {
    throw new Error("Gmail attachment projection belongs to another message");
  }
  const contentDisposition = value.contentDisposition;
  if (
    contentDisposition !== null
    && contentDisposition !== "attachment"
    && contentDisposition !== "inline"
  ) {
    throw new Error("Gmail attachment content disposition is invalid");
  }
  return {
    providerAttachment: value as GmailAttachment,
    partId: boundedString(value.partId, "attachment part ID", 256),
    contentDisposition,
    messageId,
    attachmentId: nullableString(value.attachmentId, "attachment ID", 4_096),
    filename: boundedString(
      value.filename,
      "attachment filename",
      MAX_ATTACHMENT_LABEL_CODE_UNITS,
      true,
    ),
    mimeType: boundedString(value.mimeType, "attachment MIME type", 256),
    size: safeInteger(value.size, "attachment size"),
  };
}

function requiredHeaderProjection(
  value: Record<string, unknown>,
  names: readonly string[],
  label: string,
): unknown {
  const containers = [value];
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) throw new Error("Gmail message header projection is invalid");
    containers.push(value.headers);
  }
  let present = false;
  let result: unknown;
  for (const container of containers) {
    for (const name of names) {
      if (!Object.hasOwn(container, name)) continue;
      if (present) throw new Error(`Gmail ${label} header projection is duplicated`);
      present = true;
      result = container[name];
    }
  }
  if (!present) throw new Error(`Gmail ${label} header projection is missing`);
  return result;
}

function bodyProjection(value: Record<string, unknown>): string {
  if (typeof value.body === "string") return value.body;
  if (!isRecord(value.body)) throw new Error("Gmail message body projection is invalid");
  const body = value.body;
  if (body.text === null) return "";
  if (typeof body.text === "string") return body.text;
  if (typeof body.markdown === "string") return body.markdown;
  throw new Error("Gmail message body projection is invalid");
}

function projectMessage(value: unknown): GmailMessageProjection {
  if (!isRecord(value)) throw new Error("Gmail message projection is invalid");
  const id = boundedString(value.id, "message ID", 512);
  if (!Array.isArray(value.attachments)) {
    throw new Error("Gmail message attachment projection is invalid");
  }
  return {
    id,
    historyId: nullableString(value.historyId, "message history ID", 256),
    internalDate: nullableString(value.internalDate, "message internal date", 64),
    from: nullableString(requiredHeaderProjection(value, ["from"], "From"), "From header"),
    to: nullableString(requiredHeaderProjection(value, ["to"], "To"), "To header"),
    cc: nullableString(requiredHeaderProjection(value, ["cc"], "Cc"), "Cc header"),
    bcc: nullableString(requiredHeaderProjection(value, ["bcc"], "Bcc"), "Bcc header"),
    subject: nullableString(requiredHeaderProjection(value, ["subject"], "Subject"), "Subject header"),
    date: nullableString(requiredHeaderProjection(value, ["date"], "Date"), "Date header"),
    messageId: nullableString(
      requiredHeaderProjection(value, ["messageId", "message-id"], "Message-ID"),
      "Message-ID header",
    ),
    inReplyTo: nullableString(
      requiredHeaderProjection(value, ["inReplyTo", "in-reply-to"], "In-Reply-To"),
      "In-Reply-To header",
    ),
    body: bodyProjection(value),
    attachments: value.attachments.map((attachment) => projectAttachment(attachment, id)),
  };
}

function projectThread(value: unknown): GmailThreadProjection {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Gmail thread projection is invalid");
  }
  const messages = value.messages.map(projectMessage);
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new Error("Gmail thread projection contains duplicate messages");
  }
  return {
    id: boundedString(value.id, "thread ID", 512),
    historyId: nullableString(value.historyId, "thread history ID", 256),
    messages,
  };
}

function safeSlug(value: string): string {
  const normalized = value
    .slice(0, 16 * 1024)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/['’]/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return [...normalized].slice(0, 80).join("").replace(/-+$/gu, "");
}

function captureSlug(
  options: CaptureArguments,
  accountSubject: string,
  threadId: string,
): string {
  const source = options.slug === undefined
    ? `gmail-thread-${createHash("sha256")
        .update("gmail-thread\0", "utf8")
        .update(accountSubject.toLocaleLowerCase("en-US"), "utf8")
        .update("\0", "utf8")
        .update(threadId, "utf8")
        .digest("hex")
        .slice(0, 32)}`
    : redactSensitiveText(options.slug);
  const slug = safeSlug(source);
  if (slug === "") {
    throw publicFailure(options.slug === undefined
      ? "could not derive a safe Gmail capture slug"
      : "the Gmail capture slug must contain at least one letter or number");
  }
  return slug;
}

function markdownPlainText(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\`*_[\]{}()#+.!|~-]/gu, "\\$&");
}

function inlineMarkdown(value: string, maximum = MAX_INLINE_FIELD_CODE_UNITS): string {
  const sanitized = sanitizeTerminalLine(value)
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = sanitized.length > maximum
    ? `${sanitized.slice(0, Math.max(0, maximum - 1))}…`
    : sanitized;
  return markdownPlainText(bounded);
}

function yamlString(value: string): string {
  return JSON.stringify(sanitizeTerminalLine(value));
}

function countWords(value: string): number {
  const matches = value.trim().match(/\S+/gu);
  return matches?.length ?? 0;
}

function normalizedMimeType(value: string): string {
  const mimeType = value.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

function storedAttachmentPath(digest: string): string {
  return `assets/${digest}.${GMAIL_STORED_ATTACHMENT_EXTENSION}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyStagedFile(path: string, expectedBytes: number, expectedSha256: string): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY
      | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0)
      | ("O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0),
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || before.size !== BigInt(expectedBytes)
      || (process.platform !== "win32" && (before.mode & 0o777n) !== 0o600n)
    ) {
      throw new Error("staged Gmail attachment identity does not match its fetched bytes");
    }
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.max(
      1,
      Math.min(FILE_VERIFY_CHUNK_BYTES, expectedBytes),
    ));
    let offset = 0;
    while (offset < expectedBytes) {
      const count = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.byteLength, expectedBytes - offset),
        offset,
      );
      if (count === 0) {
        throw new Error("staged Gmail attachment ended before its declared byte size");
      }
      digest.update(chunk.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || digest.digest("hex") !== expectedSha256
    ) {
      throw new Error("staged Gmail attachment digest does not match its fetched bytes");
    }
  } finally {
    closeSync(descriptor);
  }
}

function hardenTree(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error("private Gmail capture contains a symbolic link");
  if (metadata.isFile()) {
    chmodSync(path, 0o600);
    return;
  }
  if (!metadata.isDirectory()) throw new Error("private Gmail capture contains an unsupported entry");
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) hardenTree(join(path, entry));
}

function preflightAttachments(
  messages: readonly GmailMessageProjection[],
  options: CaptureArguments,
  attachmentsRequested: boolean,
): readonly GmailAttachmentProjection[] {
  const attachments = messages.flatMap((message) => message.attachments);
  const maximumFiles = Math.min(options.maxItems, MAX_GMAIL_ATTACHMENT_FILES);
  if (attachments.length > maximumFiles) {
    throw publicFailure(`Gmail thread has more than the configured ${maximumFiles} attachment file limit`);
  }
  if (!attachmentsRequested) return attachments;
  let total = 0;
  for (const attachment of attachments) {
    if (attachment.size > options.maxAssetBytes) {
      throw publicFailure("a Gmail attachment exceeds the configured per-file byte limit");
    }
    total += attachment.size;
    if (!Number.isSafeInteger(total) || total > options.maxTotalAssetBytes) {
      throw publicFailure("Gmail attachments exceed the configured total byte limit");
    }
  }
  return attachments;
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function attachmentEndpoint(attachment: GmailAttachmentProjection): string {
  if (attachment.attachmentId === null) {
    return "https://gmail.googleapis.com/gmail/v1/users/me/messages/"
      + encodePathSegment(attachment.messageId);
  }
  return "https://gmail.googleapis.com/gmail/v1/users/me/messages/"
    + `${encodePathSegment(attachment.messageId)}/attachments/`
    + encodePathSegment(attachment.attachmentId);
}

async function stageAttachments(
  transaction: CaptureBundleTransaction,
  client: GmailApiClient,
  attachments: readonly GmailAttachmentProjection[],
  options: CaptureArguments,
  resolveAttachment: NonNullable<GmailCaptureDependencies["resolveAttachment"]>,
  maximumResponseBytes: number,
): Promise<{
  readonly attachments: readonly StagedAttachment[];
  readonly assets: readonly CaptureManifestAsset[];
  readonly uniqueFileCount: number;
  readonly fetchedBytes: number;
}> {
  if (attachments.length === 0) {
    return { attachments: [], assets: [], uniqueFileCount: 0, fetchedBytes: 0 };
  }
  mkdirSync(transaction.assetsDirectory, { recursive: true, mode: 0o700 });
  chmodSync(transaction.assetsDirectory, 0o700);
  const projected: StagedAttachment[] = [];
  const assetsByPath = new Map<string, CaptureManifestAsset>();
  const stagedPaths = new Set<string>();
  let fetchedBytes = 0;
  for (const attachment of attachments) {
    let bytes: Uint8Array;
    try {
      bytes = await resolveAttachment(
        client,
        attachment.providerAttachment,
        maximumResponseBytes,
      );
    } catch (error) {
      throw publicFailure("could not fetch every Gmail attachment", { cause: error });
    }
    if (!(bytes instanceof Uint8Array)) {
      throw publicFailure("Gmail returned an invalid attachment byte payload");
    }
    if (bytes.byteLength !== attachment.size) {
      throw publicFailure("a Gmail attachment did not match its declared byte size");
    }
    if (bytes.byteLength > options.maxAssetBytes) {
      throw publicFailure("a Gmail attachment exceeds the configured per-file byte limit");
    }
    fetchedBytes += bytes.byteLength;
    if (!Number.isSafeInteger(fetchedBytes) || fetchedBytes > options.maxTotalAssetBytes) {
      throw publicFailure("Gmail attachments exceed the configured total byte limit");
    }
    const digest = sha256(bytes);
    const relativePath = storedAttachmentPath(digest);
    const targetPath = join(transaction.stagingDirectory, relativePath);
    if (!existsSync(targetPath)) {
      writeFileSync(targetPath, bytes, { flag: "wx", mode: 0o600 });
      chmodSync(targetPath, 0o600);
    }
    verifyStagedFile(targetPath, bytes.byteLength, digest);
    projected.push({
      ...attachment,
      path: relativePath,
      sha256: digest,
      bytes: bytes.byteLength,
    });
    stagedPaths.add(relativePath);
    const endpoint = attachmentEndpoint(attachment);
    if (!assetsByPath.has(relativePath)) {
      assetsByPath.set(relativePath, {
        source: endpoint,
        url: endpoint,
        path: relativePath,
        mimeType: GMAIL_STORED_ATTACHMENT_MIME_TYPE,
        bytes: bytes.byteLength,
        sha256: digest,
      });
    }
  }
  return {
    attachments: projected,
    assets: [...assetsByPath.values()],
    uniqueFileCount: stagedPaths.size,
    fetchedBytes,
  };
}

function attachmentLookup(
  attachments: readonly StagedAttachment[],
): ReadonlyMap<GmailAttachment, StagedAttachment> {
  return new Map(attachments.map((attachment) => [
    attachment.providerAttachment,
    attachment,
  ]));
}

function previewStagedAttachments(
  attachments: readonly GmailAttachmentProjection[],
): readonly StagedAttachment[] {
  return attachments.map((attachment) => {
    return {
      ...attachment,
      path: storedAttachmentPath("0".repeat(64)),
      sha256: "0".repeat(64),
      bytes: attachment.size,
    };
  });
}

function writeGmailProvenance(
  transaction: CaptureBundleTransaction,
  input: {
    readonly sourceUrl: string;
    readonly canonicalUrl: string;
    readonly accountSubject: string;
    readonly accountBinding: "email-locator-verified" | "numeric-slot-rebound";
    readonly capturedAt: Date;
    readonly thread: GmailThreadProjection;
    readonly stagedAttachments: readonly StagedAttachment[];
  },
): void {
  const staged = attachmentLookup(input.stagedAttachments);
  const document = {
    schemaVersion: 2,
    sourceUrl: sanitizeArtifactUrl(input.sourceUrl),
    canonicalUrl: sanitizeArtifactUrl(input.canonicalUrl),
    capturedAt: input.capturedAt.toISOString(),
    accountSubject: input.accountSubject,
    accountBinding: input.accountBinding,
    thread: {
      id: input.thread.id,
      historyId: input.thread.historyId,
      messages: input.thread.messages.map((message) => ({
        id: message.id,
        historyId: message.historyId,
        internalDate: message.internalDate,
        headers: {
          from: message.from,
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          date: message.date,
          messageId: message.messageId,
          inReplyTo: message.inReplyTo,
        },
        attachments: message.attachments.map((attachment) => {
          const captured = staged.get(attachment.providerAttachment);
          return {
            partId: attachment.partId,
            attachmentId: attachment.attachmentId,
            contentDisposition: attachment.contentDisposition,
            filename: redactSensitiveText(attachment.filename),
            mimeType: normalizedMimeType(attachment.mimeType),
            declaredBytes: attachment.size,
            path: captured?.path ?? null,
            sha256: captured?.sha256 ?? null,
            capturedBytes: captured?.bytes ?? null,
          };
        }),
      })),
    },
  } as const;
  writeFileSync(
    join(transaction.stagingDirectory, GMAIL_PROVENANCE_FILENAME),
    `${JSON.stringify(document, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

function renderHeaders(message: GmailMessageProjection): readonly string[] {
  return [
    message.from === null ? null : `- **From:** ${inlineMarkdown(message.from)}`,
    message.to === null ? null : `- **To:** ${inlineMarkdown(message.to)}`,
    message.cc === null ? null : `- **Cc:** ${inlineMarkdown(message.cc)}`,
    message.bcc === null ? null : `- **Bcc:** ${inlineMarkdown(message.bcc)}`,
    message.date === null ? null : `- **Date:** ${inlineMarkdown(message.date)}`,
    message.messageId === null ? null : `- **Message-ID:** ${inlineMarkdown(message.messageId)}`,
    message.inReplyTo === null ? null : `- **In-Reply-To:** ${inlineMarkdown(message.inReplyTo)}`,
  ].filter((line): line is string => line !== null);
}

function renderThreadMarkdown(input: {
  readonly thread: GmailThreadProjection;
  readonly slug: string;
  readonly canonicalUrl: string;
  readonly capturedAt: Date;
  readonly stagedAttachments: readonly StagedAttachment[];
  readonly attachmentsCaptured: boolean;
}): string {
  const title = input.thread.messages
    .map((message) => message.subject?.trim())
    .find((subject): subject is string => subject !== undefined && subject !== "")
    ?? "Gmail thread";
  const localByAttachment = attachmentLookup(input.stagedAttachments);
  const chunks = [
    "---",
    `title: ${yamlString(title)}`,
    `source: ${yamlString(input.canonicalUrl)}`,
    `clipped: ${yamlString(input.capturedAt.toISOString().slice(0, 10))}`,
    'platform: "gmail"',
    'capture_status: "complete"',
    'capture_method: "gmail-api"',
    'capture_scope: "thread"',
    "---",
    "",
    `# ${inlineMarkdown(title, 2_048) || input.slug}`,
    "",
  ];
  for (const [index, message] of input.thread.messages.entries()) {
    chunks.push(`## Message ${index + 1}`, "", ...renderHeaders(message), "");
    const body = markdownPlainText(message.body).trim();
    chunks.push(body === "" ? "_No text body._" : body, "");
    if (message.attachments.length === 0) continue;
    chunks.push("### Attachments", "");
    for (const attachment of message.attachments) {
      const label = inlineMarkdown(attachment.filename, MAX_ATTACHMENT_LABEL_CODE_UNITS)
        || "Unnamed attachment";
      const staged = localByAttachment.get(attachment.providerAttachment);
      if (input.attachmentsCaptured && staged !== undefined) {
        chunks.push(`- [${label}](${staged.path}) (${staged.bytes} bytes)`);
      } else {
        chunks.push(`- ${label} (${attachment.size} bytes; content not captured)`);
      }
    }
    chunks.push("");
  }
  return `${sanitizeTerminalText(chunks.join("\n")).trimEnd()}\n`;
}

function assertThreadBounds(thread: GmailThreadProjection, options: CaptureArguments): void {
  if (thread.messages.length === 0) {
    throw publicFailure("Gmail returned an empty thread");
  }
  if (thread.messages.length > options.maxItems) {
    throw publicFailure("Gmail thread exceeds the configured message count limit");
  }
  let bodyBytes = 0;
  for (const message of thread.messages) {
    bodyBytes += Buffer.byteLength(message.body, "utf8");
    if (!Number.isSafeInteger(bodyBytes) || bodyBytes > options.maxHtmlBytes) {
      throw publicFailure("Gmail thread bodies exceed the configured content byte limit");
    }
  }
}

function manifestInput(input: {
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly capturedAt: Date;
  readonly markdown: string;
  readonly messageCount: number;
  readonly assets: readonly CaptureManifestAsset[];
  readonly capturedFileCount: number;
  readonly attachmentsRequested: boolean;
  readonly warnings: readonly string[];
}): CaptureManifestInput {
  return {
    sourceUrl: input.sourceUrl,
    canonicalUrl: input.canonicalUrl,
    capturedAt: input.capturedAt.toISOString(),
    platform: "gmail",
    status: "complete",
    scope: "thread",
    acquisition: {
      method: "gmail-api",
      finalUrl: input.canonicalUrl,
      contentType: "application/json",
    },
    extraction: {
      extractor: "gmail-api-thread",
      score: 1,
      wordCount: countWords(input.markdown),
      capturedItems: input.messageCount,
      expectedItems: input.messageCount,
    },
    attempts: [{
      method: "gmail-api",
      outcome: "succeeded",
      message: "Fetched the complete Gmail thread through the official API.",
    }],
    assets: input.assets,
    artifacts: {
      images: { requested: false, status: "not-requested", files: 0 },
      media: input.attachmentsRequested
        ? { requested: true, status: "captured", files: input.capturedFileCount }
        : { requested: false, status: "not-requested", files: 0 },
      videoContext: {
        requested: false,
        status: "not-requested",
        thumbnailPath: null,
        transcriptLanguage: null,
        transcriptCueCount: 0,
        transcriptTruncated: false,
        metadata: null,
      },
    },
    evidence: {
      requested: "none",
      screenshotPath: null,
      screenshotStatus: "not-requested",
      sourceHtmlStatus: "not-requested",
    },
    warnings: input.warnings,
  };
}

function beginPrivateCapture(options: CaptureArguments, slug: string): CaptureBundleTransaction {
  try {
    return beginCaptureBundle({
      outputRoot: options.outputBase,
      slug,
      force: options.force,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (detail.includes("capture already exists")) {
      throw publicFailure("Gmail thread capture already exists; pass --force to replace it", { cause: error });
    }
    throw publicFailure("could not prepare private Gmail capture storage", { cause: error });
  }
}

async function captureGmailThread(
  options: CaptureArguments,
  auth: GmailOAuthAuth,
  dependencies: GmailCaptureDependencies,
): Promise<GmailCaptureOutcome> {
  const sourceUrl = validateCaptureOptions(options);
  const parseThreadUrl = dependencies.parseThreadUrl ?? parseGmailThreadUrl;
  let parsedUrl: ReturnType<typeof parseGmailThreadUrl>;
  try {
    parsedUrl = parseThreadUrl(sourceUrl);
  } catch (error) {
    throw publicFailure("capture target must be one exact Gmail thread URL", { cause: error });
  }
  let token: ReturnType<typeof loadOAuthToken>;
  try {
    token = loadOAuthToken(auth, new Date(), options.timeoutMs);
  } catch (error) {
    throw publicFailure("could not load a valid private Gmail OAuth token", { cause: error });
  }
  const http = dependencies.httpClient ?? new ProviderHttpClient(
    dependencies.fetch ?? defaultFetch,
    options.timeoutMs,
    responseMaximumBytes(options),
  );
  const createClient = dependencies.createClient ?? createGmailApiClient;
  let client: GmailApiClient;
  try {
    client = createClient({
      http,
      accessToken: token.accessToken,
      subject: auth.subject,
    });
  } catch (error) {
    throw publicFailure("could not initialize the Gmail API client", { cause: error });
  }
  const getProfile = dependencies.getProfile ?? getAuthenticatedGmailProfile;
  let profile: GmailProfileProjection;
  try {
    profile = await getProfile(client, GMAIL_PROFILE_RESPONSE_MAX_BYTES);
  } catch (error) {
    throw publicFailure("could not verify the authenticated Gmail account", { cause: error });
  }
  if (typeof profile.emailAddress !== "string" || profile.emailAddress.length > 254) {
    throw publicFailure("Gmail returned an invalid authenticated account profile");
  }
  if (!sameEmail(profile.emailAddress, auth.subject)) {
    throw publicFailure("the authenticated Gmail account does not match the auth locator subject");
  }
  if (!accountLocatorMatches(parsedUrl.accountLocator, profile.emailAddress)) {
    throw publicFailure("the Gmail thread URL account does not match the authenticated account");
  }
  const buildThreadUrl = dependencies.buildThreadUrl ?? buildGmailThreadUrl;
  let canonicalUrl: string;
  try {
    const candidate = buildThreadUrl(
      profile.emailAddress,
      parsedUrl.threadId,
      parsedUrl.view,
    );
    const verified = parseGmailThreadUrl(new URL(candidate));
    if (
      !sameEmail(verified.accountLocator, profile.emailAddress)
      || verified.threadId !== parsedUrl.threadId
      || verified.view !== parsedUrl.view
    ) throw new Error("canonical Gmail thread URL changed its bound target");
    canonicalUrl = verified.canonicalUrl;
  } catch (error) {
    throw publicFailure("could not construct the canonical Gmail thread URL", { cause: error });
  }
  const fetchThread = dependencies.fetchThread ?? fetchGmailThread;
  let rawThread: unknown;
  try {
    rawThread = await fetchThread(
      client,
      parsedUrl.threadId,
      threadResponseMaximumBytes(options),
    );
  } catch (error) {
    throw publicFailure("could not fetch the Gmail thread", { cause: error });
  }
  let thread: GmailThreadProjection;
  try {
    const parsedThread = dependencies.parseThread === undefined
      ? parseGmailThread(rawThread, {
          maxDepth: options.maxDepth,
          maxBodyBytes: options.maxHtmlBytes,
          deadlineCheckpoint: () => client.http.throwIfUnavailable(),
        })
      : dependencies.parseThread(rawThread);
    const completeThread = dependencies.parseThread !== undefined
      && dependencies.resolveThreadBodies === undefined
      ? parsedThread
      : await (dependencies.resolveThreadBodies ?? resolveGmailThreadBodies)(
          client,
          parsedThread as ReturnType<typeof parseGmailThread>,
          threadResponseMaximumBytes(options),
        );
    thread = projectThread(completeThread);
  } catch (error) {
    throw publicFailure("Gmail returned an invalid thread projection", { cause: error });
  }
  if (thread.id !== parsedUrl.threadId) {
    throw publicFailure("Gmail returned a different thread than the requested URL");
  }
  assertThreadBounds(thread, options);
  const readOnly = options.command === "inspect" || options.stdout;
  const attachmentsRequested = options.media !== "none" && !readOnly;
  const attachments = preflightAttachments(
    thread.messages,
    options,
    attachmentsRequested,
  );
  const slug = captureSlug(options, profile.emailAddress, thread.id);
  const capturedAt = dependencies.now?.() ?? new Date();
  if (!Number.isFinite(capturedAt.getTime())) {
    throw publicFailure("the Gmail capture timestamp is invalid");
  }
  const accountBinding = /^[0-9]{1,8}$/u.test(parsedUrl.accountLocator)
    ? "numeric-slot-rebound" as const
    : "email-locator-verified" as const;
  const warnings = accountBinding === "numeric-slot-rebound"
    ? ["The copied Gmail URL used a browser-local numeric account slot; the stored OAuth subject supplied the captured account identity."]
    : [];
  if (readOnly) {
    const markdown = redactSensitiveText(renderThreadMarkdown({
      thread,
      slug,
      canonicalUrl,
      capturedAt,
      stagedAttachments: [],
      attachmentsCaptured: false,
    }));
    if (Buffer.byteLength(markdown, "utf8") > options.maxHtmlBytes) {
      throw publicFailure("rendered Gmail thread exceeds the configured content byte limit");
    }
    return {
      slug,
      markdown,
      messageCount: thread.messages.length,
      discoveredAttachmentCount: attachments.length,
      capturedAttachmentCount: 0,
      capturedFileCount: 0,
      capturedBytes: 0,
      warnings: Object.freeze(warnings),
    };
  }

  const previewMarkdown = redactSensitiveText(renderThreadMarkdown({
    thread,
    slug,
    canonicalUrl,
    capturedAt,
    stagedAttachments: attachmentsRequested
      ? previewStagedAttachments(attachments)
      : [],
    attachmentsCaptured: attachmentsRequested,
  }));
  if (Buffer.byteLength(previewMarkdown, "utf8") > options.maxHtmlBytes) {
    throw publicFailure("rendered Gmail thread exceeds the configured content byte limit");
  }

  const transaction = beginPrivateCapture(options, slug);
  try {
    const staged = attachmentsRequested
      ? await stageAttachments(
          transaction,
          client,
          attachments,
          options,
          dependencies.resolveAttachment ?? resolveGmailAttachmentBytes,
          attachmentResponseMaximumBytes(options),
        )
      : { attachments: [], assets: [], uniqueFileCount: 0, fetchedBytes: 0 };
    const markdown = redactSensitiveText(renderThreadMarkdown({
      thread,
      slug,
      canonicalUrl,
      capturedAt,
      stagedAttachments: staged.attachments,
      attachmentsCaptured: attachmentsRequested,
    }));
    if (Buffer.byteLength(markdown, "utf8") > options.maxHtmlBytes) {
      throw publicFailure("rendered Gmail thread exceeds the configured content byte limit");
    }
    writeGmailProvenance(transaction, {
      sourceUrl: sourceUrl.href,
      canonicalUrl,
      accountSubject: profile.emailAddress,
      accountBinding,
      capturedAt,
      thread,
      stagedAttachments: staged.attachments,
    });
    writeCaptureBundle(transaction, {
      markdown,
      manifest: manifestInput({
        sourceUrl: sourceUrl.href,
        canonicalUrl,
        capturedAt,
        markdown,
        messageCount: thread.messages.length,
        assets: staged.assets,
        capturedFileCount: staged.uniqueFileCount,
        attachmentsRequested,
        warnings,
      }),
    });
    hardenTree(transaction.stagingDirectory);
    try {
      commitCaptureBundle(transaction);
    } catch (error) {
      throw publicFailure("could not commit the private Gmail capture", { cause: error });
    }
    return {
      slug,
      markdown,
      messageCount: thread.messages.length,
      discoveredAttachmentCount: attachments.length,
      capturedAttachmentCount: staged.attachments.length,
      capturedFileCount: staged.uniqueFileCount,
      capturedBytes: staged.fetchedBytes,
      warnings: Object.freeze(warnings),
    };
  } catch (error) {
    abortCaptureBundle(transaction);
    if (error instanceof PublicGmailCaptureError) throw error;
    throw publicFailure("could not persist the private Gmail thread capture", { cause: error });
  }
}

function captureSummary(outcome: GmailCaptureOutcome): Record<string, unknown> {
  return {
    ok: true,
    status: "complete",
    platform: "gmail",
    scope: "thread",
    slug: outcome.slug,
    messageCount: outcome.messageCount,
    discoveredAttachmentCount: outcome.discoveredAttachmentCount,
    capturedAttachmentCount: outcome.capturedAttachmentCount,
    capturedFileCount: outcome.capturedFileCount,
    capturedBytes: outcome.capturedBytes,
    warnings: outcome.warnings,
  };
}

function terminalJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "string"
      ? sanitizeTerminalText(redactSensitiveText(candidate))
      : candidate, 2)}\n`;
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof PublicGmailCaptureError
    ? error.message
    : "Gmail thread capture failed";
  return sanitizeTerminalLine(redactSensitiveText(message))
    .slice(0, MAX_PUBLIC_DIAGNOSTIC_CODE_UNITS);
}

export const runGmailCapture: GmailCaptureRunner = async (
  options,
  auth,
  _environment,
  output,
  dependencies = {},
) => {
  try {
    requireGmailAuth(auth);
    if (!options.quiet && !options.json) {
      output.stderr("Capturing one Gmail thread through the official API ...\n");
    }
    const outcome = await captureGmailThread(options, auth, dependencies);
    if (!options.json) {
      for (const warning of outcome.warnings) {
        output.stderr(`warning: ${sanitizeTerminalLine(warning)}\n`);
      }
    }
    if (options.json) output.stdout(terminalJson(captureSummary(outcome)));
    else if (options.stdout || options.command === "inspect") {
      output.stdout(sanitizeTerminalText(outcome.markdown));
    }
    else {
      output.stdout(`Done: Gmail thread captured as ${outcome.slug}.\n`);
      output.stdout(
        `Status: complete; ${outcome.messageCount} messages; ${outcome.capturedAttachmentCount} attachments; ${outcome.capturedBytes} bytes.\n`,
      );
    }
    return 0;
  } catch (error) {
    const message = publicErrorMessage(error);
    if (options.json) output.stdout(terminalJson({ ok: false, error: message }));
    else output.stderr(`error: ${message}\n`);
    return 1;
  }
};
