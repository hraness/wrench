// @bun
import {
  WRENCH_VERSION
} from "./index-mcrgavfw.js";
import {
  canonicalJson,
  sha256
} from "./index-dqv16dt0.js";

// src/apple-photos-client.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { types as nodeTypes2 } from "util";

// src/apple-photos-contact-evidence.ts
import { randomUUID } from "crypto";
import { types as nodeTypes } from "util";
var APPLE_PHOTOS_CONTACT_EVIDENCE_SCHEMA_VERSION = 1;
var APPLE_PHOTOS_CONTACT_EVIDENCE_FORMAT = "wrench.apple-photos-contact-evidence";
var APPLE_PHOTOS_CONTACT_EVIDENCE_RECEIPT_FORMAT = "wrench.apple-photos-contact-evidence-export-receipt";
var APPLE_PHOTOS_LOCAL_SOURCE = Object.freeze({
  id: "apple-photos-local",
  version: "1.0.0"
});
var APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS = Object.freeze({
  captureAttemptsPerDatabase: 1,
  maximumPhotosDatabaseBytes: 4 * 1024 * 1024 * 1024,
  maximumContactsDatabases: 32,
  maximumContactsDatabaseBytes: 2 * 1024 * 1024 * 1024,
  maximumDirectoryEntries: 4096,
  maximumContactsSourceDirectories: 256,
  maximumPeople: 1e5,
  maximumContacts: 1e6,
  maximumWireBytes: 128 * 1024 * 1024
});
var COMPLETENESS = Object.freeze({
  kind: "bounded-local-observation",
  localPhotos: "one-reviewed-library-database-capture",
  localContacts: "ordered-discovered-address-book-database-captures",
  crossDatabaseAtomicity: "not-asserted",
  remoteSync: "not-asserted",
  unmatchedPeople: "excluded",
  reason: "Exact matches from bounded independent local database captures; cross-database atomicity and remote synchronization state are not asserted."
});
var PRIVACY = Object.freeze({
  names: "excluded-from-returned-json",
  localPaths: "excluded-from-returned-json",
  images: "excluded-from-returned-json",
  media: "excluded-from-returned-json",
  locations: "excluded-from-returned-json",
  rawContactData: "excluded-from-returned-json",
  rawPhotosData: "excluded-from-returned-json",
  faceClusterIdentifiers: "included-biometric-derived-private-metadata",
  faceClusterCounts: "included-biometric-derived-private-metadata",
  faceprintTemplates: "excluded-from-returned-json",
  faceCrops: "excluded-from-returned-json",
  unmatchedPeople: "excluded-from-returned-json"
});
var SCOPE = Object.freeze({
  people: "exact-zpersonuri-zuniqueid-matches-only",
  faces: "detected-face-links-present-in-photos-capture",
  assets: "distinct-zasset-rows-linked-through-detected-faces"
});
function fail(message) {
  throw new Error(`Apple Photos contact evidence: ${message}`);
}
function dataRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail(`${label} must be a plain, non-proxy object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string")
      return fail(`${label} has a symbol field`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(`${label} must contain only enumerable data properties`);
  }
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])));
}
function dataArray(value, label, maximum) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return fail(`${label} must be an ordinary, non-proxy array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum)
    return fail(`${label} length exceeds its reviewed bound`);
  const length = lengthDescriptor.value;
  const items = [];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) {
    return fail(`${label} must not have holes, symbols, or named fields`);
  }
  for (let index = 0;index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail(`${label} must contain dense enumerable data elements`);
    items.push(descriptor.value);
  }
  if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)))) {
    return fail(`${label} must not have holes, symbols, or named fields`);
  }
  return Object.freeze(items);
}
function exactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index]))
    return fail(`${label} fields drifted`);
}
function exactString(value, expected, label) {
  if (value !== expected)
    return fail(`${label} must equal ${expected}`);
  return expected;
}
function digest(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    return fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string" || value.length > 32 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return fail(`${label} must be a canonical UTC timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return fail(`${label} must be a real canonical UTC timestamp`);
  }
  return value;
}
function identifier(value, label, maximum) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum || !/^[A-Za-z0-9._:-]+$/u.test(value))
    return fail(`${label} must be a bounded provider identifier`);
  return value;
}
function integer(value, label, maximum, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    return fail(`${label} must be an integer from ${String(minimum)} through ${String(maximum)}`);
  return value;
}
function parseInterval(value, label) {
  const record = dataRecord(value, label);
  exactKeys(record, ["startedAt", "finishedAt"], label);
  return parseIntervalFields(record, label);
}
function parseIntervalFields(record, label) {
  const startedAt = timestamp(record.startedAt, `${label}.startedAt`);
  const finishedAt = timestamp(record.finishedAt, `${label}.finishedAt`);
  if (startedAt > finishedAt)
    return fail(`${label} timestamps are reversed`);
  return Object.freeze({ startedAt, finishedAt });
}
function parseCapture(value) {
  const record = dataRecord(value, "source.capture");
  exactKeys(record, [
    "startedAt",
    "finishedAt",
    "photos",
    "contacts",
    "consistency",
    "crossDatabaseAtomicity"
  ], "source.capture");
  const enclosing = parseIntervalFields(record, "source.capture");
  const photos = parseInterval(record.photos, "source.capture.photos");
  const contactValues = dataArray(record.contacts, "source.capture.contacts", APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases);
  if (contactValues.length < 1) {
    return fail("source.capture.contacts must contain at least one database interval");
  }
  const contacts = Object.freeze(contactValues.map((item, index) => {
    const label = `source.capture.contacts[${String(index)}]`;
    const contact = dataRecord(item, label);
    exactKeys(contact, ["ordinal", "startedAt", "finishedAt"], label);
    const interval = parseIntervalFields(contact, label);
    const ordinal = integer(contact.ordinal, `${label}.ordinal`, APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases - 1);
    if (ordinal !== index)
      return fail(`${label}.ordinal must equal its array position`);
    return Object.freeze({ ordinal, ...interval });
  }));
  if (enclosing.startedAt > photos.startedAt || photos.finishedAt > enclosing.finishedAt)
    return fail("source.capture.photos must be inside its enclosing interval");
  let priorFinishedAt = photos.finishedAt;
  for (const [index, contact] of contacts.entries()) {
    if (contact.startedAt < priorFinishedAt || contact.finishedAt > enclosing.finishedAt)
      return fail(`source.capture.contacts[${String(index)}] is outside capture order`);
    priorFinishedAt = contact.finishedAt;
  }
  return Object.freeze({
    ...enclosing,
    photos,
    contacts,
    consistency: exactString(record.consistency, "independent-read-transactions", "source.capture.consistency"),
    crossDatabaseAtomicity: exactString(record.crossDatabaseAtomicity, "not-asserted", "source.capture.crossDatabaseAtomicity")
  });
}
function parseCompleteness(value) {
  const record = dataRecord(value, "completeness");
  exactKeys(record, Object.keys(COMPLETENESS), "completeness");
  for (const [key, expected] of Object.entries(COMPLETENESS)) {
    exactString(record[key], expected, `completeness.${key}`);
  }
  return COMPLETENESS;
}
function parsePrivacy(value) {
  const record = dataRecord(value, "privacy");
  exactKeys(record, Object.keys(PRIVACY), "privacy");
  for (const [key, expected] of Object.entries(PRIVACY)) {
    exactString(record[key], expected, `privacy.${key}`);
  }
  return PRIVACY;
}
function parseEvidence(value, index) {
  const label = `evidence[${String(index)}]`;
  const record = dataRecord(value, label);
  exactKeys(record, [
    "photosPersonId",
    "appleContactId",
    "linkedFaceCount",
    "linkedAssetCount",
    "firstAssetAt",
    "lastAssetAt"
  ], label);
  const first = record.firstAssetAt === null ? null : timestamp(record.firstAssetAt, `${label}.firstAssetAt`);
  const last = record.lastAssetAt === null ? null : timestamp(record.lastAssetAt, `${label}.lastAssetAt`);
  if (first === null !== (last === null)) {
    return fail(`${label} asset date bounds must both be null or both be timestamps`);
  }
  if (first !== null && last !== null && first > last) {
    return fail(`${label} asset date bounds are reversed`);
  }
  const linkedFaceCount = integer(record.linkedFaceCount, `${label}.linkedFaceCount`, 1e7);
  const linkedAssetCount = integer(record.linkedAssetCount, `${label}.linkedAssetCount`, 1e7);
  if (linkedAssetCount > linkedFaceCount) {
    return fail(`${label} cannot link more distinct assets than detected faces`);
  }
  if (linkedAssetCount === 0 && (first !== null || last !== null)) {
    return fail(`${label} with zero linked assets must have null date bounds`);
  }
  return Object.freeze({
    photosPersonId: identifier(record.photosPersonId, `${label}.photosPersonId`, 128),
    appleContactId: identifier(record.appleContactId, `${label}.appleContactId`, 512),
    linkedFaceCount,
    linkedAssetCount,
    firstAssetAt: first,
    lastAssetAt: last
  });
}
function compareEvidence(left, right) {
  const contact = Buffer.compare(Buffer.from(left.appleContactId, "utf8"), Buffer.from(right.appleContactId, "utf8"));
  if (contact !== 0)
    return contact;
  return Buffer.compare(Buffer.from(left.photosPersonId, "utf8"), Buffer.from(right.photosPersonId, "utf8"));
}
function artifactWithoutIntegrity(input) {
  const evidenceInput = dataArray(input.evidence, "evidence", APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPeople);
  const evidence = Object.freeze(evidenceInput.map((item, index) => parseEvidence(item, index)).sort(compareEvidence));
  if (evidence.length > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPeople) {
    return fail("evidence exceeds the matched-person bound");
  }
  const people = new Set;
  const pairs = new Set;
  const contacts = new Set;
  let linkedFaces = 0;
  let linkedAssets = 0;
  for (const item of evidence) {
    if (people.has(item.photosPersonId)) {
      return fail("one Photos person appears more than once");
    }
    const pair = `${item.photosPersonId}\x00${item.appleContactId}`;
    if (pairs.has(pair))
      return fail("one Photos/contact pair appears more than once");
    people.add(item.photosPersonId);
    pairs.add(pair);
    contacts.add(item.appleContactId);
    linkedFaces += item.linkedFaceCount;
    linkedAssets += item.linkedAssetCount;
    if (!Number.isSafeInteger(linkedFaces) || !Number.isSafeInteger(linkedAssets)) {
      return fail("aggregate counts exceed the safe integer range");
    }
  }
  const capture = parseCapture(input.capture);
  const observedAt = timestamp(input.observedAt, "observedAt");
  if (observedAt < capture.startedAt || observedAt > capture.finishedAt) {
    return fail("observedAt must be inside the enclosing capture interval");
  }
  const lastContact = capture.contacts[capture.contacts.length - 1];
  if (observedAt < lastContact.finishedAt) {
    return fail("observedAt must not precede the final database capture");
  }
  return Object.freeze({
    schemaVersion: APPLE_PHOTOS_CONTACT_EVIDENCE_SCHEMA_VERSION,
    format: APPLE_PHOTOS_CONTACT_EVIDENCE_FORMAT,
    transform: Object.freeze({
      id: "apple-photos-person-contact-evidence",
      version: 1
    }),
    source: Object.freeze({
      ...APPLE_PHOTOS_LOCAL_SOURCE,
      platform: "darwin",
      libraryRealmSha256: digest(input.libraryRealmSha256, "source.libraryRealmSha256"),
      generationSha256: digest(input.generationSha256, "source.generationSha256"),
      photosSchemaSha256: digest(input.photosSchemaSha256, "source.photosSchemaSha256"),
      contactsSchemaSha256: digest(input.contactsSchemaSha256, "source.contactsSchemaSha256"),
      capture
    }),
    observedAt,
    scope: SCOPE,
    completeness: COMPLETENESS,
    privacy: PRIVACY,
    counts: Object.freeze({
      matchedPeople: evidence.length,
      uniqueContacts: contacts.size,
      linkedFaces,
      linkedAssets
    }),
    evidence
  });
}
function createApplePhotosContactEvidenceArtifact(input) {
  const base = artifactWithoutIntegrity(input);
  return Object.freeze({
    ...base,
    integrity: Object.freeze({
      algorithm: "sha256",
      artifactSha256: sha256(canonicalJson(base))
    })
  });
}
function parseArtifactSource(value) {
  const source = dataRecord(value, "source");
  exactKeys(source, [
    "id",
    "version",
    "platform",
    "libraryRealmSha256",
    "generationSha256",
    "photosSchemaSha256",
    "contactsSchemaSha256",
    "capture"
  ], "source");
  return Object.freeze({
    id: exactString(source.id, "apple-photos-local", "source.id"),
    version: exactString(source.version, "1.0.0", "source.version"),
    platform: exactString(source.platform, "darwin", "source.platform"),
    libraryRealmSha256: digest(source.libraryRealmSha256, "source.libraryRealmSha256"),
    generationSha256: digest(source.generationSha256, "source.generationSha256"),
    photosSchemaSha256: digest(source.photosSchemaSha256, "source.photosSchemaSha256"),
    contactsSchemaSha256: digest(source.contactsSchemaSha256, "source.contactsSchemaSha256"),
    capture: parseCapture(source.capture)
  });
}
function parseApplePhotosContactEvidenceArtifact(value) {
  const artifact = dataRecord(value, "artifact");
  exactKeys(artifact, [
    "schemaVersion",
    "format",
    "transform",
    "source",
    "observedAt",
    "scope",
    "completeness",
    "privacy",
    "counts",
    "evidence",
    "integrity"
  ], "artifact");
  exactString(artifact.schemaVersion, 1, "artifact.schemaVersion");
  exactString(artifact.format, APPLE_PHOTOS_CONTACT_EVIDENCE_FORMAT, "artifact.format");
  const transform = dataRecord(artifact.transform, "transform");
  exactKeys(transform, ["id", "version"], "transform");
  exactString(transform.id, "apple-photos-person-contact-evidence", "transform.id");
  exactString(transform.version, 1, "transform.version");
  const scope = dataRecord(artifact.scope, "scope");
  exactKeys(scope, Object.keys(SCOPE), "scope");
  for (const [key, expected] of Object.entries(SCOPE)) {
    exactString(scope[key], expected, `scope.${key}`);
  }
  const evidenceValue = artifact.evidence;
  const evidence = dataArray(evidenceValue, "evidence", APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPeople);
  const source = parseArtifactSource(artifact.source);
  const parsed = createApplePhotosContactEvidenceArtifact({
    observedAt: timestamp(artifact.observedAt, "observedAt"),
    libraryRealmSha256: source.libraryRealmSha256,
    generationSha256: source.generationSha256,
    photosSchemaSha256: source.photosSchemaSha256,
    contactsSchemaSha256: source.contactsSchemaSha256,
    capture: source.capture,
    evidence: evidence.map(parseEvidence)
  });
  const counts = dataRecord(artifact.counts, "counts");
  exactKeys(counts, Object.keys(parsed.counts), "counts");
  for (const [key, expected] of Object.entries(parsed.counts)) {
    if (counts[key] !== expected)
      return fail(`counts.${key} is inconsistent`);
  }
  parseCompleteness(artifact.completeness);
  parsePrivacy(artifact.privacy);
  const integrity = dataRecord(artifact.integrity, "integrity");
  exactKeys(integrity, ["algorithm", "artifactSha256"], "integrity");
  exactString(integrity.algorithm, "sha256", "integrity.algorithm");
  if (digest(integrity.artifactSha256, "integrity.artifactSha256") !== parsed.integrity.artifactSha256)
    return fail("artifact integrity digest does not match its content");
  if (canonicalJson(parsed) !== canonicalJson(value)) {
    return fail("artifact is not in its canonical schema order and representation");
  }
  return parsed;
}
function receiptWithoutIntegrity(input, output) {
  const runId = input.runId ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(runId)) {
    return fail("runId must be a lowercase UUIDv4");
  }
  const contactsDatabases = integer(input.contactsDatabases, "counts.contactsDatabases", APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases, 1);
  const startedAt = timestamp(input.startedAt, "startedAt");
  const finishedAt = timestamp(input.finishedAt, "finishedAt");
  if (startedAt > finishedAt)
    return fail("receipt timestamps are reversed");
  if (startedAt > output.source.capture.startedAt || output.source.capture.finishedAt > finishedAt)
    return fail("the database capture must be inside the receipt interval");
  if (contactsDatabases !== output.source.capture.contacts.length) {
    return fail("counts.contactsDatabases must match the ordered capture intervals");
  }
  return Object.freeze({
    schemaVersion: 1,
    format: APPLE_PHOTOS_CONTACT_EVIDENCE_RECEIPT_FORMAT,
    runId,
    operation: "apple-photos.export-contact-evidence",
    status: "succeeded",
    transport: "local-sqlite-vacuum-capture",
    implementation: Object.freeze({
      producer: Object.freeze({
        package: "@hraness/wrench",
        version: WRENCH_VERSION
      }),
      source: APPLE_PHOTOS_LOCAL_SOURCE
    }),
    startedAt,
    finishedAt,
    bounds: Object.freeze({
      captureAttemptsPerDatabase: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.captureAttemptsPerDatabase,
      maximumPhotosDatabaseBytes: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPhotosDatabaseBytes,
      maximumContactsDatabases: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases,
      maximumContactsDatabaseBytes: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabaseBytes,
      maximumDirectoryEntries: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumDirectoryEntries,
      maximumContactsSourceDirectories: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsSourceDirectories,
      maximumPeople: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPeople,
      maximumContacts: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContacts
    }),
    source: output.source,
    completeness: output.completeness,
    counts: Object.freeze({
      ...output.counts,
      contactsDatabases
    }),
    output: Object.freeze({
      schemaVersion: output.schemaVersion,
      format: output.format,
      artifactSha256: output.integrity.artifactSha256
    }),
    privacy: output.privacy
  });
}
function createApplePhotosContactEvidenceExportResult(input) {
  const output = createApplePhotosContactEvidenceArtifact(input);
  const base = receiptWithoutIntegrity(input, output);
  const receipt = Object.freeze({
    ...base,
    integrity: Object.freeze({
      algorithm: "sha256",
      receiptSha256: sha256(canonicalJson(base))
    })
  });
  return Object.freeze({ receipt, output });
}
function parseBounds(value) {
  const bounds = dataRecord(value, "receipt.bounds");
  const expected = {
    captureAttemptsPerDatabase: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.captureAttemptsPerDatabase,
    maximumPhotosDatabaseBytes: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPhotosDatabaseBytes,
    maximumContactsDatabases: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases,
    maximumContactsDatabaseBytes: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabaseBytes,
    maximumDirectoryEntries: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumDirectoryEntries,
    maximumContactsSourceDirectories: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsSourceDirectories,
    maximumPeople: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumPeople,
    maximumContacts: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContacts
  };
  exactKeys(bounds, Object.keys(expected), "receipt.bounds");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (bounds[key] !== expectedValue)
      return fail(`receipt.bounds.${key} drifted`);
  }
  return Object.freeze(expected);
}
function parseApplePhotosContactEvidenceExportResult(value) {
  const result = dataRecord(value, "result");
  exactKeys(result, ["receipt", "output"], "result");
  const output = parseApplePhotosContactEvidenceArtifact(result.output);
  const receipt = dataRecord(result.receipt, "receipt");
  exactKeys(receipt, [
    "schemaVersion",
    "format",
    "runId",
    "operation",
    "status",
    "transport",
    "implementation",
    "startedAt",
    "finishedAt",
    "bounds",
    "source",
    "completeness",
    "counts",
    "output",
    "privacy",
    "integrity"
  ], "receipt");
  exactString(receipt.schemaVersion, 1, "receipt.schemaVersion");
  exactString(receipt.format, APPLE_PHOTOS_CONTACT_EVIDENCE_RECEIPT_FORMAT, "receipt.format");
  exactString(receipt.operation, "apple-photos.export-contact-evidence", "receipt.operation");
  exactString(receipt.status, "succeeded", "receipt.status");
  exactString(receipt.transport, "local-sqlite-vacuum-capture", "receipt.transport");
  const implementation = dataRecord(receipt.implementation, "receipt.implementation");
  exactKeys(implementation, ["producer", "source"], "receipt.implementation");
  const producer = dataRecord(implementation.producer, "receipt.implementation.producer");
  exactKeys(producer, ["package", "version"], "receipt.implementation.producer");
  exactString(producer.package, "@hraness/wrench", "receipt.implementation.producer.package");
  exactString(producer.version, WRENCH_VERSION, "receipt.implementation.producer.version");
  const implementationSource = dataRecord(implementation.source, "receipt.implementation.source");
  exactKeys(implementationSource, ["id", "version"], "receipt.implementation.source");
  exactString(implementationSource.id, APPLE_PHOTOS_LOCAL_SOURCE.id, "receipt.implementation.source.id");
  exactString(implementationSource.version, APPLE_PHOTOS_LOCAL_SOURCE.version, "receipt.implementation.source.version");
  parseBounds(receipt.bounds);
  const source = parseArtifactSource(receipt.source);
  if (canonicalJson(source) !== canonicalJson(output.source)) {
    return fail("receipt source does not match the artifact source");
  }
  parseCompleteness(receipt.completeness);
  parsePrivacy(receipt.privacy);
  const counts = dataRecord(receipt.counts, "receipt.counts");
  exactKeys(counts, [...Object.keys(output.counts), "contactsDatabases"], "receipt.counts");
  for (const [key, expected] of Object.entries(output.counts)) {
    if (counts[key] !== expected)
      return fail(`receipt.counts.${key} is inconsistent`);
  }
  const contactsDatabases = integer(counts.contactsDatabases, "receipt.counts.contactsDatabases", APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumContactsDatabases, 1);
  const outputReference = dataRecord(receipt.output, "receipt.output");
  exactKeys(outputReference, ["schemaVersion", "format", "artifactSha256"], "receipt.output");
  exactString(outputReference.schemaVersion, 1, "receipt.output.schemaVersion");
  exactString(outputReference.format, APPLE_PHOTOS_CONTACT_EVIDENCE_FORMAT, "receipt.output.format");
  if (digest(outputReference.artifactSha256, "receipt.output.artifactSha256") !== output.integrity.artifactSha256)
    return fail("receipt output digest does not match the artifact");
  const integrity = dataRecord(receipt.integrity, "receipt.integrity");
  exactKeys(integrity, ["algorithm", "receiptSha256"], "receipt.integrity");
  exactString(integrity.algorithm, "sha256", "receipt.integrity.algorithm");
  const rebuilt = createApplePhotosContactEvidenceExportResult({
    runId: identifier(receipt.runId, "receipt.runId", 64),
    startedAt: timestamp(receipt.startedAt, "receipt.startedAt"),
    finishedAt: timestamp(receipt.finishedAt, "receipt.finishedAt"),
    contactsDatabases,
    observedAt: output.observedAt,
    libraryRealmSha256: output.source.libraryRealmSha256,
    generationSha256: output.source.generationSha256,
    photosSchemaSha256: output.source.photosSchemaSha256,
    contactsSchemaSha256: output.source.contactsSchemaSha256,
    capture: output.source.capture,
    evidence: output.evidence
  });
  if (digest(integrity.receiptSha256, "receipt.integrity.receiptSha256") !== rebuilt.receipt.integrity.receiptSha256)
    return fail("receipt integrity digest does not match its content");
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    return fail("result is not in its canonical schema representation");
  }
  return rebuilt;
}

