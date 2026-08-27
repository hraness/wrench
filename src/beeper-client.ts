import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";

import {
  BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES,
  parseBeeperContactInteractionExportResult,
} from "./beeper-contact-interactions";
import type {
  BeeperContactInteractionClientOptions,
  BeeperContactInteractionClientRequest,
  BeeperContactInteractionExportResult,
} from "./beeper-client-types";

const MAX_STDERR_BYTES = 8 * 1024;
const PROCESS_TIMEOUT_MS = 6 * 60 * 60 * 1_000 + 60_000;

function fail(message: string): never {
  throw new Error(`Wrench Beeper client: ${message}`);
}

function cliSourcePath(): string {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource)) return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource)) return packagedSource;
  return fail("the installed Wrench CLI source is unavailable");
}

function requireBunRuntime(): void {
  if (typeof process.versions.bun !== "string") {
    fail("@hraness/wrench/beeper requires Bun to run the installed Wrench CLI");
  }
}

function plainDataObject(
  value: unknown,
  label: string,
): Readonly<Record<string, PropertyDescriptor>> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) return fail(`${label} must use a plain, non-proxy object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(`${label} has unsupported symbol fields`);
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label} must contain only enumerable data properties`);
    }
  }
  return descriptors;
}

function positiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) return fail(`${label} must be an integer from 1 through ${String(maximum)}`);
  return value;
}

function prepareRequest(
  value: BeeperContactInteractionClientRequest,
): Required<Pick<BeeperContactInteractionClientRequest, "authId">>
  & Omit<BeeperContactInteractionClientRequest, "authId"> {
  const descriptors = plainDataObject(value, "request");
  const keys = Object.keys(descriptors);
  const allowed = new Set([
    "authId", "limitChats", "limitMessages", "maxParticipants",
  ]);
  if (!keys.includes("authId") || keys.some((key) => !allowed.has(key))) {
    return fail("request contains unsupported or missing fields");
  }
  const authId = descriptors.authId?.value as unknown;
  if (
    typeof authId !== "string"
    || !/^[a-z][a-z0-9-]{0,127}$/u.test(authId)
  ) return fail("authId must be lowercase kebab text");
  const limitChats = positiveInteger(
    descriptors.limitChats?.value,
    "limitChats",
    100_000,
  );
  const limitMessages = positiveInteger(
    descriptors.limitMessages?.value,
    "limitMessages",
    1_000_000,
  );
  const maxParticipants = positiveInteger(
    descriptors.maxParticipants?.value,
    "maxParticipants",
    2_000,
  );
  return Object.freeze({
    authId,
    ...(limitChats === undefined ? {} : { limitChats }),
    ...(limitMessages === undefined ? {} : { limitMessages }),
    ...(maxParticipants === undefined ? {} : { maxParticipants }),
  });
}

function environmentName(value: string): string {
  if (value.length < 1 || value.includes("=") || value.includes("\0")) {
    return fail("environment name is malformed");
  }
  return value;
}

function prepareEnvironment(
  value: BeeperContactInteractionClientOptions["environment"],
): Readonly<Record<string, string>> {
  const environment = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(process.env)) {
    if (typeof item === "string") environment[key] = item;
  }
  if (value === undefined) return Object.freeze(environment);
  const descriptors = plainDataObject(value, "environment");
  for (const key of Object.keys(descriptors).sort()) {
    const name = environmentName(key);
    const item = descriptors[key]!.value as unknown;
    if (item === undefined) delete environment[name];
    else if (typeof item !== "string" || item.includes("\0")) {
      return fail("environment value is malformed");
    } else environment[name] = item;
  }
  return Object.freeze(environment);
}

function prepareOptions(
  value: BeeperContactInteractionClientOptions,
): Readonly<Record<string, string>> {
  const descriptors = plainDataObject(value, "options");
  const keys = Object.keys(descriptors);
  if (keys.some((key) => key !== "environment")) {
    return fail("options contain an unsupported field");
  }
  return prepareEnvironment(descriptors.environment?.value as
    BeeperContactInteractionClientOptions["environment"]);
}

function boundedError(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_STDERR_BYTES) return text;
  return `${bytes.subarray(0, MAX_STDERR_BYTES).toString("utf8").trim()}…`;
}

/**
 * Execute Wrench's installed, reviewed body-free Beeper export synchronously.
 * The executable is package-owned, not caller-selected. Progress is inherited
 * on stderr and the returned value has passed the exact public artifact parser.
 */
export function exportBeeperContactInteractionsSync(
  requestValue: BeeperContactInteractionClientRequest,
  optionsValue: BeeperContactInteractionClientOptions = {},
): BeeperContactInteractionExportResult {
  requireBunRuntime();
  const request = prepareRequest(requestValue);
  const environment = prepareOptions(optionsValue);
  const result = spawnSync(process.execPath, [
    cliSourcePath(),
    "beeper",
    "export-contact-interactions",
    "--auth",
    request.authId,
    ...(request.limitChats === undefined
      ? []
      : ["--limit-chats", String(request.limitChats)]),
    ...(request.limitMessages === undefined
      ? []
      : ["--limit-messages", String(request.limitMessages)]),
    ...(request.maxParticipants === undefined
      ? []
      : ["--max-participants", String(request.maxParticipants)]),
    "--json",
  ], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) return fail("summary process could not complete");
  if (result.status !== 0 || typeof result.stdout !== "string") {
    const stderr = boundedError(result.stderr);
    return fail(stderr.length === 0 ? "summary process failed" : stderr);
  }
  if (
    Buffer.byteLength(result.stdout, "utf8")
    > BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES
  ) {
    return fail("summary response exceeded its byte bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return fail("summary response was not JSON");
  }
  const resultValue = parseBeeperContactInteractionExportResult(parsed);
  if (resultValue.receipt.auth.id !== request.authId) {
    return fail("summary receipt auth does not match its request");
  }
  const expectedBounds = Object.freeze({
    limitChats: request.limitChats ?? null,
    limitMessages: request.limitMessages ?? null,
    maxParticipants: request.maxParticipants ?? null,
  });
  if (
    resultValue.receipt.bounds.limitChats !== expectedBounds.limitChats
    || resultValue.receipt.bounds.limitMessages !== expectedBounds.limitMessages
    || resultValue.receipt.bounds.maxParticipants !== expectedBounds.maxParticipants
  ) return fail("summary receipt bounds do not match its request");
  return resultValue;
}

export {
  parseBeeperContactInteractionExportResult,
  parseBeeperContactInteractionSummary,
} from "./beeper-contact-interactions";

export type {
  BeeperContactInteraction,
  BeeperContactInteractionAccount,
  BeeperContactInteractionClientOptions,
  BeeperContactInteractionClientRequest,
  BeeperContactInteractionExportBounds,
  BeeperContactInteractionExportReceipt,
  BeeperContactInteractionExportResult,
  BeeperContactInteractionSummary,
} from "./beeper-client-types";
