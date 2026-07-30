/**
 * WhatsApp linked-device protocol policy and bounded local projections.
 *
 * This provider is deliberately not a WhatsApp Web DOM adapter. Its reviewed
 * transport is a pinned `wacli`/whatsmeow linked device plus two private SQLite
 * stores: `session.db` for Noise/Signal device state and `wacli.db` for the
 * locally synced message projection.
 */

import type { OperationInput } from "../model";

export const WHATSAPP_PROTOCOL_PIN = Object.freeze({
  implementation: "github.com/openclaw/wacli",
  version: "0.13.0",
  commit: "1e15f646d23598ef5db2bdb4659ac39cc5188ad2",
  darwinArm64ArchiveSha256:
    "9e6c1ddbe9e4163960689526b714213867533bc4b2eb656c345a4411b70ccdd5",
  darwinArm64BinarySha256:
    "b9ce58668cb0a1ed60115cfe4d59df02b99c876c8ee5671515fce3425aae520b",
  releaseUrl:
    "https://github.com/openclaw/wacli/releases/tag/v0.13.0",
} as const);

export const WHATSAPP_WEB_OPERATION_NAMES = Object.freeze([
  "content.edit",
  "content.save",
  "content.share",
  "media.read",
  "messaging.list",
  "messaging.read",
  "messaging.send",
  "reactions.set",
] as const);

export type WhatsAppWebOperationName =
  (typeof WHATSAPP_WEB_OPERATION_NAMES)[number];
export type WhatsAppWebContractState = "observed" | "capture-required";
export type WhatsAppWebRisk = "R1" | "R2" | "R3" | "R4";

export type WhatsAppWebOperationContract = {
  readonly effect: "read" | "write";
  readonly risk: WhatsAppWebRisk;
  readonly state: WhatsAppWebContractState;
  readonly reason: string;
};

function captureRequired(
  effect: "read" | "write",
  risk: WhatsAppWebRisk,
  reason: string,
): WhatsAppWebOperationContract {
  return Object.freeze({ effect, risk, state: "capture-required", reason });
}

function observed(
  effect: "read" | "write",
  risk: WhatsAppWebRisk,
  reason: string,
): WhatsAppWebOperationContract {
  return Object.freeze({ effect, risk, state: "observed", reason });
}

export const WHATSAPP_WEB_OPERATIONS = Object.freeze({
  "messaging.list": observed(
    "read",
    "R1",
    "the pinned read-only local projection is account-bound and a paired nonempty fixture proved bounded chat listing without opening a WhatsApp connection",
  ),
  "messaging.read": observed(
    "read",
    "R1",
    "the pinned read-only local projection binds one exact conversation and a paired nonempty fixture proved bounded message listing without opening a WhatsApp connection",
  ),
  "media.read": observed(
    "read",
    "R1",
    "the pinned metadata-only local projection is account-bound and a paired fixture proved exact attachment lookup while omitting paths and media keys",
  ),
  "reactions.set": captureRequired(
    "write",
    "R2",
    "the exact linked-device reaction command and local readback are reserved, but create/remove fixtures and process-private payload delivery are not yet proven",
  ),
  "content.save": captureRequired(
    "write",
    "R2",
    "the pinned protocol client can read starred state but does not expose a reviewed star/unstar mutation",
  ),
  "messaging.send": captureRequired(
    "write",
    "R3",
    "the exact text/media send and local readback are reserved, but a low-stakes live fixture and process-private message delivery are not yet proven",
  ),
  "content.edit": captureRequired(
    "write",
    "R3",
    "the exact recent-self-message edit and local readback are reserved, but a low-stakes live fixture and process-private message delivery are not yet proven",
  ),
  "content.share": captureRequired(
    "write",
    "R3",
    "the exact one-message forward and destination readback are reserved, but a low-stakes live fixture must still prove text and media variants",
  ),
} as const satisfies Readonly<
  Record<WhatsAppWebOperationName, WhatsAppWebOperationContract>
>);

export const WHATSAPP_COMMUNITY_MEMBERSHIP_POLICY = Object.freeze({
  risk: "R4",
  state: "prohibited",
  reason:
    "community and group membership changes remain outside the executable wrench boundary",
} as const);

