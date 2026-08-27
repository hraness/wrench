// @bun
import {
  canonicalJson,
  sha256
} from "./index-dqv16dt0.js";

// src/beeper-client.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { types as nodeTypes2 } from "util";

// src/beeper-contact-interactions.ts
import { types as nodeTypes } from "util";
import {
  LOCAL_MESSAGE_BUNDLE_V1_LIMITS,
  LOCAL_MESSAGE_BUNDLE_V1_SOURCE_TRANSFORM_VERSION
} from "@hraness/message-like-me/message-bundle-v1";

// src/providers/beeper-local.ts
var BEEPER_CLI_PIN = Object.freeze({
  implementation: "github.com/beeper/cli",
  version: "0.6.2",
  commit: "a416af06023449a87312dc11e54643fd9dc94b8c",
  darwinArm64ArchiveSha256: "688ccde7e7d044d33980cd06474bf1ae7215ccf8ca79967262fa3bfb85a2589a",
  darwinArm64BinarySha256: "48aa895449129c793a212ea19f69a534adc34a8adc4037ca1d7da9e648716425",
  releaseUrl: "https://github.com/beeper/cli/releases/tag/v0.6.2",
  downloadUrl: "https://github.com/beeper/cli/releases/download/v0.6.2/beeper-cli-0.6.2-macos-arm64.zip"
});
var BEEPER_LOCAL_OPERATION_NAMES = Object.freeze([
  "contacts.list",
  "contacts.search",
  "messaging.list",
  "messaging.search",
  "messaging.read"
]);
var BEEPER_LOCAL_OPERATIONS = Object.freeze({
  "contacts.list": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason: "the pinned official Beeper CLI reads one bounded account-aware contact projection from local Desktop in read-only mode; it does not download media or expose raw requests"
  }),
  "contacts.search": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason: "the pinned official Beeper CLI performs one bounded account-aware fuzzy contact search against local Desktop in read-only mode and returns candidate identity metadata without media or private content"
  }),
  "messaging.list": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason: "the pinned official Beeper CLI reads one bounded local chat projection in read-only mode and preserves account, network, participant, and local-completeness evidence"
  }),
  "messaging.search": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason: "the pinned official Beeper CLI performs one bounded account-aware fuzzy chat search against local Desktop in read-only mode and returns candidate conversation and participant identity metadata without message content or private UI state"
  }),
  "messaging.read": Object.freeze({
    effect: "read",
    risk: "R1",
    state: "observed",
    reason: "the pinned official Beeper CLI reads one exact account-bound conversation page in read-only mode and preserves reply, edit, deletion, reaction, and attachment-shape evidence"
  })
});

// src/version.ts
var WRENCH_VERSION = "0.14.0";

