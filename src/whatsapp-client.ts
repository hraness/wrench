import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { types as nodeTypes } from "node:util";

import { canonicalJson, sha256 } from "./canonical-json";
import { requireWhatsAppMessageLikeMeReceiptRequestBinding } from "./whatsapp-client-binding";
import type {
  WhatsAppMessageLikeMeClientOptions,
  WhatsAppMessageLikeMeClientRequest,
  WhatsAppMessageLikeMeExportReceipt,
} from "./whatsapp-client-types";
import {
  isWhatsAppExportAuthId,
  isWhatsAppExportOutputDirectory,
} from "./whatsapp-export-coordinate";

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const PROCESS_TIMEOUT_MS = 6 * 60 * 60 * 1_000 + 60_000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

type JsonRecord = Readonly<Record<string, unknown>>;

function fail(message: string): never {
  throw new Error(`Wrench WhatsApp client: ${message}`);
}

function record(value: unknown, label: string): JsonRecord {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) return fail(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return fail(`${label} must contain only enumerable string data fields`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label} must contain only enumerable string data fields`);
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  ));
}

function exact(value: JsonRecord, keys: readonly string[], label: string): void {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unsupported or missing fields`);
  }
}

function timestamp(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string") return fail(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    return fail(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function denseDataArray(
  value: unknown,
  label: string,
  maximum: number,
): readonly unknown[] {
  if (
    nodeTypes.isProxy(value)
    || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
  ) return fail(`${label} must be an ordinary non-proxy array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximum
  ) return fail(`${label} length exceeds its reviewed bound`);
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== length + 1
    || keys.some((key) => typeof key !== "string")
  ) return fail(`${label} must be a dense array without named properties`);
  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !("value" in descriptor)
    ) return fail(`${label} must contain only dense enumerable data elements`);
    items.push(descriptor.value);
  }
  if (keys.some((key) =>
    key !== "length"
    && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)))) {
    return fail(`${label} must be a dense array without named properties`);
  }
  return Object.freeze(items);
}

export function parseWhatsAppMessageLikeMeExportReceipt(
  value: unknown,
): WhatsAppMessageLikeMeExportReceipt {
  const root = record(value, "receipt");
  exact(root, [
    "schemaVersion", "format", "runId", "operation", "status", "transport",
    "startedAt", "finishedAt", "auth", "source", "provider", "completeness",
    "warnings", "counts", "output", "privacy", "integrity",
  ], "receipt");
  if (
    root.schemaVersion !== 1
    || root.format !== "wrench.whatsapp-message-like-me-export-receipt"
    || typeof root.runId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(root.runId)
    || root.operation !== "whatsapp.export-message-like-me"
    || root.status !== "succeeded"
    || root.transport !== "linked-device-local-store"
  ) return fail("receipt identity is unsupported");
  const startedAt = timestamp(root.startedAt, "receipt.startedAt")! as string;
  const finishedAt = timestamp(root.finishedAt, "receipt.finishedAt")! as string;
  if (finishedAt < startedAt) return fail("receipt timestamps are reversed");
  const auth = record(root.auth, "receipt.auth");
  exact(auth, ["id", "provider", "identitySha256"], "receipt.auth");
  if (!isWhatsAppExportAuthId(auth.id)) {
    return fail("receipt.auth.id is not a bounded lowercase auth coordinate");
  }
  const parsedAuthId = auth.id;
  if (auth.provider !== "whatsapp") return fail("receipt auth identity is unsupported");
  const identitySha256 = digest(auth.identitySha256, "receipt.auth.identitySha256");
  const source = record(root.source, "receipt.source");
  exact(source, ["id", "version"], "receipt.source");
  const provider = record(root.provider, "receipt.provider");
  exact(provider, ["id", "version"], "receipt.provider");
  if (
    source.id !== "wacli-local"
    || source.version !== "1.0.0"
    || provider.id !== "whatsapp"
    || provider.version !== "0.15.0"
  ) return fail("receipt producer identity is unsupported");
  const completeness = record(root.completeness, "receipt.completeness");
  exact(completeness, ["kind", "reason", "observedFrom", "observedThrough"], "receipt.completeness");
  if (
    completeness.kind !== "bounded-local"
    || completeness.reason !== "local-store-coverage-unknown"
  ) return fail("receipt completeness boundary is unsupported");
  const observedFrom = timestamp(completeness.observedFrom, "receipt.completeness.observedFrom", true);
  const observedThrough = timestamp(completeness.observedThrough, "receipt.completeness.observedThrough", true);
  if (
    (observedFrom === null) !== (observedThrough === null)
    || (observedFrom !== null && observedThrough !== null && observedThrough < observedFrom)
  ) {
    return fail("receipt completeness timestamps are reversed");
  }
  const warnings = denseDataArray(root.warnings, "receipt.warnings", 5);
  const warningOrder = [
    "remote-history-incomplete",
    "reaction-state-unproven",
    "self-chat-excluded",
    "message-payload-purged",
    "non-conversation-chats-excluded",
  ] as const;
  if (
    warnings[0] !== warningOrder[0]
    || warnings.some((item) => typeof item !== "string" || !warningOrder.includes(
      item as (typeof warningOrder)[number],
    ))
    || warnings.some((item, index) => index > 0
      && warningOrder.indexOf(item as (typeof warningOrder)[number])
        <= warningOrder.indexOf(warnings[index - 1] as (typeof warningOrder)[number]))
  ) return fail("receipt warnings are unsupported");
  type ReceiptWarning = WhatsAppMessageLikeMeExportReceipt["warnings"][number];
  type ReceiptWarningTail = Exclude<ReceiptWarning, "remote-history-incomplete">;
  const warningTail = warnings.slice(1).map((warning) => warning as ReceiptWarningTail);
  const canonicalWarnings: WhatsAppMessageLikeMeExportReceipt["warnings"] = Object.freeze([
    "remote-history-incomplete" as const,
    ...warningTail,
  ]);
  const counts = record(root.counts, "receipt.counts");
  const countKinds = ["account", "participant", "conversation", "message", "reaction", "tombstone"] as const;
  exact(counts, countKinds, "receipt.counts");
  const parsedCounts = Object.fromEntries(countKinds.map((kind) => [
    kind,
    nonNegative(counts[kind], `receipt.counts.${kind}`),
  ])) as Record<(typeof countKinds)[number], number>;
  const observed = observedFrom !== null;
  if (
    parsedCounts.account !== 1
    || parsedCounts.participant < 1
    || parsedCounts.reaction !== 0
    || parsedCounts.tombstone !== 0
    || (parsedCounts.message > 0) !== observed
    || (parsedCounts.conversation > 0) !== observed
    || parsedCounts.conversation > parsedCounts.message
    || parsedCounts.message > 500_000
    || parsedCounts.participant > parsedCounts.message + 1
    || (warnings.includes("message-payload-purged") && parsedCounts.message === 0)
  ) return fail("receipt counts contradict the fixed producer");
  const output = record(root.output, "receipt.output");
  exact(output, ["schemaVersion", "format", "directory", "manifestSha256"], "receipt.output");
  if (!isWhatsAppExportOutputDirectory(output.directory)) {
    return fail("receipt.output.directory is not a bounded normalized non-root absolute directory");
  }
  const parsedOutputDirectory = output.directory;
  if (
    output.schemaVersion !== 2
    || output.format !== "message-like-me.local-message-bundle"
  ) return fail("receipt output identity is unsupported");
  const manifestSha256 = digest(output.manifestSha256, "receipt.output.manifestSha256");
  const privacy = record(root.privacy, "receipt.privacy");
  exact(privacy, [
    "classification", "attachments", "credentials", "sourcePaths", "mediaBytes", "cloudSync",
  ], "receipt.privacy");
  if (
    privacy.classification !== "private-local"
    || privacy.attachments !== "metadata-only"
    || privacy.credentials !== "excluded"
    || privacy.sourcePaths !== "excluded"
    || privacy.mediaBytes !== "excluded"
    || privacy.cloudSync !== "none"
  ) return fail("receipt privacy boundary is unsupported");
  const integrity = record(root.integrity, "receipt.integrity");
  exact(integrity, ["algorithm", "receiptSha256"], "receipt.integrity");
  if (integrity.algorithm !== "sha256") return fail("receipt integrity algorithm is unsupported");
  const expectedDigest = digest(integrity.receiptSha256, "receipt.integrity.receiptSha256");
  const projection = Object.freeze({
    schemaVersion: 1 as const,
    format: "wrench.whatsapp-message-like-me-export-receipt" as const,
    runId: root.runId as string,
    operation: "whatsapp.export-message-like-me" as const,
    status: "succeeded" as const,
    transport: "linked-device-local-store" as const,
    startedAt,
    finishedAt,
    auth: Object.freeze({
      id: parsedAuthId,
      provider: "whatsapp" as const,
      identitySha256,
    }),
    source: Object.freeze({ id: "wacli-local" as const, version: "1.0.0" as const }),
    provider: Object.freeze({ id: "whatsapp" as const, version: "0.15.0" as const }),
    completeness: Object.freeze({
      kind: "bounded-local" as const,
      reason: "local-store-coverage-unknown" as const,
      observedFrom,
      observedThrough,
    }),
    warnings: canonicalWarnings,
    counts: Object.freeze({
      account: 1 as const,
      participant: parsedCounts.participant,
      conversation: parsedCounts.conversation,
      message: parsedCounts.message,
      reaction: 0 as const,
      tombstone: 0 as const,
    }),
    output: Object.freeze({
      schemaVersion: 2 as const,
      format: "message-like-me.local-message-bundle" as const,
      directory: parsedOutputDirectory,
      manifestSha256,
    }),
    privacy: Object.freeze({
      classification: "private-local" as const,
      attachments: "metadata-only" as const,
      credentials: "excluded" as const,
      sourcePaths: "excluded" as const,
      mediaBytes: "excluded" as const,
      cloudSync: "none" as const,
    }),
  });
  if (sha256(canonicalJson(projection)) !== expectedDigest) {
    return fail("receipt digest does not match its canonical projection");
  }
  return Object.freeze({
    ...projection,
    integrity: Object.freeze({ algorithm: "sha256" as const, receiptSha256: expectedDigest }),
  });
}

function cliSourcePath(): string {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource)) return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource)) return packagedSource;
  return fail("the installed Wrench CLI source is unavailable");
}

function preparedEnvironment(
  additions: WhatsAppMessageLikeMeClientOptions["environment"],
): Readonly<Record<string, string>> {
  const environment = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") environment[key] = value;
  }
  if (additions === undefined) return Object.freeze(environment);
  const source = record(additions, "options.environment");
  for (const [key, value] of Object.entries(source)) {
    if (key.length < 1 || key.includes("=") || key.includes("\0")) {
      return fail("environment name is malformed");
    }
    if (value === undefined) delete environment[key];
    else if (typeof value !== "string" || value.includes("\0")) {
      return fail("environment value is malformed");
    } else environment[key] = value;
  }
  return Object.freeze(environment);
}

export function exportWhatsAppMessageLikeMeSync(
  requestValue: WhatsAppMessageLikeMeClientRequest,
  optionsValue: WhatsAppMessageLikeMeClientOptions = {},
): WhatsAppMessageLikeMeExportReceipt {
  if (typeof process.versions.bun !== "string") {
    return fail("@hraness/wrench/whatsapp requires Bun");
  }
  const request = record(requestValue, "request");
  exact(request, ["authId", "output"], "request");
  if (!isWhatsAppExportAuthId(request.authId)) {
    return fail("request.authId is not a bounded lowercase auth coordinate");
  }
  if (!isWhatsAppExportOutputDirectory(request.output)) {
    return fail("request.output is not a bounded normalized non-root absolute directory");
  }
  const requestedAuthId = request.authId;
  const requestedOutput = request.output;
  const requested = Object.freeze({
    authId: requestedAuthId,
    output: requestedOutput,
  });
  const options = record(optionsValue, "options");
  exact(options, Object.hasOwn(options, "environment") ? ["environment"] : [], "options");
  const result = spawnSync(process.execPath, [
    cliSourcePath(),
    "whatsapp",
    "export-message-like-me",
    "--auth",
    requestedAuthId,
    "--output",
    requestedOutput,
    "--json",
  ], {
    cwd: process.cwd(),
    env: preparedEnvironment(options.environment as WhatsAppMessageLikeMeClientOptions["environment"]),
    encoding: "utf8",
    maxBuffer: MAX_STDOUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) return fail("installed CLI could not complete the export");
  if (result.status !== 0 || result.signal !== null) {
    const errorText = typeof result.stderr === "string"
      ? Buffer.from(result.stderr, "utf8").subarray(0, MAX_STDERR_BYTES).toString("utf8").trim()
      : "";
    return fail(errorText.length > 0 ? errorText : "installed CLI rejected the export");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout.trim()) as unknown;
  } catch {
    return fail("installed CLI returned malformed JSON");
  }
  return requireWhatsAppMessageLikeMeReceiptRequestBinding(
    parseWhatsAppMessageLikeMeExportReceipt(raw),
    requested,
  );
}