const MAX_TEXT = 65_536;
const MAX_MESSAGE_BODY = 2_000;
const MAX_NAME = 1_024;
const MAX_MESSAGE_ID = 256;
const MAX_JID = 96;
const MAX_BUTTONS = 64;
const MAX_CHATS = 100;
const MAX_MESSAGES = 200;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = new Set(Object.keys(value));
  for (const key of required) {
    if (!keys.delete(key)) throw new Error(`${label} omitted ${key}`);
  }
  for (const key of optional) keys.delete(key);
  if (keys.size > 0) throw new Error(`${label} contained unsupported fields`);
}

function text(
  value: unknown,
  label: string,
  maximum = MAX_TEXT,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length < 1)
    || value.length > maximum
    || /[\0\r]/u.test(value)
  ) throw new Error(`${label} must be bounded text`);
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maximum = MAX_TEXT,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, label, maximum);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) throw new Error(`${label} must be a bounded integer`);
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result)
    || !Number.isFinite(Date.parse(result))
  ) throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  return result;
}

function boundedArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value;
}

const userJidPattern =
  /^[0-9]{5,20}(?::[0-9]{1,5})?@s\.whatsapp\.net$/u;
const lidJidPattern = /^[0-9]{5,32}(?::[0-9]{1,5})?@lid$/u;
const groupJidPattern = /^[0-9]{5,32}(?:-[0-9]{5,20})?@g\.us$/u;
const newsletterJidPattern = /^[0-9]{5,32}@newsletter$/u;
const broadcastJidPattern = /^(?:status|[0-9]{5,32})@broadcast$/u;

export type WhatsAppJidKind =
  | "user"
  | "lid"
  | "group"
  | "newsletter"
  | "broadcast";

export type WhatsAppJid = {
  readonly jid: string;
  readonly kind: WhatsAppJidKind;
};

export function parseWhatsAppJid(
  value: unknown,
  label = "WhatsApp JID",
): WhatsAppJid {
  const jid = text(value, label, MAX_JID);
  const kind: WhatsAppJidKind | null = userJidPattern.test(jid)
    ? "user"
    : lidJidPattern.test(jid)
      ? "lid"
      : groupJidPattern.test(jid)
        ? "group"
        : newsletterJidPattern.test(jid)
          ? "newsletter"
          : broadcastJidPattern.test(jid)
            ? "broadcast"
            : null;
  if (kind === null) throw new Error(`${label} must be an exact WhatsApp JID`);
  return Object.freeze({ jid, kind });
}

export function whatsappTargetJid(
  value: unknown,
  label = "WhatsApp target JID",
): string {
  const parsed = parseWhatsAppJid(value, label);
  if (
    parsed.kind === "newsletter"
    || parsed.kind === "broadcast"
    || parsed.jid.includes(":")
  ) throw new Error(`${label} is not an addressable user, LID, or group JID`);
  return parsed.jid;
}

export function whatsappMessageId(
  value: unknown,
  label = "WhatsApp message ID",
): string {
  const result = text(value, label, MAX_MESSAGE_ID);
  if (!/^[A-Za-z0-9._~:-]{1,256}$/u.test(result)) {
    throw new Error(`${label} must be an exact bounded message ID`);
  }
  return result;
}

function senderJid(value: unknown, label: string): string | null {
  if (value === "") return null;
  return parseWhatsAppJid(value, label).jid;
}

function envelope(value: unknown, label: string): unknown {
  const root = record(value, `${label} envelope`);
  exactKeys(root, ["success", "data", "error"], [], `${label} envelope`);
  if (root.success !== true || root.error !== null) {
    throw new Error(`${label} returned an unsuccessful envelope`);
  }
  return root.data;
}

export type WhatsAppAuthStatus = {
  readonly authenticated: boolean;
  readonly linkedJid: string | null;
  readonly subject: string | null;
};

export function whatsappSubjectFromLinkedJid(value: unknown): string {
  const parsed = parseWhatsAppJid(value, "WhatsApp linked-device JID");
  if (parsed.kind !== "user" && parsed.kind !== "lid") {
    throw new Error("WhatsApp linked-device JID must name one user account");
  }
  const account = parsed.jid.slice(0, parsed.jid.indexOf("@")).split(":", 1)[0];
  if (account === undefined || !/^[0-9]{5,32}$/u.test(account)) {
    throw new Error("WhatsApp linked-device account identifier is malformed");
  }
  return `whatsapp:${parsed.kind === "user" ? "pn" : "lid"}:${account}`;
}

