import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  LOCAL_MESSAGE_BUNDLE_V2_ARTIFACTS,
  LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_ID,
  LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_VERSION,
  LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
  LOCAL_MESSAGE_BUNDLE_V2_SOURCE_ID,
  LOCAL_MESSAGE_BUNDLE_V2_SOURCE_TRANSFORM_VERSION,
  parseLocalMessageBundleV2Manifest,
  type LocalMessageBundleV2Record,
} from "@hraness/message-like-me/message-bundle-v2";

import { exportWhatsAppMessageLikeMeBundle } from "../src/whatsapp-message-like-me-export";
import type { WhatsAppMessageLikeMeExportSource } from "../src/whatsapp-message-like-me-source";

const EXPECTED_MESSAGE_LIKE_ME_VERSION = "0.7.0";
const OBSERVED_AT = "2026-08-28T12:00:00.000Z";
const SELF_JID = "15551234567@s.whatsapp.net";
const PEER_JID = "15557654321@s.whatsapp.net";
const ACCOUNT_ID = "whatsapp:fixture:account";
const SELF_PARTICIPANT_ID = "whatsapp:fixture:participant:self";
const PEER_PARTICIPANT_ID = "whatsapp:fixture:participant:peer";
const CONVERSATION_ID = "whatsapp:fixture:conversation";

function provenance(providerId: string) {
  return Object.freeze({
    providerId,
    providerRevision: null,
    observedAt: OBSERVED_AT,
    connectedAccountProviderId: SELF_JID,
  });
}

function fixtureRecords(): readonly LocalMessageBundleV2Record[] {
  return Object.freeze([
    Object.freeze({
      schemaVersion: LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      kind: "account",
      id: ACCOUNT_ID,
      accountId: ACCOUNT_ID,
      network: "whatsapp",
      provenance: provenance(SELF_JID),
      displayName: "Wrench acceptance account",
      handle: "+15551234567",
      selfParticipantId: SELF_PARTICIPANT_ID,
    }),
    Object.freeze({
      schemaVersion: LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      kind: "message",
      id: "whatsapp:fixture:message:incoming",
      accountId: ACCOUNT_ID,
      network: "whatsapp",
      provenance: provenance(`${PEER_JID}/FIXTURE-INCOMING`),
      conversationId: CONVERSATION_ID,
      senderParticipantId: PEER_PARTICIPANT_ID,
      direction: "incoming",
      sentAt: OBSERVED_AT,
      sortKey: "0000000000000000001",
      body: "Wrench WhatsApp consumer acceptance incoming",
      bodyTruncated: false,
      replyTo: null,
      edit: null,
      deletion: null,
      attachments: Object.freeze([]),
    }),
    Object.freeze({
      schemaVersion: LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      kind: "message",
      id: "whatsapp:fixture:message:outgoing",
      accountId: ACCOUNT_ID,
      network: "whatsapp",
      provenance: provenance(`${PEER_JID}/FIXTURE-OUTGOING`),
      conversationId: CONVERSATION_ID,
      senderParticipantId: SELF_PARTICIPANT_ID,
      direction: "outgoing",
      sentAt: "2026-08-28T12:01:00.000Z",
      sortKey: "0000000000000000002",
      body: "Wrench WhatsApp consumer acceptance outgoing",
      bodyTruncated: false,
      replyTo: Object.freeze({
        messageId: "whatsapp:fixture:message:incoming",
        providerId: `${PEER_JID}/FIXTURE-INCOMING`,
      }),
      edit: null,
      deletion: null,
      attachments: Object.freeze([]),
    }),
    Object.freeze({
      schemaVersion: LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      kind: "participant",
      id: SELF_PARTICIPANT_ID,
      accountId: ACCOUNT_ID,
      network: "whatsapp",
      provenance: provenance(SELF_JID),
      displayName: "Wrench acceptance self",
      handle: "+15551234567",
      isSelf: true,
    }),
    Object.freeze({
      schemaVersion: LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      kind: "participant",
      id: PEER_PARTICIPANT_ID,
      accountId: ACCOUNT_ID,
      network: "whatsapp",
      provenance: provenance(PEER_JID),
      displayName: "Wrench acceptance peer",
      handle: "+15557654321",
      isSelf: false,
    }),
    Object.freeze({
      schemaVersion: LOCAL_MESSAGE_BUNDLE_V2_SCHEMA_VERSION,
      kind: "conversation",
      id: CONVERSATION_ID,
      accountId: ACCOUNT_ID,
      network: "whatsapp",
      provenance: provenance(PEER_JID),
      type: "direct",
      title: "Wrench acceptance direct conversation",
      participantIds: Object.freeze([SELF_PARTICIPANT_ID, PEER_PARTICIPANT_ID]),
      participantsComplete: true,
      startedAt: OBSERVED_AT,
      lastMessageAt: "2026-08-28T12:01:00.000Z",
    }),
  ] satisfies readonly LocalMessageBundleV2Record[]);
}

