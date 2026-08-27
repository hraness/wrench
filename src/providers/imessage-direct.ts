import { types as nodeTypes } from "node:util";

import type { OperationInput } from "../model";

export const IMSG_UPSTREAM_VERSION = "0.14.1" as const;
export const IMSG_UPSTREAM_COMMIT =
  "25beb76c902b0acf2dd7ae392f1b0792f6813240" as const;
export const IMSG_PRIVATE_TRANSPORT_PATCH_COMMIT =
  "292db82d89293867ef847a2875667fea0fdd5dc1" as const;
export const IMSG_PRIVATE_TRANSPORT_PATCH_SHA256 =
  "99cf18953470e85a62a226f207e6a5c0452d3997675c99eabf4d5cb73c6411fd" as const;
export const IMSG_EXACT_CHAT_PATCH_COMMIT =
  "c5994f00d17969fd7772fd2772e7b3591089513a" as const;
export const IMSG_EXACT_CHAT_PATCH_SHA256 =
  "b05aa92a078930f96fda611c674436638843f7b148d7bfa3b65ed1ccb0885c13" as const;
export const IMSG_REVIEWED_PATCH_COMMIT = IMSG_EXACT_CHAT_PATCH_COMMIT;
export const IMSG_REVIEWED_PATCHES = Object.freeze([
  Object.freeze({
    commit: IMSG_PRIVATE_TRANSPORT_PATCH_COMMIT,
    sha256: IMSG_PRIVATE_TRANSPORT_PATCH_SHA256,
  }),
  Object.freeze({
    commit: IMSG_EXACT_CHAT_PATCH_COMMIT,
    sha256: IMSG_EXACT_CHAT_PATCH_SHA256,
  }),
]);
export const IMSG_REVIEWED_VERSION =
  "0.14.1+private-transport.2" as const;
export const IMSG_DARWIN_ARM64_EXECUTABLE_SHA256 =
  "77a0db864dfd247cd0a9142dd98997960582e6f150f76ecd3bf1c38944f2bf71" as const;

export const IMSG_TOOL_PIN = Object.freeze({
  id: "imsg-private-transport",
  implementation: "github.com/openclaw/imsg+reviewed-patch",
  version: IMSG_REVIEWED_VERSION,
  upstreamVersion: IMSG_UPSTREAM_VERSION,
  upstreamCommit: IMSG_UPSTREAM_COMMIT,
  reviewedPatchCommit: IMSG_REVIEWED_PATCH_COMMIT,
  reviewedPatches: IMSG_REVIEWED_PATCHES,
  sourceUrl:
    `https://github.com/openclaw/imsg/tree/${IMSG_UPSTREAM_COMMIT}` as const,
  artifacts: Object.freeze([Object.freeze({
    platform: "darwin",
    arch: "arm64",
    executableSha256: IMSG_DARWIN_ARM64_EXECUTABLE_SHA256,
  })]),
} as const);

export const IMSG_ORIGIN = "https://www.apple.com" as const;
export const IMSG_SERVICE = "iMessage" as const;
export const IMSG_TRANSPORT = "applescript" as const;
export const IMSG_ACCOUNT_SELECTION = "device-default" as const;
export const IMSG_SMS_FALLBACK = false as const;
export const IMSG_MAX_CHAT_SCAN = 1_000;
export const IMSG_MAX_MESSAGES = 200;
export const IMSG_MAX_TEXT_BYTES = 65_536;

export const IMSG_DIRECT_OPERATION_NAMES = Object.freeze([
  "messaging.list",
  "conversations.read",
  "messaging.read",
  "messaging.send",
  "messaging.delivery.read",
] as const);

export type ImsgDirectOperationName =
  (typeof IMSG_DIRECT_OPERATION_NAMES)[number];

export type ImsgChatCoordinate = Readonly<{
  chatGuid: string;
  service: typeof IMSG_SERVICE;
  observedChatRowId: number;
}>;

export type ImsgMessagingListInput = Readonly<{ limit: number }>;
export type ImsgConversationReadInput = ImsgChatCoordinate;
export type ImsgMessagingReadInput = ImsgChatCoordinate & Readonly<{ limit: number }>;
export type ImsgMessagingSendInput = ImsgChatCoordinate & Readonly<{ text: string }>;
export type ImsgDeliveryReadInput = ImsgChatCoordinate & Readonly<{
  messageGuid: string;
}>;

export type ImsgDirectOperationInput =
  | ImsgMessagingListInput
  | ImsgConversationReadInput
  | ImsgMessagingReadInput
  | ImsgMessagingSendInput
  | ImsgDeliveryReadInput;

export type ImsgDirectOperationPolicy = Readonly<{
  effect: "read" | "write";
  risk: "R1" | "R3";
  reason: string;
}>;

export const IMSG_DIRECT_OPERATIONS = Object.freeze({
  "messaging.list": Object.freeze({
    effect: "read",
    risk: "R1",
    reason: "list a bounded current local Messages conversation window",
  }),
  "conversations.read": Object.freeze({
    effect: "read",
    risk: "R1",
    reason: "resolve one exact live iMessage chat GUID, service, and database row",
  }),
  "messaging.read": Object.freeze({
    effect: "read",
    risk: "R1",
    reason: "read bounded current context from one exact live iMessage chat",
  }),
  "messaging.send": Object.freeze({
    effect: "write",
    risk: "R3",
    reason: "submit one confirmed text bubble through explicit AppleScript iMessage transport with SMS fallback disabled",
  }),
  "messaging.delivery.read": Object.freeze({
    effect: "read",
    risk: "R1",
    reason: "read the local Messages status row for one exact observed outgoing GUID",
  }),
} satisfies Readonly<
  Record<ImsgDirectOperationName, ImsgDirectOperationPolicy>
>);