export function parseWhatsAppAuthStatusEnvelope(
  value: unknown,
): WhatsAppAuthStatus {
  const data = record(envelope(value, "WhatsApp auth status"), "auth status");
  const authenticated = boolean(data.authenticated, "auth status.authenticated");
  const expected = ["authenticated"];
  if (data.linked_jid !== undefined) expected.push("linked_jid");
  if (data.phone !== undefined) expected.push("phone");
  exactKeys(data, expected, [], "auth status");
  if (!authenticated) {
    if (data.linked_jid !== undefined || data.phone !== undefined) {
      throw new Error("unauthenticated WhatsApp status exposed account fields");
    }
    return Object.freeze({
      authenticated: false,
      linkedJid: null,
      subject: null,
    });
  }
  const linkedJid = parseWhatsAppJid(
    data.linked_jid,
    "auth status.linked_jid",
  );
  if (linkedJid.kind !== "user" && linkedJid.kind !== "lid") {
    throw new Error("authenticated WhatsApp status did not name one account");
  }
  if (data.phone !== undefined) {
    const phone = text(data.phone, "auth status.phone", 20);
    if (!/^[0-9]{5,20}$/u.test(phone)) {
      throw new Error("auth status.phone must be an international number");
    }
    const linkedAccount = linkedJid.jid.slice(0, linkedJid.jid.indexOf("@"))
      .split(":", 1)[0];
    if (linkedJid.kind === "user" && phone !== linkedAccount) {
      throw new Error("auth status.phone did not match linked_jid");
    }
  }
  return Object.freeze({
    authenticated: true,
    linkedJid: linkedJid.jid,
    subject: whatsappSubjectFromLinkedJid(linkedJid.jid),
  });
}

export type WhatsAppProjectedChat = {
  readonly jid: string;
  readonly kind: string;
  readonly name: string | null;
  readonly lastMessageAt: string;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly mutedUntil: number;
  readonly unread: boolean;
  readonly unreadCount: number;
};

function projectChat(value: unknown, index: number): WhatsAppProjectedChat {
  const item = record(value, `chat[${index}]`);
  exactKeys(
    item,
    [
      "jid",
      "kind",
      "name",
      "last_message_ts",
      "archived",
      "pinned",
      "muted_until",
      "unread",
      "unread_count",
    ],
    [],
    `chat[${index}]`,
  );
  return Object.freeze({
    jid: parseWhatsAppJid(item.jid, `chat[${index}].jid`).jid,
    kind: text(item.kind, `chat[${index}].kind`, 64),
    name: optionalText(item.name, `chat[${index}].name`, MAX_NAME),
    lastMessageAt: timestamp(
      item.last_message_ts,
      `chat[${index}].last_message_ts`,
    ),
    archived: boolean(item.archived, `chat[${index}].archived`),
    pinned: boolean(item.pinned, `chat[${index}].pinned`),
    mutedUntil: integer(
      item.muted_until,
      `chat[${index}].muted_until`,
      -1,
    ),
    unread: boolean(item.unread, `chat[${index}].unread`),
    unreadCount: integer(
      item.unread_count,
      `chat[${index}].unread_count`,
      0,
      1_000_000,
    ),
  });
}

export function projectWhatsAppChatsEnvelope(
  value: unknown,
  maximum = MAX_CHATS,
): readonly WhatsAppProjectedChat[] {
  const limit = integer(maximum, "WhatsApp chat projection limit", 1, MAX_CHATS);
  return Object.freeze(
    boundedArray(envelope(value, "WhatsApp chats"), "chats", limit)
      .map(projectChat),
  );
}

export type WhatsAppProjectedButton = {
  readonly type: string;
  readonly displayText: string;
  readonly index: number | null;
};

export type WhatsAppProjectedMedia = {
  readonly type: string;
  readonly caption: string | null;
  readonly filename: string | null;
  readonly mimeType: string | null;
  readonly downloaded: boolean;
};