function fixtureSource(): WhatsAppMessageLikeMeExportSource {
  const records = fixtureRecords();
  return Object.freeze({
    descriptor: Object.freeze({
      source: Object.freeze({
        id: LOCAL_MESSAGE_BUNDLE_V2_SOURCE_ID,
        version: LOCAL_MESSAGE_BUNDLE_V2_SOURCE_TRANSFORM_VERSION,
      }),
      provider: Object.freeze({
        id: LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_ID,
        version: LOCAL_MESSAGE_BUNDLE_V2_PROVIDER_VERSION,
      }),
    }),
    records: (async function* () {
      yield* records;
    })(),
    completion: async () => Object.freeze({
      completeness: Object.freeze({
        kind: "bounded-local",
        reason: "local-store-coverage-unknown",
        observedFrom: OBSERVED_AT,
        observedThrough: "2026-08-28T12:01:00.000Z",
      }),
      warnings: Object.freeze(["remote-history-incomplete"]),
    }),
  });
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export async function runWhatsAppMessageLikeMeConsumerAcceptance(): Promise<void> {
  const repositoryRoot = resolve(import.meta.dir, "..");
  const dependencyRoot = join(
    repositoryRoot,
    "node_modules",
    "@hraness",
    "message-like-me",
  );
  const dependencyManifest = record(
    JSON.parse(await readFile(join(dependencyRoot, "package.json"), "utf8")) as unknown,
    "Message Like Me package.json",
  );
  if (dependencyManifest.version !== EXPECTED_MESSAGE_LIKE_ME_VERSION) {
    throw new Error(
      `WhatsApp consumer acceptance requires @hraness/message-like-me@${EXPECTED_MESSAGE_LIKE_ME_VERSION}`,
    );
  }

  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "wrench-whatsapp-mlm-acceptance-")),
  );
  await chmod(parent, 0o700);
  const outputRoot = join(parent, "bundle");
  const dataRoot = join(parent, "message-like-me-data");
  try {
    const bundle = await exportWhatsAppMessageLikeMeBundle({
      outputRoot,
      source: fixtureSource(),
      clock: () => new Date("2026-08-28T12:02:00.000Z"),
    });
    const expectedFiles = [
      ...LOCAL_MESSAGE_BUNDLE_V2_ARTIFACTS.map((artifact) => artifact.path),
      "manifest.json",
    ].sort();
    const actualFiles = (await readdir(outputRoot)).sort();
    if (
      actualFiles.length !== expectedFiles.length
      || actualFiles.some((file, index) => file !== expectedFiles[index])
    ) throw new Error("Wrench did not generate the exact seven-file WhatsApp bundle");
    parseLocalMessageBundleV2Manifest(
      JSON.parse(await readFile(bundle.manifestPath, "utf8")) as unknown,
    );

    const cli = join(repositoryRoot, "node_modules", ".bin", "messagelikeme");
    const child = Bun.spawn([
      cli,
      "--data-dir",
      dataRoot,
      "ingest",
      "bundle",
      "--input",
      outputRoot,
      "--json",
    ], {
      cwd: repositoryRoot,
      env: {
        HOME: parent,
        LANG: "C",
        LC_ALL: "C",
        NO_COLOR: "1",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: parent,
        TZ: "UTC",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `Message Like Me ${EXPECTED_MESSAGE_LIKE_ME_VERSION} rejected the Wrench fixture (${String(exitCode)}): ${stderr.trim() || stdout.trim() || "no diagnostic"}`,
      );
    }
    const receipt = record(JSON.parse(stdout) as unknown, "Message Like Me ingest receipt");
    if (receipt.schemaVersion !== 2) {
      throw new Error("Message Like Me did not accept the fixture as bundle schema 2");
    }
    for (const privateValue of [
      outputRoot,
      "Wrench WhatsApp consumer acceptance incoming",
      "Wrench WhatsApp consumer acceptance outgoing",
    ]) {
      if (stdout.includes(privateValue) || stderr.includes(privateValue)) {
        throw new Error("Message Like Me exposed private fixture data in its ingest receipt");
      }
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runWhatsAppMessageLikeMeConsumerAcceptance();
}
