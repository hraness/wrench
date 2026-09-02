// @bun
import {
  canonicalJson,
  sha256
} from "./index-dqv16dt0.js";

// src/whatsapp-client.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { types as nodeTypes } from "util";

// src/whatsapp-client-binding.ts
function fail(message) {
  throw new Error(`Wrench WhatsApp client: ${message}`);
}
function requireWhatsAppMessageLikeMeReceiptRequestBinding(receipt, request) {
  if (receipt.auth.id !== request.authId) {
    return fail("receipt auth identity does not match the requested auth locator");
  }
  if (receipt.output.directory !== request.output) {
    return fail("receipt output directory does not match the requested output");
  }
  return receipt;
}

// src/whatsapp-export-coordinate.ts
import { dirname, isAbsolute, resolve } from "path";
var WHATSAPP_EXPORT_AUTH_ID_PATTERN = /^[a-z][a-z0-9-]{0,47}$/u;
var MAX_WHATSAPP_EXPORT_OUTPUT_BYTES = 4096;
function isWhatsAppExportAuthId(value) {
  return typeof value === "string" && WHATSAPP_EXPORT_AUTH_ID_PATTERN.test(value);
}
function isWhatsAppExportOutputDirectory(value) {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value && dirname(value) !== value && Buffer.byteLength(value, "utf8") <= MAX_WHATSAPP_EXPORT_OUTPUT_BYTES && !/[\0\r\n]/u.test(value);
}