export type WhatsAppProjectedMessage = {
  readonly chatJid: string;
  readonly chatName: string | null;
  readonly messageId: string;
  readonly senderJid: string | null;
  readonly senderName: string | null;
  readonly timestamp: string;
  readonly fromMe: boolean;
  readonly text: string;
  readonly displayText: string;
  readonly quotedMessageId: string | null;
  readonly quotedSenderJid: string | null;
  readonly buttons: readonly WhatsAppProjectedButton[];
  readonly forwarded: boolean;
  readonly forwardingScore: number;
  readonly reactionToId: string | null;
  readonly reactionEmoji: string | null;
  readonly media: WhatsAppProjectedMedia | null;
  readonly starred: boolean;
  readonly revoked: boolean;
  readonly deletedForMe: boolean;
  readonly snippet: string | null;
};

function projectButton(
  value: unknown,
  index: number,
): WhatsAppProjectedButton {
  const item = record(value, `button[${index}]`);
  exactKeys(
    item,
    ["type", "display_text"],
    ["id", "url", "phone_number", "description", "response_type", "index"],
    `button[${index}]`,
  );
  // IDs, URLs, phone numbers, and response payloads are intentionally not
  // returned; interactive message metadata is descriptive only.
  return Object.freeze({
    type: text(item.type, `button[${index}].type`, 64),
    displayText: text(
      item.display_text,
      `button[${index}].display_text`,
      1_024,
      true,
    ),
    index: item.index === undefined
      ? null
      : integer(item.index, `button[${index}].index`, 0, 1_000),
  });
}

const messageRequiredKeys = [
  "ChatJID",
  "ChatName",
  "MsgID",
  "SenderJID",
  "SenderName",
  "Timestamp",
  "FromMe",
  "Text",
  "DisplayText",
  "IsForwarded",
  "ForwardingScore",
  "ReactionToID",
  "ReactionEmoji",
  "MediaType",
  "MediaCaption",
  "Filename",
  "MimeType",
  "DirectPath",
  "LocalPath",
  "DownloadedAt",
  "Starred",
  "StarredAt",
  "Revoked",
  "DeletedForMe",
  "Snippet",
] as const;

function projectMessage(
  value: unknown,
  label: string,
  expectedChat?: string,
  expectedMessageId?: string,
): WhatsAppProjectedMessage {
  const item = record(value, label);
  exactKeys(
    item,
    messageRequiredKeys,
    ["quoted_msg_id", "quoted_sender_jid", "Buttons"],
    label,
  );
  const chatJid = parseWhatsAppJid(item.ChatJID, `${label}.ChatJID`).jid;
  const messageId = whatsappMessageId(item.MsgID, `${label}.MsgID`);
  if (expectedChat !== undefined && chatJid !== expectedChat) {
    throw new Error(`${label} did not match the requested conversation`);
  }
  if (expectedMessageId !== undefined && messageId !== expectedMessageId) {
    throw new Error(`${label} did not match the requested message`);
  }
  text(
    item.DirectPath,
    `${label}.DirectPath`,
    16_384,
    true,
  );
  const localPath = text(item.LocalPath, `${label}.LocalPath`, 4_096, true);
  const mediaType = optionalText(item.MediaType, `${label}.MediaType`, 64);
  const downloadedAt = timestamp(item.DownloadedAt, `${label}.DownloadedAt`);
  timestamp(item.StarredAt, `${label}.StarredAt`);
  const buttons = item.Buttons === undefined
    ? []
    : boundedArray(item.Buttons, `${label}.Buttons`, MAX_BUTTONS)
      .map(projectButton);
  const sender = senderJid(item.SenderJID, `${label}.SenderJID`);
  const quotedSender = item.quoted_sender_jid === undefined
    ? null
    : senderJid(item.quoted_sender_jid, `${label}.quoted_sender_jid`);
  return Object.freeze({
    chatJid,
    chatName: optionalText(item.ChatName, `${label}.ChatName`, MAX_NAME),
    messageId,
    senderJid: sender,
    senderName: optionalText(item.SenderName, `${label}.SenderName`, MAX_NAME),
    timestamp: timestamp(item.Timestamp, `${label}.Timestamp`),
    fromMe: boolean(item.FromMe, `${label}.FromMe`),
    text: text(item.Text, `${label}.Text`, MAX_TEXT, true),
    displayText: text(
      item.DisplayText,
      `${label}.DisplayText`,
      MAX_TEXT,
      true,
    ),
    quotedMessageId: item.quoted_msg_id === undefined
      ? null
      : whatsappMessageId(
        item.quoted_msg_id,
        `${label}.quoted_msg_id`,
      ),
    quotedSenderJid: quotedSender,
    buttons: Object.freeze(buttons),
    forwarded: boolean(item.IsForwarded, `${label}.IsForwarded`),
    forwardingScore: integer(
      item.ForwardingScore,
      `${label}.ForwardingScore`,
      0,
      1_000_000,
    ),
    reactionToId: optionalText(
      item.ReactionToID,
      `${label}.ReactionToID`,
      MAX_MESSAGE_ID,
    ),
    reactionEmoji: optionalText(
      item.ReactionEmoji,
      `${label}.ReactionEmoji`,
      64,
    ),
    media: mediaType === null
      ? null
      : Object.freeze({
        type: mediaType,
        caption: optionalText(
          item.MediaCaption,
          `${label}.MediaCaption`,
          MAX_TEXT,
        ),
        filename: optionalText(
          item.Filename,
          `${label}.Filename`,
          MAX_NAME,
        ),
        mimeType: optionalText(
          item.MimeType,
          `${label}.MimeType`,
          255,
        ),
        downloaded:
          localPath !== ""
          && downloadedAt !== "0001-01-01T00:00:00Z",
      }),
    starred: boolean(item.Starred, `${label}.Starred`),
    revoked: boolean(item.Revoked, `${label}.Revoked`),
    deletedForMe: boolean(item.DeletedForMe, `${label}.DeletedForMe`),
    snippet: optionalText(item.Snippet, `${label}.Snippet`, 4_096),
  });
}

