/**
 * Beeper Desktop local read policy and fixed official CLI command plans.
 *
 * Wrench never exposes the CLI's raw API, target, command, URL, or token
 * surfaces. The pinned CLI is only a bounded client for the already-authorized
 * local Desktop projection.
 */

import { isAbsolute } from "node:path";

import type { OperationInput } from "../model";

export const BEEPER_CLI_PIN = Object.freeze({
  implementation: "github.com/beeper/cli",
  version: "0.6.2",
  commit: "a416af06023449a87312dc11e54643fd9dc94b8c",
  darwinArm64ArchiveSha256:
    "688ccde7e7d044d33980cd06474bf1ae7215ccf8ca79967262fa3bfb85a2589a",
  darwinArm64BinarySha256:
    "48aa895449129c793a212ea19f69a534adc34a8adc4037ca1d7da9e648716425",
  releaseUrl:
    "https://github.com/beeper/cli/releases/tag/v0.6.2",
  downloadUrl:
    "https://github.com/beeper/cli/releases/download/v0.6.2/beeper-cli-0.6.2-macos-arm64.zip",
} as const);

export const BEEPER_ORIGIN = "https://www.beeper.com" as const;
export const BEEPER_DESKTOP_TARGET = "desktop" as const;

export const BEEPER_LOCAL_OPERATION_NAMES = Object.freeze([
  "contacts.list",
  "messaging.list",
  "messaging.read",
] as const);

export type BeeperLocalOperationName =
  (typeof BEEPER_LOCAL_OPERATION_NAMES)[number];

export const BEEPER_LOCAL_OPERATIONS = Object.freeze({
  "contacts.list": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason:
      "the pinned official Beeper CLI reads one bounded account-aware contact projection from local Desktop in read-only mode; it does not download media or expose raw requests",
  }),
  "messaging.list": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason:
      "the pinned official Beeper CLI reads one bounded local chat projection in read-only mode and preserves account, network, participant, and local-completeness evidence",
  }),
  "messaging.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason:
      "the pinned official Beeper CLI reads one exact account-bound conversation page in read-only mode and preserves reply, edit, deletion, reaction, and attachment-shape evidence",
  }),
} as const);

export type BeeperContactsListInput = Readonly<{
  accountId: string | null;
  limit: number;
}>;

export type BeeperMessagingListInput = Readonly<{
  accountId: string | null;
  limit: number;
}>;

export type BeeperMessagingReadInput = Readonly<{
  accountId: string;
  conversationId: string;
  beforeCursor: string | null;
  afterCursor: string | null;
  limit: number;
}>;

export type BeeperOperationInput =
  | BeeperContactsListInput
  | BeeperMessagingListInput
  | BeeperMessagingReadInput;

export type BeeperReadCommand = Readonly<{
  action: "accounts.list" | BeeperLocalOperationName;
  argv: readonly string[];
}>;