// src/whatsapp-client.ts
var MAX_STDOUT_BYTES = 2 * 1024 * 1024;
var MAX_STDERR_BYTES = 8 * 1024;
var MAX_V2_RECORDS = 500000;
var PROCESS_TIMEOUT_MS = 6 * 60 * 60 * 1000 + 60000;
var DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
function fail2(message) {
  throw new Error(`Wrench WhatsApp client: ${message}`);
}
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail2(`${label} must be a plain data object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string")
      return fail2(`${label} must contain only enumerable string data fields`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail2(`${label} must contain only enumerable string data fields`);
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])));
}
function exact(value, keys, label) {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (observed.length !== expected.length || observed.some((key, index) => key !== expected[index])) {
    fail2(`${label} contains unsupported or missing fields`);
  }
}
function timestamp(value, label, nullable = false) {
  if (nullable && value === null)
    return null;
  if (typeof value !== "string")
    return fail2(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail2(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}
function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    return fail2(`${label} must be lowercase SHA-256`);
  }
  return value;
}
function nonNegative(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail2(`${label} must be a non-negative safe integer`);
  }
  return value;
}
function denseDataArray(value, label, maximum) {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail2(`${label} must be an ordinary non-proxy array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum)
    return fail2(`${label} length exceeds its reviewed bound`);
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string"))
    return fail2(`${label} must be a dense array without named properties`);
  const items = [];
  for (let index = 0;index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail2(`${label} must contain only dense enumerable data elements`);
    items.push(descriptor.value);
  }
  if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)))) {
    return fail2(`${label} must be a dense array without named properties`);
  }
  return Object.freeze(items);
}
function parseWhatsAppMessageLikeMeExportReceipt(value) {
  const root = record(value, "receipt");
  exact(root, [
    "schemaVersion",
    "format",
    "runId",
    "operation",
    "status",
    "transport",
    "startedAt",
    "finishedAt",
    "auth",
    "source",
    "provider",
    "completeness",
    "warnings",
    "counts",
    "output",
    "privacy",
    "integrity"
  ], "receipt");
  if (root.schemaVersion !== 1 || root.format !== "wrench.whatsapp-message-like-me-export-receipt" || typeof root.runId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(root.runId) || root.operation !== "whatsapp.export-message-like-me" || root.status !== "succeeded" || root.transport !== "linked-device-local-store")
    return fail2("receipt identity is unsupported");
  const startedAt = timestamp(root.startedAt, "receipt.startedAt");
  const finishedAt = timestamp(root.finishedAt, "receipt.finishedAt");
  if (finishedAt < startedAt)
    return fail2("receipt timestamps are reversed");
  const auth = record(root.auth, "receipt.auth");
  exact(auth, ["id", "provider", "identitySha256"], "receipt.auth");
  if (!isWhatsAppExportAuthId(auth.id)) {
    return fail2("receipt.auth.id is not a bounded lowercase auth coordinate");
  }
  const parsedAuthId = auth.id;
  if (auth.provider !== "whatsapp")
    return fail2("receipt auth identity is unsupported");
  const identitySha256 = digest(auth.identitySha256, "receipt.auth.identitySha256");
  const source = record(root.source, "receipt.source");
  exact(source, ["id", "version"], "receipt.source");
  const provider = record(root.provider, "receipt.provider");
  exact(provider, ["id", "version"], "receipt.provider");
  if (source.id !== "wacli-local" || source.version !== "1.0.0" || provider.id !== "whatsapp" || provider.version !== "0.15.0")
    return fail2("receipt producer identity is unsupported");
  const completeness = record(root.completeness, "receipt.completeness");
  exact(completeness, ["kind", "reason", "observedFrom", "observedThrough"], "receipt.completeness");
  if (completeness.kind !== "bounded-local" || completeness.reason !== "local-store-coverage-unknown")
    return fail2("receipt completeness boundary is unsupported");
  const observedFrom = timestamp(completeness.observedFrom, "receipt.completeness.observedFrom", true);
  const observedThrough = timestamp(completeness.observedThrough, "receipt.completeness.observedThrough", true);
  if (observedFrom === null !== (observedThrough === null) || observedFrom !== null && observedThrough !== null && observedThrough < observedFrom) {
    return fail2("receipt completeness timestamps are reversed");
  }
  const warnings = denseDataArray(root.warnings, "receipt.warnings", 5);
  const warningOrder = [
    "remote-history-incomplete",
    "reaction-state-unproven",
    "self-chat-excluded",
    "message-payload-purged",
    "non-conversation-chats-excluded"
  ];
  if (warnings[0] !== warningOrder[0] || warnings.some((item) => typeof item !== "string" || !warningOrder.includes(item)) || warnings.some((item, index) => index > 0 && warningOrder.indexOf(item) <= warningOrder.indexOf(warnings[index - 1])))
    return fail2("receipt warnings are unsupported");
  const warningTail = warnings.slice(1).map((warning) => warning);
  const canonicalWarnings = Object.freeze([
    "remote-history-incomplete",
    ...warningTail
  ]);
  const counts = record(root.counts, "receipt.counts");
  const countKinds = ["account", "participant", "conversation", "message", "reaction", "tombstone"];
  exact(counts, countKinds, "receipt.counts");
  const parsedCounts = Object.fromEntries(countKinds.map((kind) => [
    kind,
    nonNegative(counts[kind], `receipt.counts.${kind}`)
  ]));
  const observed = observedFrom !== null;
  const totalRecords = countKinds.reduce((total, kind) => total + parsedCounts[kind], 0);
  if (parsedCounts.account !== 1 || parsedCounts.participant < 1 || parsedCounts.reaction !== 0 || parsedCounts.tombstone !== 0 || parsedCounts.message > 0 !== observed || parsedCounts.conversation > 0 !== observed || parsedCounts.conversation > parsedCounts.message || parsedCounts.message > MAX_V2_RECORDS || parsedCounts.participant > parsedCounts.message + 1 || !Number.isSafeInteger(totalRecords) || totalRecords > MAX_V2_RECORDS || warnings.includes("message-payload-purged") && parsedCounts.message === 0)
    return fail2("receipt counts contradict the fixed producer");
  const output = record(root.output, "receipt.output");
  exact(output, ["schemaVersion", "format", "directory", "manifestSha256"], "receipt.output");
  if (!isWhatsAppExportOutputDirectory(output.directory)) {
    return fail2("receipt.output.directory is not a bounded normalized non-root absolute directory");
  }
  const parsedOutputDirectory = output.directory;
  if (output.schemaVersion !== 2 || output.format !== "message-like-me.local-message-bundle")
    return fail2("receipt output identity is unsupported");
  const manifestSha256 = digest(output.manifestSha256, "receipt.output.manifestSha256");
  const privacy = record(root.privacy, "receipt.privacy");
  exact(privacy, [
    "classification",
    "attachments",
    "credentials",
    "sourcePaths",
    "mediaBytes",
    "cloudSync"
  ], "receipt.privacy");
  if (privacy.classification !== "private-local" || privacy.attachments !== "metadata-only" || privacy.credentials !== "excluded" || privacy.sourcePaths !== "excluded" || privacy.mediaBytes !== "excluded" || privacy.cloudSync !== "none")
    return fail2("receipt privacy boundary is unsupported");
  const integrity = record(root.integrity, "receipt.integrity");
  exact(integrity, ["algorithm", "receiptSha256"], "receipt.integrity");
  if (integrity.algorithm !== "sha256")
    return fail2("receipt integrity algorithm is unsupported");
  const expectedDigest = digest(integrity.receiptSha256, "receipt.integrity.receiptSha256");
  const projection = Object.freeze({
    schemaVersion: 1,
    format: "wrench.whatsapp-message-like-me-export-receipt",
    runId: root.runId,
    operation: "whatsapp.export-message-like-me",
    status: "succeeded",
    transport: "linked-device-local-store",
    startedAt,
    finishedAt,
    auth: Object.freeze({
      id: parsedAuthId,
      provider: "whatsapp",
      identitySha256
    }),
    source: Object.freeze({ id: "wacli-local", version: "1.0.0" }),
    provider: Object.freeze({ id: "whatsapp", version: "0.15.0" }),
    completeness: Object.freeze({
      kind: "bounded-local",
      reason: "local-store-coverage-unknown",
      observedFrom,
      observedThrough
    }),
    warnings: canonicalWarnings,
    counts: Object.freeze({
      account: 1,
      participant: parsedCounts.participant,
      conversation: parsedCounts.conversation,
      message: parsedCounts.message,
      reaction: 0,
      tombstone: 0
    }),
    output: Object.freeze({
      schemaVersion: 2,
      format: "message-like-me.local-message-bundle",
      directory: parsedOutputDirectory,
      manifestSha256
    }),
    privacy: Object.freeze({
      classification: "private-local",
      attachments: "metadata-only",
      credentials: "excluded",
      sourcePaths: "excluded",
      mediaBytes: "excluded",
      cloudSync: "none"
    })
  });
  if (sha256(canonicalJson(projection)) !== expectedDigest) {
    return fail2("receipt digest does not match its canonical projection");
  }
  return Object.freeze({
    ...projection,
    integrity: Object.freeze({ algorithm: "sha256", receiptSha256: expectedDigest })
  });
}
function cliSourcePath() {
  const besideSource = fileURLToPath(new URL("./cli.ts", import.meta.url));
  if (existsSync(besideSource))
    return besideSource;
  const packagedSource = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  if (existsSync(packagedSource))
    return packagedSource;
  return fail2("the installed Wrench CLI source is unavailable");
}
function preparedEnvironment(additions) {
  const environment = Object.create(null);
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string")
      environment[key] = value;
  }
  if (additions === undefined)
    return Object.freeze(environment);
  const source = record(additions, "options.environment");
  for (const [key, value] of Object.entries(source)) {
    if (key.length < 1 || key.includes("=") || key.includes("\x00")) {
      return fail2("environment name is malformed");
    }
    if (value === undefined)
      delete environment[key];
    else if (typeof value !== "string" || value.includes("\x00")) {
      return fail2("environment value is malformed");
    } else
      environment[key] = value;
  }
  return Object.freeze(environment);
}
function exportWhatsAppMessageLikeMeSync(requestValue, optionsValue = {}) {
  if (typeof process.versions.bun !== "string") {
    return fail2("@hraness/wrench/whatsapp requires Bun");
  }
  const request = record(requestValue, "request");
  exact(request, ["authId", "output"], "request");
  if (!isWhatsAppExportAuthId(request.authId)) {
    return fail2("request.authId is not a bounded lowercase auth coordinate");
  }
  if (!isWhatsAppExportOutputDirectory(request.output)) {
    return fail2("request.output is not a bounded normalized non-root absolute directory");
  }
  const requestedAuthId = request.authId;
  const requestedOutput = request.output;
  const requested = Object.freeze({
    authId: requestedAuthId,
    output: requestedOutput
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
    "--json"
  ], {
    cwd: process.cwd(),
    env: preparedEnvironment(options.environment),
    encoding: "utf8",
    maxBuffer: MAX_STDOUT_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "inherit"]
  });
  if (result.error !== undefined)
    return fail2("installed CLI could not complete the export");
  if (result.status !== 0 || result.signal !== null) {
    const errorText = typeof result.stderr === "string" ? Buffer.from(result.stderr, "utf8").subarray(0, MAX_STDERR_BYTES).toString("utf8").trim() : "";
    return fail2(errorText.length > 0 ? errorText : "installed CLI rejected the export");
  }
  let raw;
  try {
    raw = JSON.parse(result.stdout.trim());
  } catch {
    return fail2("installed CLI returned malformed JSON");
  }
  return requireWhatsAppMessageLikeMeReceiptRequestBinding(parseWhatsAppMessageLikeMeExportReceipt(raw), requested);
}
export {
  parseWhatsAppMessageLikeMeExportReceipt,
  exportWhatsAppMessageLikeMeSync
};