export function projectWhatsAppMessagesEnvelope(
  value: unknown,
  expectedChat: string,
  maximum = MAX_MESSAGES,
): {
  readonly messages: readonly WhatsAppProjectedMessage[];
  readonly fullTextSearch: boolean;
} {
  const chat = whatsappTargetJid(expectedChat, "requested conversation JID");
  const limit = integer(
    maximum,
    "WhatsApp message projection limit",
    1,
    MAX_MESSAGES,
  );
  const data = record(envelope(value, "WhatsApp messages"), "messages data");
  exactKeys(data, ["messages", "fts"], [], "messages data");
  const messages = boundedArray(data.messages, "messages", limit)
    .map((item, index) =>
      projectMessage(item, `message[${index}]`, chat)
    );
  return Object.freeze({
    messages: Object.freeze(messages),
    fullTextSearch: boolean(data.fts, "messages.fts"),
  });
}

export function projectWhatsAppMessageEnvelope(
  value: unknown,
  expectedChat: string,
  expectedMessageId: string,
): WhatsAppProjectedMessage {
  const chat = whatsappTargetJid(expectedChat, "requested conversation JID");
  const messageId = whatsappMessageId(
    expectedMessageId,
    "requested message ID",
  );
  return projectMessage(
    envelope(value, "WhatsApp message"),
    "message",
    chat,
    messageId,
  );
}

function inputString(
  input: OperationInput,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  return text(input[name], `input.${name}`, maximum, allowEmpty);
}

function optionalInputString(
  input: OperationInput,
  name: string,
  maximum: number,
): string | undefined {
  return input[name] === undefined
    ? undefined
    : inputString(input, name, maximum);
}

export type WhatsAppWritePlan =
  | {
      readonly action: "messaging.send";
      readonly argv: readonly string[];
      readonly destinationJid: string;
      readonly expectedBody: string | null;
      readonly expectedMedia: boolean;
    }
  | {
      readonly action: "reactions.set";
      readonly argv: readonly string[];
      readonly conversationJid: string;
      readonly targetMessageId: string;
      readonly reaction: string;
    }
  | {
      readonly action: "content.edit";
      readonly argv: readonly string[];
      readonly conversationJid: string;
      readonly targetMessageId: string;
      readonly expectedBody: string;
    }
  | {
      readonly action: "content.share";
      readonly argv: readonly string[];
      readonly sourceConversationJid: string;
      readonly sourceMessageId: string;
      readonly destinationJid: string;
    };

/**
 * Construct only fixed wacli semantic commands. No arbitrary subcommand,
 * recipient name, URL, flag, or query surface can pass through this function.
 *
 * The current contracts remain capture-required, so these plans are inert in
 * production. In particular, text-bearing plans must move to a private stdin
 * or Unix-socket payload before promotion because process argv is observable.
 */