// src/beeper-contact-interactions.ts
var BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION = 1;
var BEEPER_CONTACT_INTERACTION_FORMAT = "wrench.contact-interaction-summary";
var BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT = "wrench.beeper-contact-interaction-export-receipt";
var BEEPER_CONTACT_INTERACTION_TRANSFORM = Object.freeze({
  id: "beeper-direct-contact-interactions",
  version: 1,
  sourceVersion: LOCAL_MESSAGE_BUNDLE_V1_SOURCE_TRANSFORM_VERSION
});
var BEEPER_CONTACT_INTERACTION_IMPLEMENTATION = Object.freeze({
  producer: Object.freeze({
    package: "@hraness/wrench",
    version: WRENCH_VERSION
  }),
  officialCli: Object.freeze({
    implementation: BEEPER_CLI_PIN.implementation,
    version: BEEPER_CLI_PIN.version,
    commit: BEEPER_CLI_PIN.commit,
    platform: "darwin-arm64",
    binarySha256: BEEPER_CLI_PIN.darwinArm64BinarySha256
  })
});
var MAX_RECORDS = LOCAL_MESSAGE_BUNDLE_V1_LIMITS.records;
var MAX_COORDINATE_BYTES = 4 * 1024;
var MAX_NETWORK_BYTES = 64;
var CONTACT_INTERACTION_WARNING_CODES = Object.freeze([
  "group-messages-excluded",
  "incomplete-direct-rosters-excluded",
  "message-content-excluded",
  "replacement-message-versions-excluded"
]);
var MAX_WARNINGS = LOCAL_MESSAGE_BUNDLE_V1_LIMITS.warnings + CONTACT_INTERACTION_WARNING_CODES.length;
var MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
var BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES = MAX_OUTPUT_BYTES * 3 + 1024 * 1024;
function fail(message) {
  throw new Error(`Beeper contact interaction summary: ${message}`);
}
function record(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail(`${label} must not contain symbol fields`);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
}
function boundedArray(value, label, maximum) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum)
    return fail(`${label} must be a bounded plain array`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") || keys.length !== value.length + 1 || keys[keys.length - 1] !== "length")
    return fail(`${label} must not contain holes or custom fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0;index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail(`${label}[${String(index)}] must be an enumerable data property`);
    }
  }
  return value;
}
function exactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(`${label} contains unsupported or missing fields`);
}
function coordinate(value, label) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > MAX_COORDINATE_BYTES || /[\u0000-\u001f\u007f]/u.test(value))
    return fail(`${label} must be bounded provider text`);
  return value;
}
function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function token(value, label, maximum = 128) {
  const parsed = coordinate(value, label);
  if (Buffer.byteLength(parsed, "utf8") > maximum || !/^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/u.test(parsed))
    return fail(`${label} must be a token`);
  return parsed;
}
function digest(value, label) {
  const parsed = token(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(parsed))
    return fail(`${label} must be a SHA-256 digest`);
  return parsed;
}
function integer(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return fail(`${label} must be a non-negative integer`);
  return value;
}
function timestamp(value, label) {
  const parsed = coordinate(value, label);
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed) {
    return fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}
function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}
function providerId(kind, ...parts) {
  return `beeper-${kind}:${sha256(canonicalJson(parts))}`;
}
function summaryProjection(value) {
  return value;
}
function parseStringArray(value, label, maximum) {
  const parsed = boundedArray(value, label, maximum).map((item, index) => token(item, `${label}[${String(index)}]`));
  if (new Set(parsed).size !== parsed.length)
    return fail(`${label} contains duplicates`);
  return Object.freeze(parsed);
}
function parseBeeperContactInteractionSummary(value) {
  const source = record(value, "summary");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "transform",
    "source",
    "provider",
    "observedAt",
    "scope",
    "completeness",
    "warnings",
    "privacy",
    "counts",
    "accounts",
    "interactions",
    "integrity"
  ], "summary");
  if (source.schemaVersion !== BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION || source.format !== BEEPER_CONTACT_INTERACTION_FORMAT)
    return fail("schema is unsupported");
  const transform = record(source.transform, "summary.transform");
  exactKeys(transform, ["id", "version", "sourceVersion"], "summary.transform");
  if (transform.id !== BEEPER_CONTACT_INTERACTION_TRANSFORM.id || transform.version !== BEEPER_CONTACT_INTERACTION_TRANSFORM.version || transform.sourceVersion !== BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion)
    return fail("transform is unsupported");
  const sourceValue = record(source.source, "summary.source");
  exactKeys(sourceValue, ["id", "version"], "summary.source");
  if (sourceValue.id !== "beeper-local" || sourceValue.version !== BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion)
    return fail("source is unsupported");
  const provider = record(source.provider, "summary.provider");
  exactKeys(provider, ["id", "version"], "summary.provider");
  if (provider.id !== "beeper")
    return fail("provider is unsupported");
  const providerVersion = token(provider.version, "summary.provider.version");
  const observedAt = nullableTimestamp(source.observedAt, "summary.observedAt");
  const scope = record(source.scope, "summary.scope");
  exactKeys(scope, ["conversations", "messages"], "summary.scope");
  if (scope.conversations !== "complete-direct-only" || scope.messages !== "current-direction-known-only")
    return fail("scope is unsupported");
  const completeness = record(source.completeness, "summary.completeness");
  exactKeys(completeness, [
    "kind",
    "sourceKind",
    "reason",
    "observedFrom",
    "observedThrough"
  ], "summary.completeness");
  if (completeness.kind !== "lower-bound")
    return fail("completeness kind is unsupported");
  if (completeness.sourceKind !== "bounded-local" && completeness.sourceKind !== "truncated" && completeness.sourceKind !== "unknown")
    return fail("source completeness kind is unsupported");
  const reason = completeness.reason === null ? null : token(completeness.reason, "summary.completeness.reason");
  const observedFrom = nullableTimestamp(completeness.observedFrom, "summary.completeness.observedFrom");
  const observedThrough = nullableTimestamp(completeness.observedThrough, "summary.completeness.observedThrough");
  if (observedFrom !== null && observedThrough !== null && observedFrom > observedThrough) {
    return fail("completeness timestamps are reversed");
  }
  const warnings = parseStringArray(source.warnings, "summary.warnings", MAX_WARNINGS);
  const privacy = record(source.privacy, "summary.privacy");
  exactKeys(privacy, [
    "messageBodies",
    "attachments",
    "reactions",
    "media",
    "groupMessages",
    "localPaths",
    "credentials"
  ], "summary.privacy");
  if (privacy.messageBodies !== "excluded" || privacy.attachments !== "excluded" || privacy.reactions !== "excluded" || privacy.media !== "excluded" || privacy.groupMessages !== "excluded" || privacy.localPaths !== "excluded" || privacy.credentials !== "excluded")
    return fail("privacy boundary is unsupported");
  const counts = record(source.counts, "summary.counts");
  exactKeys(counts, [
    "accounts",
    "directRelationships",
    "directConversations",
    "interactions",
    "sent",
    "received"
  ], "summary.counts");
  const parsedCounts = Object.freeze({
    accounts: integer(counts.accounts, "summary.counts.accounts"),
    directRelationships: integer(counts.directRelationships, "summary.counts.directRelationships"),
    directConversations: integer(counts.directConversations, "summary.counts.directConversations"),
    interactions: integer(counts.interactions, "summary.counts.interactions"),
    sent: integer(counts.sent, "summary.counts.sent"),
    received: integer(counts.received, "summary.counts.received")
  });
  const accountValues = boundedArray(source.accounts, "summary.accounts", MAX_RECORDS);
  const accounts = Object.freeze(accountValues.map((item, index) => {
    const account = record(item, `summary.accounts[${String(index)}]`);
    exactKeys(account, [
      "accountId",
      "accountProviderId",
      "network",
      "selfParticipantId",
      "selfParticipantProviderId",
      "observedAt"
    ], `summary.accounts[${String(index)}]`);
    const accountId = coordinate(account.accountId, `summary.accounts[${String(index)}].accountId`);
    const expectedProviderId = providerId("account", accountId);
    const accountProviderId = coordinate(account.accountProviderId, `summary.accounts[${String(index)}].accountProviderId`);
    if (accountProviderId !== expectedProviderId)
      return fail("an account provider coordinate is invalid");
    const selfParticipantId = coordinate(account.selfParticipantId, `summary.accounts[${String(index)}].selfParticipantId`);
    const selfParticipantProviderId = coordinate(account.selfParticipantProviderId, `summary.accounts[${String(index)}].selfParticipantProviderId`);
    if (selfParticipantProviderId !== providerId("participant", accountId, selfParticipantId))
      return fail("an account self provider coordinate is invalid");
    return Object.freeze({
      accountId,
      accountProviderId,
      network: token(account.network, `summary.accounts[${String(index)}].network`, MAX_NETWORK_BYTES),
      selfParticipantId,
      selfParticipantProviderId,
      observedAt: timestamp(account.observedAt, `summary.accounts[${String(index)}].observedAt`)
    });
  }));
  const accountKeys = accounts.map((account) => account.accountId);
  if (new Set(accountKeys).size !== accountKeys.length || accountKeys.some((key, index) => index > 0 && compareCanonicalText(key, accountKeys[index - 1]) <= 0))
    return fail("accounts are not unique and canonically ordered");
  const interactionValues = boundedArray(source.interactions, "summary.interactions", MAX_RECORDS);
  const accountsById = new Map(accounts.map((account) => [account.accountId, account]));
  const interactions = Object.freeze(interactionValues.map((item, index) => {
    const interaction = record(item, `summary.interactions[${String(index)}]`);
    exactKeys(interaction, [
      "accountId",
      "accountProviderId",
      "contactId",
      "contactProviderId",
      "network",
      "sentCount",
      "receivedCount",
      "interactionCount",
      "conversationCount",
      "firstInteractionAt",
      "lastInteractionAt",
      "reciprocal",
      "completeness",
      "provenance"
    ], `summary.interactions[${String(index)}]`);
    const accountId = coordinate(interaction.accountId, `summary.interactions[${String(index)}].accountId`);
    const account = accountsById.get(accountId);
    if (account === undefined)
      return fail("an interaction references an unknown account");
    const accountProviderId = coordinate(interaction.accountProviderId, `summary.interactions[${String(index)}].accountProviderId`);
    if (accountProviderId !== account.accountProviderId) {
      return fail("an interaction account provider coordinate is invalid");
    }
    const contactId = coordinate(interaction.contactId, `summary.interactions[${String(index)}].contactId`);
    if (contactId === account.selfParticipantId) {
      return fail("an interaction contact cannot be the account self participant");
    }
    const contactProviderId = coordinate(interaction.contactProviderId, `summary.interactions[${String(index)}].contactProviderId`);
    if (contactProviderId !== providerId("participant", accountId, contactId)) {
      return fail("an interaction contact provider coordinate is invalid");
    }
    const network = token(interaction.network, `summary.interactions[${String(index)}].network`, MAX_NETWORK_BYTES);
    if (network !== account.network)
      return fail("an interaction changed account networks");
    const sentCount = integer(interaction.sentCount, `summary.interactions[${String(index)}].sentCount`);
    const receivedCount = integer(interaction.receivedCount, `summary.interactions[${String(index)}].receivedCount`);
    const interactionCount = integer(interaction.interactionCount, `summary.interactions[${String(index)}].interactionCount`);
    const conversationCount = integer(interaction.conversationCount, `summary.interactions[${String(index)}].conversationCount`);
    if (interactionCount !== sentCount + receivedCount || interactionCount < 1 || conversationCount < 1 || conversationCount > interactionCount || interaction.reciprocal !== (sentCount > 0 && receivedCount > 0) || interaction.completeness !== "lower-bound")
      return fail("an interaction has inconsistent counts or completeness");
    const firstInteractionAt = timestamp(interaction.firstInteractionAt, `summary.interactions[${String(index)}].firstInteractionAt`);
    const lastInteractionAt = timestamp(interaction.lastInteractionAt, `summary.interactions[${String(index)}].lastInteractionAt`);
    if (firstInteractionAt > lastInteractionAt)
      return fail("interaction timestamps are reversed");
    const provenance = record(interaction.provenance, `summary.interactions[${String(index)}].provenance`);
    exactKeys(provenance, [
      "sourceId",
      "sourceVersion",
      "providerId",
      "providerVersion",
      "observedAt"
    ], `summary.interactions[${String(index)}].provenance`);
    if (provenance.sourceId !== "beeper-local" || provenance.sourceVersion !== BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion || provenance.providerId !== "beeper" || provenance.providerVersion !== providerVersion)
      return fail("interaction provenance is unsupported");
    return Object.freeze({
      accountId,
      accountProviderId,
      contactId,
      contactProviderId,
      network,
      sentCount,
      receivedCount,
      interactionCount,
      conversationCount,
      firstInteractionAt,
      lastInteractionAt,
      reciprocal: interaction.reciprocal,
      completeness: "lower-bound",
      provenance: Object.freeze({
        sourceId: "beeper-local",
        sourceVersion: BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion,
        providerId: "beeper",
        providerVersion,
        observedAt: timestamp(provenance.observedAt, `summary.interactions[${String(index)}].provenance.observedAt`)
      })
    });
  }));
  const interactionKeys = interactions.map((item) => `${item.accountId}\x00${item.contactId}`);
  if (new Set(interactionKeys).size !== interactionKeys.length || interactionKeys.some((key, index) => index > 0 && compareCanonicalText(key, interactionKeys[index - 1]) <= 0))
    return fail("interactions are not unique and canonically ordered");
  if ((accounts.length > 0 || interactions.length > 0) && (observedAt === null || accounts.some((account) => account.observedAt > observedAt) || interactions.some((interaction) => interaction.provenance.observedAt > observedAt)))
    return fail("summary observation does not cover retained relationship facts");
  const expectedSent = interactions.reduce((sum, item) => sum + item.sentCount, 0);
  const expectedReceived = interactions.reduce((sum, item) => sum + item.receivedCount, 0);
  if (parsedCounts.accounts !== accounts.length || parsedCounts.directRelationships !== interactions.length || parsedCounts.interactions !== expectedSent + expectedReceived || parsedCounts.sent !== expectedSent || parsedCounts.received !== expectedReceived || parsedCounts.directConversations !== interactions.reduce((sum, item) => sum + item.conversationCount, 0))
    return fail("summary counts are inconsistent");
  const integrity = record(source.integrity, "summary.integrity");
  exactKeys(integrity, ["algorithm", "summarySha256"], "summary.integrity");
  if (integrity.algorithm !== "sha256")
    return fail("integrity algorithm is unsupported");
  const summarySha256 = digest(integrity.summarySha256, "summary.integrity.summarySha256");
  const projection = Object.freeze({
    schemaVersion: BEEPER_CONTACT_INTERACTION_SCHEMA_VERSION,
    format: BEEPER_CONTACT_INTERACTION_FORMAT,
    transform: BEEPER_CONTACT_INTERACTION_TRANSFORM,
    source: Object.freeze({
      id: "beeper-local",
      version: BEEPER_CONTACT_INTERACTION_TRANSFORM.sourceVersion
    }),
    provider: Object.freeze({ id: "beeper", version: providerVersion }),
    observedAt,
    scope: Object.freeze({
      conversations: "complete-direct-only",
      messages: "current-direction-known-only"
    }),
    completeness: Object.freeze({
      kind: "lower-bound",
      sourceKind: completeness.sourceKind,
      reason,
      observedFrom,
      observedThrough
    }),
    warnings,
    privacy: Object.freeze({
      messageBodies: "excluded",
      attachments: "excluded",
      reactions: "excluded",
      media: "excluded",
      groupMessages: "excluded",
      localPaths: "excluded",
      credentials: "excluded"
    }),
    counts: parsedCounts,
    accounts,
    interactions
  });
  if (sha256(canonicalJson(summaryProjection(projection))) !== summarySha256) {
    return fail("integrity digest does not bind the summary projection");
  }
  return Object.freeze({
    ...projection,
    integrity: Object.freeze({ algorithm: "sha256", summarySha256 })
  });
}
function receiptProjection(receipt) {
  return receipt;
}
function nullableBound(value, label, maximum) {
  if (value === null)
    return null;
  const parsed = integer(value, label);
  if (parsed < 1 || parsed > maximum) {
    return fail(`${label} is outside its supported bound`);
  }
  return parsed;
}
function parseBeeperContactInteractionExportResult(value) {
  const envelope = record(value, "export result");
  exactKeys(envelope, ["receipt", "output"], "export result");
  const output = parseBeeperContactInteractionSummary(envelope.output);
  const source = record(envelope.receipt, "export receipt");
  exactKeys(source, [
    "schemaVersion",
    "format",
    "runId",
    "operation",
    "status",
    "transport",
    "implementation",
    "startedAt",
    "finishedAt",
    "auth",
    "bounds",
    "source",
    "provider",
    "transform",
    "completeness",
    "counts",
    "output",
    "privacy",
    "integrity"
  ], "export receipt");
  if (source.schemaVersion !== 1 || source.format !== BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT || source.operation !== "beeper.export-contact-interactions" || source.status !== "succeeded" || source.transport !== "linked-device")
    return fail("export receipt identity is unsupported");
  const implementation = record(source.implementation, "export receipt.implementation");
  exactKeys(implementation, ["producer", "officialCli"], "export receipt.implementation");
  const producer = record(implementation.producer, "export receipt.implementation.producer");
  exactKeys(producer, ["package", "version"], "export receipt.implementation.producer");
  const officialCli = record(implementation.officialCli, "export receipt.implementation.officialCli");
  exactKeys(officialCli, ["implementation", "version", "commit", "platform", "binarySha256"], "export receipt.implementation.officialCli");
  if (producer.package !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.producer.package || producer.version !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.producer.version || officialCli.implementation !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.implementation || officialCli.version !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.version || officialCli.commit !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.commit || officialCli.platform !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.platform || officialCli.binarySha256 !== BEEPER_CONTACT_INTERACTION_IMPLEMENTATION.officialCli.binarySha256)
    return fail("export receipt implementation identity is unsupported");
  const runId = coordinate(source.runId, "export receipt.runId");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(runId)) {
    return fail("export receipt.runId must be a lowercase UUID v4");
  }
  const startedAt = timestamp(source.startedAt, "export receipt.startedAt");
  const finishedAt = timestamp(source.finishedAt, "export receipt.finishedAt");
  if (startedAt > finishedAt)
    return fail("export receipt timestamps are reversed");
  const auth = record(source.auth, "export receipt.auth");
  exactKeys(auth, ["id", "kind", "provider", "identitySha256"], "export receipt.auth");
  const authId = coordinate(auth.id, "export receipt.auth.id");
  if (!/^[a-z][a-z0-9-]{0,127}$/u.test(authId) || auth.kind !== "linked-device-store" || auth.provider !== "beeper")
    return fail("export receipt auth identity is unsupported");
  const identitySha256 = digest(auth.identitySha256, "export receipt.auth.identitySha256");
  const bounds = record(source.bounds, "export receipt.bounds");
  exactKeys(bounds, ["limitChats", "limitMessages", "maxParticipants"], "export receipt.bounds");
  const parsedBounds = Object.freeze({
    limitChats: nullableBound(bounds.limitChats, "export receipt.bounds.limitChats", 1e5),
    limitMessages: nullableBound(bounds.limitMessages, "export receipt.bounds.limitMessages", 1e6),
    maxParticipants: nullableBound(bounds.maxParticipants, "export receipt.bounds.maxParticipants", 2000)
  });
  for (const [field, expected] of [
    ["source", output.source],
    ["provider", output.provider],
    ["transform", output.transform],
    ["completeness", output.completeness],
    ["counts", output.counts]
  ]) {
    const parsed = record(source[field], `export receipt.${field}`);
    if (canonicalJson(parsed) !== canonicalJson(expected)) {
      return fail(`export receipt.${field} does not bind the output`);
    }
  }
  const outputBinding = record(source.output, "export receipt.output");
  exactKeys(outputBinding, ["schemaVersion", "format", "summarySha256"], "export receipt.output");
  const summarySha256 = digest(outputBinding.summarySha256, "export receipt.output.summarySha256");
  if (outputBinding.schemaVersion !== output.schemaVersion || outputBinding.format !== output.format || summarySha256 !== output.integrity.summarySha256)
    return fail("export receipt output identity does not bind the summary");
  const privacy = record(source.privacy, "export receipt.privacy");
  exactKeys(privacy, [
    "messageBodies",
    "attachments",
    "reactions",
    "media",
    "localPaths",
    "credentials"
  ], "export receipt.privacy");
  if (Object.values(privacy).some((item) => item !== "excluded")) {
    return fail("export receipt privacy boundary is unsupported");
  }
  const projection = Object.freeze({
    schemaVersion: 1,
    format: BEEPER_CONTACT_INTERACTION_RECEIPT_FORMAT,
    runId,
    operation: "beeper.export-contact-interactions",
    status: "succeeded",
    transport: "linked-device",
    implementation: BEEPER_CONTACT_INTERACTION_IMPLEMENTATION,
    startedAt,
    finishedAt,
    auth: Object.freeze({
      id: authId,
      kind: "linked-device-store",
      provider: "beeper",
      identitySha256
    }),
    bounds: parsedBounds,
    source: output.source,
    provider: output.provider,
    transform: output.transform,
    completeness: output.completeness,
    counts: output.counts,
    output: Object.freeze({
      schemaVersion: output.schemaVersion,
      format: output.format,
      summarySha256
    }),
    privacy: Object.freeze({
      messageBodies: "excluded",
      attachments: "excluded",
      reactions: "excluded",
      media: "excluded",
      localPaths: "excluded",
      credentials: "excluded"
    })
  });
  const integrity = record(source.integrity, "export receipt.integrity");
  exactKeys(integrity, ["algorithm", "receiptSha256"], "export receipt.integrity");
  if (integrity.algorithm !== "sha256") {
    return fail("export receipt integrity algorithm is unsupported");
  }
  const receiptSha256 = digest(integrity.receiptSha256, "export receipt.integrity.receiptSha256");
  if (sha256(canonicalJson(receiptProjection(projection))) !== receiptSha256) {
    return fail("export receipt integrity does not bind its projection");
  }
  return Object.freeze({
    receipt: Object.freeze({
      ...projection,
      integrity: Object.freeze({ algorithm: "sha256", receiptSha256 })
    }),
    output
  });
}

// src/beeper-client.ts
var MAX_STDERR_BYTES = 8 * 1024;
var PROCESS_TIMEOUT_MS = 6 * 60 * 60 * 1000 + 60000;
function fail2(message) {
  throw new Error(`Wrench Beeper client: ${message}`);
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
function requireBunRuntime() {
  if (typeof process.versions.bun !== "string") {
    fail2("@hraness/wrench/beeper requires Bun to run the installed Wrench CLI");
  }
}
function plainDataObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes2.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail2(`${label} must use a plain, non-proxy object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return fail2(`${label} has unsupported symbol fields`);
  }
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return fail2(`${label} must contain only enumerable data properties`);
    }
  }
  return descriptors;
}
function positiveInteger(value, label, maximum) {
  if (value === undefined)
    return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum)
    return fail2(`${label} must be an integer from 1 through ${String(maximum)}`);
  return value;
}
function prepareRequest(value) {
  const descriptors = plainDataObject(value, "request");
  const keys = Object.keys(descriptors);
  const allowed = new Set([
    "authId",
    "limitChats",
    "limitMessages",
    "maxParticipants"
  ]);
  if (!keys.includes("authId") || keys.some((key) => !allowed.has(key))) {
    return fail2("request contains unsupported or missing fields");
  }
  const authId = descriptors.authId?.value;
  if (typeof authId !== "string" || !/^[a-z][a-z0-9-]{0,127}$/u.test(authId))
    return fail2("authId must be lowercase kebab text");
  const limitChats = positiveInteger(descriptors.limitChats?.value, "limitChats", 1e5);
  const limitMessages = positiveInteger(descriptors.limitMessages?.value, "limitMessages", 1e6);
  const maxParticipants = positiveInteger(descriptors.maxParticipants?.value, "maxParticipants", 2000);
  return Object.freeze({
    authId,
    ...limitChats === undefined ? {} : { limitChats },
    ...limitMessages === undefined ? {} : { limitMessages },
    ...maxParticipants === undefined ? {} : { maxParticipants }
  });
}
function environmentName(value) {
  if (value.length < 1 || value.includes("=") || value.includes("\x00")) {
    return fail2("environment name is malformed");
  }
  return value;
}
function prepareEnvironment(value) {
  const environment = Object.create(null);
  for (const [key, item] of Object.entries(process.env)) {
    if (typeof item === "string")
      environment[key] = item;
  }
  if (value === undefined)
    return Object.freeze(environment);
  const descriptors = plainDataObject(value, "environment");
  for (const key of Object.keys(descriptors).sort()) {
    const name = environmentName(key);
    const item = descriptors[key].value;
    if (item === undefined)
      delete environment[name];
    else if (typeof item !== "string" || item.includes("\x00")) {
      return fail2("environment value is malformed");
    } else
      environment[name] = item;
  }
  return Object.freeze(environment);
}
function prepareOptions(value) {
  const descriptors = plainDataObject(value, "options");
  const keys = Object.keys(descriptors);
  if (keys.some((key) => key !== "environment")) {
    return fail2("options contain an unsupported field");
  }
  return prepareEnvironment(descriptors.environment?.value);
}
function boundedError(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_STDERR_BYTES)
    return text;
  return `${bytes.subarray(0, MAX_STDERR_BYTES).toString("utf8").trim()}\u2026`;
}
function exportBeeperContactInteractionsSync(requestValue, optionsValue = {}) {
  requireBunRuntime();
  const request = prepareRequest(requestValue);
  const environment = prepareOptions(optionsValue);
  const result = spawnSync(process.execPath, [
    cliSourcePath(),
    "beeper",
    "export-contact-interactions",
    "--auth",
    request.authId,
    ...request.limitChats === undefined ? [] : ["--limit-chats", String(request.limitChats)],
    ...request.limitMessages === undefined ? [] : ["--limit-messages", String(request.limitMessages)],
    ...request.maxParticipants === undefined ? [] : ["--max-participants", String(request.maxParticipants)],
    "--json"
  ], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES,
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "inherit"]
  });
  if (result.error !== undefined)
    return fail2("summary process could not complete");
  if (result.status !== 0 || typeof result.stdout !== "string") {
    const stderr = boundedError(result.stderr);
    return fail2(stderr.length === 0 ? "summary process failed" : stderr);
  }
  if (Buffer.byteLength(result.stdout, "utf8") > BEEPER_CONTACT_INTERACTION_WIRE_MAX_BYTES) {
    return fail2("summary response exceeded its byte bound");
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return fail2("summary response was not JSON");
  }
  const resultValue = parseBeeperContactInteractionExportResult(parsed);
  if (resultValue.receipt.auth.id !== request.authId) {
    return fail2("summary receipt auth does not match its request");
  }
  const expectedBounds = Object.freeze({
    limitChats: request.limitChats ?? null,
    limitMessages: request.limitMessages ?? null,
    maxParticipants: request.maxParticipants ?? null
  });
  if (resultValue.receipt.bounds.limitChats !== expectedBounds.limitChats || resultValue.receipt.bounds.limitMessages !== expectedBounds.limitMessages || resultValue.receipt.bounds.maxParticipants !== expectedBounds.maxParticipants)
    return fail2("summary receipt bounds do not match its request");
  return resultValue;
}
export {
  parseBeeperContactInteractionSummary,
  parseBeeperContactInteractionExportResult,
  exportBeeperContactInteractionsSync
};