// src/apple-photos-client.ts
var MAX_STDERR_BYTES = 8 * 1024;
var PROCESS_TIMEOUT_MS = 15 * 60 * 1000 + 1e4;
var SOURCE_AUTHORITY_ENVIRONMENT = new Set([
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP"
]);
function fail2(message) {
  throw new Error(`Wrench Apple Photos client: ${message}`);
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
    return fail2("@hraness/wrench/apple-photos requires Bun to run the installed Wrench CLI");
  }
}
function dataDescriptors(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes2.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return fail2(`${label} must use a plain, non-proxy object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string")
      return fail2(`${label} has a symbol field`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
      return fail2(`${label} must contain only enumerable data properties`);
  }
  return descriptors;
}
function prepareRequest(value) {
  const descriptors = dataDescriptors(value, "request");
  if (Object.keys(descriptors).some((key) => key !== "library")) {
    return fail2("request contains an unsupported field");
  }
  const library = descriptors.library?.value;
  if (library === undefined)
    return Object.freeze({});
  if (typeof library !== "string" || !isAbsolute(library) || resolve(library) !== library || !library.endsWith(".photoslibrary") || Buffer.byteLength(library, "utf8") > 4096 || /[\0\r\n]/u.test(library))
    return fail2("library must be one normalized absolute .photoslibrary path");
  return Object.freeze({ library });
}
function prepareEnvironment(value) {
  const environment = Object.create(null);
  for (const [key, item] of Object.entries(process.env)) {
    if (typeof item === "string")
      environment[key] = item;
  }
  if (value === undefined)
    return Object.freeze(environment);
  const descriptors = dataDescriptors(value, "environment");
  for (const key of Object.keys(descriptors).sort()) {
    if (key.length < 1 || key.includes("=") || key.includes("\x00")) {
      return fail2("environment name is malformed");
    }
    const item = descriptors[key].value;
    if (SOURCE_AUTHORITY_ENVIRONMENT.has(key) && item !== environment[key])
      return fail2(`${key} cannot override Apple Photos source authority`);
    if (item === undefined)
      delete environment[key];
    else if (typeof item !== "string" || item.includes("\x00")) {
      return fail2("environment value is malformed");
    } else
      environment[key] = item;
  }
  return Object.freeze(environment);
}
function prepareOptions(value) {
  const descriptors = dataDescriptors(value, "options");
  if (Object.keys(descriptors).some((key) => key !== "environment")) {
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
function exportApplePhotosContactEvidenceSync(requestValue = {}, optionsValue = {}) {
  requireBunRuntime();
  const request = prepareRequest(requestValue);
  const environment = prepareOptions(optionsValue);
  const result = spawnSync(process.execPath, [
    cliSourcePath(),
    "apple-photos",
    "export-contact-evidence",
    ...request.library === undefined ? [] : ["--library", request.library],
    "--json"
  ], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    maxBuffer: APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumWireBytes,
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error !== undefined)
    return fail2("export process could not complete");
  if (result.status !== 0 || typeof result.stdout !== "string") {
    const stderr = boundedError(result.stderr);
    return fail2(stderr.length === 0 ? "export process failed" : stderr);
  }
  if (Buffer.byteLength(result.stdout, "utf8") > APPLE_PHOTOS_CONTACT_EVIDENCE_LIMITS.maximumWireBytes)
    return fail2("export response exceeded its byte bound");
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return fail2("export response was not JSON");
  }
  return parseApplePhotosContactEvidenceExportResult(parsed);
}
export {
  parseApplePhotosContactEvidenceExportResult,
  parseApplePhotosContactEvidenceArtifact,
  exportApplePhotosContactEvidenceSync
};