export function planWhatsAppWriteCommand(
  action: WhatsAppWritePlan["action"],
  input: OperationInput,
  materializedAttachmentPath?: string,
): WhatsAppWritePlan {
  if (action === "messaging.send") {
    const destinationJid = whatsappTargetJid(
      inputString(input, "conversation_jid", MAX_JID),
      "input.conversation_jid",
    );
    const body = optionalInputString(input, "body", MAX_MESSAGE_BODY);
    const replyTo = optionalInputString(input, "reply_to_message_id", MAX_MESSAGE_ID);
    if (replyTo !== undefined) {
      whatsappMessageId(replyTo, "input.reply_to_message_id");
    }
    if (materializedAttachmentPath === undefined) {
      if (body === undefined || body.length < 1) {
        throw new Error("WhatsApp text send requires input.body");
      }
      return Object.freeze({
        action,
        argv: Object.freeze([
          "send",
          "text",
          "--to",
          destinationJid,
          "--message",
          body,
          "--no-preview",
          "--post-send-wait",
          "0",
          ...(replyTo === undefined ? [] : ["--reply-to", replyTo]),
        ]),
        destinationJid,
        expectedBody: body,
        expectedMedia: false,
      });
    }
    const path = text(
      materializedAttachmentPath,
      "materialized attachment path",
      4_096,
    );
    if (!path.startsWith("/")) {
      throw new Error("materialized WhatsApp attachment path must be absolute");
    }
    const filename = optionalInputString(input, "filename", MAX_NAME);
    const mimeType = optionalInputString(input, "mime_type", 255);
    return Object.freeze({
      action,
      argv: Object.freeze([
        "send",
        "file",
        "--to",
        destinationJid,
        "--file",
        path,
        "--post-send-wait",
        "0",
        ...(body === undefined ? [] : ["--caption", body]),
        ...(filename === undefined ? [] : ["--filename", filename]),
        ...(mimeType === undefined ? [] : ["--mime", mimeType]),
        ...(replyTo === undefined ? [] : ["--reply-to", replyTo]),
      ]),
      destinationJid,
      expectedBody: body ?? null,
      expectedMedia: true,
    });
  }
  if (action === "reactions.set") {
    const conversationJid = whatsappTargetJid(
      inputString(input, "conversation_jid", MAX_JID),
      "input.conversation_jid",
    );
    const targetMessageId = whatsappMessageId(
      inputString(input, "message_id", MAX_MESSAGE_ID),
      "input.message_id",
    );
    const reaction = inputString(input, "reaction", 64, true);
    const sender = optionalInputString(input, "sender_jid", MAX_JID);
    const parsedChat = parseWhatsAppJid(conversationJid);
    if (parsedChat.kind === "group" && sender === undefined) {
      throw new Error("input.sender_jid is required for a group reaction");
    }
    const senderArgument = sender === undefined
      ? []
      : [
        "--sender",
        whatsappTargetJid(sender, "input.sender_jid"),
      ];
    return Object.freeze({
      action,
      argv: Object.freeze([
        "send",
        "react",
        "--to",
        conversationJid,
        "--id",
        targetMessageId,
        "--reaction",
        reaction,
        "--post-send-wait",
        "0",
        ...senderArgument,
      ]),
      conversationJid,
      targetMessageId,
      reaction,
    });
  }
  if (action === "content.edit") {
    const conversationJid = whatsappTargetJid(
      inputString(input, "conversation_jid", MAX_JID),
      "input.conversation_jid",
    );
    const targetMessageId = whatsappMessageId(
      inputString(input, "message_id", MAX_MESSAGE_ID),
      "input.message_id",
    );
    const expectedBody = inputString(input, "body", MAX_MESSAGE_BODY);
    return Object.freeze({
      action,
      argv: Object.freeze([
        "messages",
        "edit",
        "--chat",
        conversationJid,
        "--id",
        targetMessageId,
        "--message",
        expectedBody,
        "--post-send-wait",
        "0",
      ]),
      conversationJid,
      targetMessageId,
      expectedBody,
    });
  }
  const sourceConversationJid = whatsappTargetJid(
    inputString(input, "source_conversation_jid", MAX_JID),
    "input.source_conversation_jid",
  );
  const sourceMessageId = whatsappMessageId(
    inputString(input, "message_id", MAX_MESSAGE_ID),
    "input.message_id",
  );
  const destinationJid = whatsappTargetJid(
    inputString(input, "destination_jid", MAX_JID),
    "input.destination_jid",
  );
  return Object.freeze({
    action,
    argv: Object.freeze([
      "messages",
      "forward",
      "--chat",
      sourceConversationJid,
      "--id",
      sourceMessageId,
      "--to",
      destinationJid,
      "--post-send-wait",
      "0",
    ]),
    sourceConversationJid,
    sourceMessageId,
    destinationJid,
  });
}