export type BeeperMessageLikeMeExportCommandOptions = Readonly<{
  outputDirectory: string;
  limitChats: number | null;
  limitMessages: number | null;
  maxParticipants: number;
}>;

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
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

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function boundedOpaque(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || Buffer.byteLength(value, "utf8") > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} must be bounded opaque text`);
  return value;
}

function optionalOpaque(
  value: unknown,
  label: string,
  maximum: number,
): string | null {
  return value === undefined ? null : boundedOpaque(value, label, maximum);
}

export function parseBeeperContactsListInput(
  input: OperationInput,
): BeeperContactsListInput {
  const source = record(input, "contacts.list input");
  exactKeys(source, [], ["account_id", "limit"], "contacts.list input");
  return Object.freeze({
    accountId: optionalOpaque(
      source.account_id,
      "contacts.list input.account_id",
      512,
    ),
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "contacts.list input.limit", 1, 200),
  });
}

export function parseBeeperMessagingListInput(
  input: OperationInput,
): BeeperMessagingListInput {
  const source = record(input, "messaging.list input");
  exactKeys(source, [], ["account_id", "limit"], "messaging.list input");
  return Object.freeze({
    accountId: optionalOpaque(
      source.account_id,
      "messaging.list input.account_id",
      512,
    ),
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.list input.limit", 1, 200),
  });
}

export function parseBeeperMessagingReadInput(
  input: OperationInput,
): BeeperMessagingReadInput {
  const source = record(input, "messaging.read input");
  exactKeys(
    source,
    ["account_id", "conversation_id"],
    ["before_cursor", "after_cursor", "limit"],
    "messaging.read input",
  );
  const beforeCursor = optionalOpaque(
    source.before_cursor,
    "messaging.read input.before_cursor",
    2_048,
  );
  const afterCursor = optionalOpaque(
    source.after_cursor,
    "messaging.read input.after_cursor",
    2_048,
  );
  if (beforeCursor !== null && afterCursor !== null) {
    throw new Error("messaging.read input accepts only one cursor direction");
  }
  return Object.freeze({
    accountId: boundedOpaque(
      source.account_id,
      "messaging.read input.account_id",
      512,
    ),
    conversationId: boundedOpaque(
      source.conversation_id,
      "messaging.read input.conversation_id",
      2_048,
    ),
    beforeCursor,
    afterCursor,
    limit: source.limit === undefined
      ? 200
      : integer(source.limit, "messaging.read input.limit", 1, 200),
  });
}

export function parseBeeperOperationInput(
  action: BeeperLocalOperationName,
  input: OperationInput,
): BeeperOperationInput {
  if (action === "contacts.list") return parseBeeperContactsListInput(input);
  if (action === "messaging.list") return parseBeeperMessagingListInput(input);
  return parseBeeperMessagingReadInput(input);
}

function globalArguments(timeoutMs: number): readonly string[] {
  const seconds = Math.max(1, Math.min(3_600, Math.ceil(timeoutMs / 1_000)));
  return Object.freeze([
    "--read-only",
    "--json",
    "--full",
    "--quiet",
    "--target",
    BEEPER_DESKTOP_TARGET,
    "--timeout",
    `${seconds}s`,
  ]);
}

export function planBeeperAccountsListCommand(timeoutMs: number): BeeperReadCommand {
  return Object.freeze({
    action: "accounts.list",
    argv: Object.freeze(["accounts", "list", ...globalArguments(timeoutMs)]),
  });
}

export function planBeeperMessageLikeMeExportCommand(
  options: BeeperMessageLikeMeExportCommandOptions,
  timeoutMs: number,
): readonly string[] {
  const boundedInteger = (
    value: number,
    label: string,
    maximum: number,
  ): number => {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${label} must be an integer from 1 through ${maximum}`);
    }
    return value;
  };
  if (!isAbsolute(options.outputDirectory)) {
    throw new Error("Beeper export output directory must be absolute");
  }
  const maxParticipants = boundedInteger(
    options.maxParticipants,
    "Beeper export maxParticipants",
    2_000,
  );
  const limitChats = options.limitChats === null
    ? null
    : boundedInteger(options.limitChats, "Beeper export limitChats", 100_000);
  const limitMessages = options.limitMessages === null
    ? null
    : boundedInteger(
        options.limitMessages,
        "Beeper export limitMessages",
        1_000_000,
      );
  return Object.freeze([
    "export",
    "--out",
    options.outputDirectory,
    "--no-attachments",
    "--max-participants",
    String(maxParticipants),
    ...(limitChats === null ? [] : ["--limit-chats", String(limitChats)]),
    ...(limitMessages === null
      ? []
      : ["--limit-messages", String(limitMessages)]),
    ...globalArguments(timeoutMs).filter((argument) => argument !== "--json" && argument !== "--full"),
  ]);
}

export function planBeeperReadCommand(
  action: BeeperLocalOperationName,
  input: BeeperOperationInput,
  timeoutMs: number,
): BeeperReadCommand {
  const common = globalArguments(timeoutMs);
  if (action === "contacts.list") {
    const value = input as BeeperContactsListInput;
    return Object.freeze({
      action,
      argv: Object.freeze([
        "contacts",
        "list",
        "--limit",
        String(value.limit),
        ...(value.accountId === null ? [] : ["--account", value.accountId]),
        ...common,
      ]),
    });
  }
  if (action === "messaging.list") {
    const value = input as BeeperMessagingListInput;
    return Object.freeze({
      action,
      argv: Object.freeze([
        "chats",
        "list",
        "--limit",
        String(value.limit),
        ...(value.accountId === null ? [] : ["--account", value.accountId]),
        ...common,
      ]),
    });
  }
  const value = input as BeeperMessagingReadInput;
  return Object.freeze({
    action,
    argv: Object.freeze([
      "messages",
      "list",
      "--chat",
      value.conversationId,
      "--limit",
      String(value.limit),
      ...(value.beforeCursor === null
        ? []
        : ["--before-cursor", value.beforeCursor]),
      ...(value.afterCursor === null
        ? []
        : ["--after-cursor", value.afterCursor]),
      ...common,
    ]),
  });
}

export function isBeeperLocalOperation(
  value: string,
): value is BeeperLocalOperationName {
  return BEEPER_LOCAL_OPERATION_NAMES.includes(
    value as BeeperLocalOperationName,
  );
}