type JsonRecord = Readonly<Record<string, unknown>>;

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
  ) throw new Error(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (
      typeof key !== "string"
      || descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) throw new Error(`${label} must contain only enumerable data fields`);
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
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !allowed.has(key))
  ) throw new Error(`${label} has unsupported fields`);
}

function hasWellFormedUnicode(value: string): boolean {
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

export function boundedImsgString(
  value: unknown,
  label: string,
  maximum: number,
  options: Readonly<{ allowEmpty?: boolean; allowNewlines?: boolean }> = {},
): string {
  if (
    typeof value !== "string"
    || (!options.allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
    || !hasWellFormedUnicode(value)
    || value.includes("\0")
    || (!options.allowNewlines && /[\u0001-\u001f\u007f-\u009f]/u.test(value))
  ) throw new Error(`${label} must be bounded well-formed text`);
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) throw new Error(`${label} must be a positive bounded integer`);
  return value;
}

function coordinate(
  source: JsonRecord,
  label: string,
): ImsgChatCoordinate {
  if (source.service !== IMSG_SERVICE) {
    throw new Error(`${label}.service must be exactly iMessage`);
  }
  return Object.freeze({
    chatGuid: boundedImsgString(source.chat_guid, `${label}.chat_guid`, 2_048),
    service: IMSG_SERVICE,
    observedChatRowId: positiveInteger(
      source.observed_chat_row_id,
      `${label}.observed_chat_row_id`,
      Number.MAX_SAFE_INTEGER,
    ),
  });
}

export function isImsgDirectOperation(
  value: string,
): value is ImsgDirectOperationName {
  return (IMSG_DIRECT_OPERATION_NAMES as readonly string[]).includes(value);
}

export function parseImsgDirectOperationInput(
  action: ImsgDirectOperationName,
  value: OperationInput,
): ImsgDirectOperationInput {
  const source = record(value, `${action} input`);
  if (action === "messaging.list") {
    exactKeys(source, [], ["limit"], `${action} input`);
    return Object.freeze({
      limit: source.limit === undefined
        ? 200
        : positiveInteger(source.limit, `${action} input.limit`, IMSG_MAX_CHAT_SCAN),
    });
  }
  const baseKeys = ["chat_guid", "service", "observed_chat_row_id"] as const;
  if (action === "conversations.read") {
    exactKeys(source, baseKeys, [], `${action} input`);
    return coordinate(source, `${action} input`);
  }
  if (action === "messaging.read") {
    exactKeys(source, baseKeys, ["limit"], `${action} input`);
    return Object.freeze({
      ...coordinate(source, `${action} input`),
      limit: source.limit === undefined
        ? 100
        : positiveInteger(source.limit, `${action} input.limit`, IMSG_MAX_MESSAGES),
    });
  }
  if (action === "messaging.send") {
    exactKeys(source, [...baseKeys, "text"], [], `${action} input`);
    return Object.freeze({
      ...coordinate(source, `${action} input`),
      text: boundedImsgString(source.text, `${action} input.text`, IMSG_MAX_TEXT_BYTES, {
        allowNewlines: true,
      }),
    });
  }
  exactKeys(source, [...baseKeys, "message_guid"], [], `${action} input`);
  return Object.freeze({
    ...coordinate(source, `${action} input`),
    messageGuid: boundedImsgString(
      source.message_guid,
      `${action} input.message_guid`,
      2_048,
    ),
  });
}

export type ImsgRpcRequest = Readonly<{
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Readonly<Record<string, unknown>>;
}>;

export function imsgStatusRequest(id = "status"): ImsgRpcRequest {
  return Object.freeze({ jsonrpc: "2.0", id, method: "status", params: Object.freeze({}) });
}

export function imsgOperationRequests(
  action: ImsgDirectOperationName,
  input: ImsgDirectOperationInput,
): readonly ImsgRpcRequest[] {
  if (action === "messaging.list") {
    return Object.freeze([Object.freeze({
      jsonrpc: "2.0",
      id: "operation",
      method: "chats.list",
      params: Object.freeze({ limit: (input as ImsgMessagingListInput).limit }),
    })]);
  }
  const target = input as ImsgChatCoordinate;
  if (action === "conversations.read") {
    return Object.freeze([Object.freeze({
      jsonrpc: "2.0",
      id: "operation",
      method: "chats.get",
      params: Object.freeze({ chat_id: target.observedChatRowId }),
    })]);
  }
  if (action === "messaging.read") {
    return Object.freeze([
      Object.freeze({
        jsonrpc: "2.0",
        id: "route",
        method: "chats.get",
        params: Object.freeze({ chat_id: target.observedChatRowId }),
      }),
      Object.freeze({
        jsonrpc: "2.0",
        id: "operation",
        method: "messages.history",
        params: Object.freeze({
          chat_id: target.observedChatRowId,
          limit: (input as ImsgMessagingReadInput).limit,
          attachments: false,
        }),
      }),
    ]);
  }
  if (action === "messaging.send") {
    return Object.freeze([Object.freeze({
      jsonrpc: "2.0",
      id: "operation",
      method: "send",
      params: Object.freeze({
        chat_guid: target.chatGuid,
        text: (input as ImsgMessagingSendInput).text,
        service: "imessage",
        transport: IMSG_TRANSPORT,
        allow_sms_fallback: IMSG_SMS_FALLBACK,
      }),
    })]);
  }
  return Object.freeze([Object.freeze({
    jsonrpc: "2.0",
    id: "operation",
    method: "message.send_status",
    params: Object.freeze({ guid: (input as ImsgDeliveryReadInput).messageGuid }),
  })]);
}