export type WhatsAppWriteReceipt = {
  readonly messageId: string;
  readonly readbackChatJid: string;
};

export function parseWhatsAppWriteEnvelope(
  plan: WhatsAppWritePlan,
  value: unknown,
): WhatsAppWriteReceipt {
  const data = record(envelope(value, `WhatsApp ${plan.action}`), "write data");
  if (plan.action === "messaging.send") {
    exactKeys(data, ["sent", "to", "id"], ["file"], "send response");
    if (data.sent !== true || data.to !== plan.destinationJid) {
      throw new Error("WhatsApp send response did not bind the destination");
    }
    if (plan.expectedMedia && !isRecord(data.file)) {
      throw new Error("WhatsApp media send response omitted file metadata");
    }
    return Object.freeze({
      messageId: whatsappMessageId(data.id, "send response.id"),
      readbackChatJid: plan.destinationJid,
    });
  }
  if (plan.action === "reactions.set") {
    exactKeys(
      data,
      ["sent", "to", "id", "target", "reaction"],
      [],
      "reaction response",
    );
    if (
      data.sent !== true
      || data.to !== plan.conversationJid
      || data.target !== plan.targetMessageId
      || data.reaction !== plan.reaction
    ) throw new Error("WhatsApp reaction response did not bind the target");
    return Object.freeze({
      messageId: whatsappMessageId(data.id, "reaction response.id"),
      readbackChatJid: plan.conversationJid,
    });
  }
  if (plan.action === "content.edit") {
    exactKeys(
      data,
      ["edited", "to", "id", "target", "message"],
      [],
      "edit response",
    );
    if (
      data.edited !== true
      || data.to !== plan.conversationJid
      || data.target !== plan.targetMessageId
      || data.message !== plan.expectedBody
    ) throw new Error("WhatsApp edit response did not bind the target and text");
    whatsappMessageId(data.id, "edit response.id");
    return Object.freeze({
      messageId: plan.targetMessageId,
      readbackChatJid: plan.conversationJid,
    });
  }
  exactKeys(
    data,
    ["forwarded", "to", "id", "source"],
    [],
    "forward response",
  );
  if (
    data.forwarded !== true
    || data.to !== plan.destinationJid
    || data.source !== plan.sourceMessageId
  ) throw new Error("WhatsApp forward response did not bind source and destination");
  return Object.freeze({
    messageId: whatsappMessageId(data.id, "forward response.id"),
    readbackChatJid: plan.destinationJid,
  });
}

export function verifyWhatsAppWriteReadback(
  plan: WhatsAppWritePlan,
  receipt: WhatsAppWriteReceipt,
  readbackEnvelope: unknown,
): WhatsAppProjectedMessage {
  const message = projectWhatsAppMessageEnvelope(
    readbackEnvelope,
    receipt.readbackChatJid,
    receipt.messageId,
  );
  if (!message.fromMe) {
    throw new Error("WhatsApp write readback did not bind the linked-device actor");
  }
  if (plan.action === "messaging.send") {
    if (
      plan.expectedMedia
        ? message.media === null
          || (plan.expectedBody !== null
            && message.media.caption !== plan.expectedBody)
        : message.text !== plan.expectedBody
    ) throw new Error("WhatsApp send readback did not bind the confirmed content");
  } else if (plan.action === "reactions.set") {
    if (
      message.reactionToId !== plan.targetMessageId
      || message.reactionEmoji !== (plan.reaction === "" ? null : plan.reaction)
    ) throw new Error("WhatsApp reaction readback did not bind desired state");
  } else if (plan.action === "content.edit") {
    if (message.text !== plan.expectedBody) {
      throw new Error("WhatsApp edit readback did not bind confirmed text");
    }
  } else if (!message.forwarded) {
    throw new Error("WhatsApp forward readback was not marked forwarded");
  }
  return message;
}
