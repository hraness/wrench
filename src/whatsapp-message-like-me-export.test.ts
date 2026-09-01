import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { exportWhatsAppMessageLikeMeBundle } from "./whatsapp-message-like-me-export";
import {
  WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS,
  WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
  WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
  parseWhatsAppMessageBundleV2Manifest,
  parseWhatsAppMessageBundleV2Record,
  type WhatsAppMessageBundleV2Record,
} from "./whatsapp-message-bundle-v2";
import type { WhatsAppMessageLikeMeExportSource } from "./whatsapp-message-like-me-source";

const OBSERVED_AT = "2026-08-28T12:00:00.000Z";
const SELF_JID = "15551234567@s.whatsapp.net";
const PEER_JID = "15557654321@s.whatsapp.net";

function provenance(providerId: string) {
  return {
    providerId,
    providerRevision: null,
    observedAt: OBSERVED_AT,
    connectedAccountProviderId: SELF_JID,
  } as const;
}

function accountRecord(): WhatsAppMessageBundleV2Record {
  return {
    schemaVersion: 2,
    kind: "account",
    id: "account-1",
    accountId: "account-1",
    network: "whatsapp",
    provenance: provenance(SELF_JID),
    displayName: null,
    handle: "+15551234567",
    selfParticipantId: "participant-self",
  };
}

function participant(id: string, jid: string, isSelf: boolean): WhatsAppMessageBundleV2Record {
  return {
    schemaVersion: 2,
    kind: "participant",
    id,
    accountId: "account-1",
    network: "whatsapp",
    provenance: provenance(jid),
    displayName: null,
    handle: jid === SELF_JID ? "+15551234567" : "+15557654321",
    isSelf,
  };
}

function source(records: readonly WhatsAppMessageBundleV2Record[]): WhatsAppMessageLikeMeExportSource {
  return {
    descriptor: { source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE, provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER },
    records: (async function* () {
      yield* records;
    })(),
    completion: async () => ({
      completeness: {
        kind: "bounded-local",
        reason: "local-store-coverage-unknown",
        observedFrom: records.some((record) => record.kind === "message") ? OBSERVED_AT : null,
        observedThrough: records.some((record) => record.kind === "message") ? OBSERVED_AT : null,
      },
      warnings: ["remote-history-incomplete"],
    }),
  };
}

function privateParent(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "wrench-whatsapp-v2-test-")));
  chmodSync(path, 0o700);
  return path;
}

function errorMessages(error: unknown): readonly string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(errorMessages)];
  }
  return [error instanceof Error ? error.message : String(error)];
}

describe("WhatsApp Message Like Me v2 bundle publication", () => {
  test("accepts messages before their participant/conversation graph and publishes exactly seven private files", async () => {
    const parent = privateParent();
    const output = resolve(parent, "bundle");
    try {
      const recoveryEnvironment = Object.freeze({
        WRENCH_STATE_HOME: join(parent, "state"),
      });
      const leaseRoot = join(
        recoveryEnvironment.WRENCH_STATE_HOME,
        "recovery",
        "beeper-message-like-me-directory-leases",
      );
      let observedOuterLeases = false;
      const message: WhatsAppMessageBundleV2Record = {
        schemaVersion: 2,
        kind: "message",
        id: "message-1",
        accountId: "account-1",
        network: "whatsapp",
        provenance: provenance(`${PEER_JID}/MSG-1`),
        conversationId: "conversation-1",
        senderParticipantId: "participant-peer",
        direction: "incoming",
        sentAt: OBSERVED_AT,
        sortKey: "0000000000000000001",
        body: "hello",
        bodyTruncated: false,
        replyTo: null,
        edit: null,
        deletion: null,
        attachments: [],
      };
      const conversation: WhatsAppMessageBundleV2Record = {
        schemaVersion: 2,
        kind: "conversation",
        id: "conversation-1",
        accountId: "account-1",
        network: "whatsapp",
        provenance: provenance(PEER_JID),
        type: "direct",
        title: null,
        participantIds: ["participant-self", "participant-peer"],
        participantsComplete: true,
        startedAt: OBSERVED_AT,
        lastMessageAt: OBSERVED_AT,
      };
      const result = await exportWhatsAppMessageLikeMeBundle({
        outputRoot: output,
        source: source([
          accountRecord(),
          message,
          participant("participant-self", SELF_JID, true),
          participant("participant-peer", PEER_JID, false),
          conversation,
        ]),
        clock: () => new Date(OBSERVED_AT),
        recoveryEnvironment,
        onProgress: (progress) => {
          if (progress.phase !== "v2-conversion") return;
          const claims = readdirSync(leaseRoot).map((name) =>
            JSON.parse(readFileSync(join(leaseRoot, name), "utf8")) as {
              readonly path: string;
              readonly role: string;
            });
          observedOuterLeases ||= claims.some((claim) =>
            claim.role === "raw-working"
            && claim.path.startsWith(join(parent, ".wrench-whatsapp-mlm-work-")))
            && claims.some((claim) =>
              claim.role === "bundle-stage"
              && claim.path.startsWith(join(parent, ".wrench-whatsapp-mlm-stage-")));
        },
      });
      expect(result.manifest).toMatchObject({
        schemaVersion: 2,
        source: WHATSAPP_MESSAGE_BUNDLE_V2_SOURCE,
        provider: WHATSAPP_MESSAGE_BUNDLE_V2_PROVIDER,
        counts: { account: 1, participant: 2, conversation: 1, message: 1 },
      });
      expect(parseWhatsAppMessageBundleV2Manifest(
        JSON.parse(readFileSync(result.manifestPath, "utf8")) as unknown,
      )).toEqual(result.manifest);
      expect(readdirSync(output).sort()).toEqual([
        ...WHATSAPP_MESSAGE_BUNDLE_V2_ARTIFACTS.map((item) => item.path),
        "manifest.json",
      ].sort());
      expect(lstatSync(output).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(output)) {
        expect(lstatSync(join(output, name)).mode & 0o777).toBe(0o600);
      }
      const savedMessage = JSON.parse(
        readFileSync(join(output, "messages.ndjson"), "utf8").trim(),
      ) as unknown;
      expect(parseWhatsAppMessageBundleV2Record(savedMessage)).toMatchObject({
        schemaVersion: 2,
        network: "whatsapp",
        body: "hello",
      });
      expect(readFileSync(join(output, "messages.ndjson"), "utf8")).not.toContain("beeper");
      expect(observedOuterLeases).toBeTrue();
      expect(existsSync(leaseRoot)).toBeTrue();
      expect(readdirSync(leaseRoot)).toEqual([]);
      expect(readdirSync(parent).filter((name) => name.startsWith(".wrench-whatsapp-"))).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("publishes an empty local message store without inventing conversations or messages", async () => {
    const parent = privateParent();
    const output = resolve(parent, "empty-bundle");
    try {
      const result = await exportWhatsAppMessageLikeMeBundle({
        outputRoot: output,
        source: source([
          accountRecord(),
          participant("participant-self", SELF_JID, true),
        ]),
        clock: () => new Date(OBSERVED_AT),
      });
      expect(result.manifest.counts).toEqual({
        account: 1,
        participant: 1,
        conversation: 0,
        message: 0,
        reaction: 0,
        tombstone: 0,
      });
      expect(readFileSync(join(output, "messages.ndjson"), "utf8")).toBe("");
      expect(readFileSync(join(output, "conversations.ndjson"), "utf8")).toBe("");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("rejects a same-UID graph-valid v1 artifact replacement during v2 conversion", async () => {
    const parent = privateParent();
    const output = resolve(parent, "v1-replacement-bundle");
    let replaced = false;
    try {
      let caught: unknown;
      try {
        await exportWhatsAppMessageLikeMeBundle({
          outputRoot: output,
          source: source([
            accountRecord(),
            participant("participant-self", SELF_JID, true),
          ]),
          onProgress: (progress) => {
            if (replaced || progress.phase !== "v2-conversion") return;
            const workingName = readdirSync(parent).find((name) =>
              name.startsWith(".wrench-whatsapp-mlm-work-")
            );
            if (workingName === undefined) throw new Error("expected the private v1 working bundle");
            const inputPath = join(parent, workingName, "validated-v1", "participants.ndjson");
            const original = readFileSync(inputPath, "utf8");
            const altered = original.replace('"displayName":null', '"displayName":"xx"');
            if (altered === original || Buffer.byteLength(altered) !== Buffer.byteLength(original)) {
              throw new Error("expected a same-size graph-valid participant mutation");
            }
            const replacementPath = `${inputPath}.same-uid-replacement`;
            writeFileSync(replacementPath, altered, { flag: "wx", mode: 0o600 });
            const replacement = lstatSync(replacementPath);
            if (
              replacement.uid !== process.getuid?.()
              || replacement.nlink !== 1
              || (replacement.mode & 0o777) !== 0o600
            ) throw new Error("expected an owned singly-linked private replacement");
            renameSync(replacementPath, inputPath);
            replaced = true;
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(replaced).toBeTrue();
      expect(errorMessages(caught).join("\n"))
        .toContain("participants.ndjson changed after v1 validation");
      expect(existsSync(output)).toBeFalse();
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("refuses an output parent writable by another user class", async () => {
    const parent = privateParent();
    const output = resolve(parent, "unsafe-parent-bundle");
    try {
      chmodSync(parent, 0o777);
      await expect(exportWhatsAppMessageLikeMeBundle({
        outputRoot: output,
        source: source([]),
      })).rejects.toThrow("output parent must not be writable by the group or other users");
      expect(existsSync(output)).toBeFalse();
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("fails closed when the output parent is swapped during conversion", async () => {
    const parent = privateParent();
    const displacedParent = `${parent}.displaced`;
    const output = resolve(parent, "parent-swap-bundle");
    let swapped = false;
    try {
      let caught: unknown;
      try {
        await exportWhatsAppMessageLikeMeBundle({
          outputRoot: output,
          source: source([accountRecord(), participant("participant-self", SELF_JID, true)]),
          onProgress: (progress) => {
            if (swapped || progress.phase !== "v2-conversion") return;
            swapped = true;
            renameSync(parent, displacedParent);
            mkdirSync(parent, { mode: 0o700 });
            writeFileSync(join(parent, "foreign-marker"), "preserve\n", { mode: 0o600 });
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(swapped).toBeTrue();
      expect(errorMessages(caught).join("\n")).toContain("private export directory changed");
      expect(readFileSync(join(parent, "foreign-marker"), "utf8")).toBe("preserve\n");
      expect(existsSync(output)).toBeFalse();
      expect(readdirSync(displacedParent).some((name) =>
        name.startsWith(".wrench-whatsapp-mlm-stage-")
      )).toBeTrue();
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(displacedParent, { recursive: true, force: true });
    }
  });

  test("preserves a replacement stage and keeps its lease bound to the displaced inode", async () => {
    const parent = privateParent();
    const output = resolve(parent, "stage-swap-bundle");
    const recoveryEnvironment = Object.freeze({ WRENCH_STATE_HOME: join(parent, "state") });
    const leaseRoot = join(
      recoveryEnvironment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-directory-leases",
    );
    let stagePath: string | undefined;
    let displacedStage: string | undefined;
    try {
      let caught: unknown;
      try {
        await exportWhatsAppMessageLikeMeBundle({
          outputRoot: output,
          source: source([accountRecord(), participant("participant-self", SELF_JID, true)]),
          recoveryEnvironment,
          onProgress: (progress) => {
            if (stagePath !== undefined || progress.phase !== "v2-conversion") return;
            const stageName = readdirSync(parent).find((name) =>
              name.startsWith(".wrench-whatsapp-mlm-stage-")
            );
            if (stageName === undefined) throw new Error("expected the private stage");
            stagePath = join(parent, stageName);
            displacedStage = `${stagePath}.displaced`;
            renameSync(stagePath, displacedStage);
            mkdirSync(stagePath, { mode: 0o700 });
            writeFileSync(join(stagePath, "foreign-marker"), "preserve\n", { mode: 0o600 });
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(stagePath).toBeDefined();
      expect(displacedStage).toBeDefined();
      expect(errorMessages(caught).join("\n")).toContain("private export directory changed");
      expect(readFileSync(join(stagePath!, "foreign-marker"), "utf8")).toBe("preserve\n");
      const claims = readdirSync(leaseRoot).map((name) =>
        JSON.parse(readFileSync(join(leaseRoot, name), "utf8")) as {
          readonly role: string;
          readonly path: string;
          readonly directoryIdentity: { readonly device: string; readonly inode: string };
        });
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ role: "bundle-stage", path: stagePath });
      const displacedIdentity = lstatSync(displacedStage!);
      const replacementIdentity = lstatSync(stagePath!);
      expect(claims[0]?.directoryIdentity).toMatchObject({
        device: displacedIdentity.dev.toString(),
        inode: displacedIdentity.ino.toString(),
      });
      expect(claims[0]?.directoryIdentity.inode).not.toBe(replacementIdentity.ino.toString());
      expect(existsSync(output)).toBeFalse();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("revalidates exact file bytes after the atomic rename and rolls back tampering", async () => {
    const parent = privateParent();
    const output = resolve(parent, "post-rename-tamper-bundle");
    let tampered = false;
    try {
      let caught: unknown;
      try {
        await exportWhatsAppMessageLikeMeBundle({
          outputRoot: output,
          source: source([accountRecord(), participant("participant-self", SELF_JID, true)]),
          onProgress: (progress) => {
            if (
              tampered
              || progress.phase !== "bundle-publishing"
              || !existsSync(output)
            ) return;
            tampered = true;
            writeFileSync(join(output, "manifest.json"), "{}\n", { mode: 0o600 });
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(tampered).toBeTrue();
      expect(errorMessages(caught).join("\n")).toMatch(/manifest\.json changed|private staged artifact changed/u);
      expect(existsSync(output)).toBeFalse();
      expect(readdirSync(parent).filter((name) => name.startsWith(".wrench-whatsapp-"))).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("does not remove a replacement installed after the atomic rename", async () => {
    const parent = privateParent();
    const output = resolve(parent, "post-rename-replacement-bundle");
    const displacedOutput = `${output}.displaced`;
    const recoveryEnvironment = Object.freeze({ WRENCH_STATE_HOME: join(parent, "state") });
    const leaseRoot = join(
      recoveryEnvironment.WRENCH_STATE_HOME,
      "recovery",
      "beeper-message-like-me-directory-leases",
    );
    let replaced = false;
    try {
      let caught: unknown;
      try {
        await exportWhatsAppMessageLikeMeBundle({
          outputRoot: output,
          source: source([accountRecord(), participant("participant-self", SELF_JID, true)]),
          recoveryEnvironment,
          onProgress: (progress) => {
            if (
              replaced
              || progress.phase !== "bundle-publishing"
              || !existsSync(output)
            ) return;
            replaced = true;
            renameSync(output, displacedOutput);
            mkdirSync(output, { mode: 0o700 });
            writeFileSync(join(output, "foreign-marker"), "preserve\n", { mode: 0o600 });
          },
        });
      } catch (error) {
        caught = error;
      }
      expect(replaced).toBeTrue();
      expect(errorMessages(caught).join("\n")).toContain("private export directory changed");
      expect(readFileSync(join(output, "foreign-marker"), "utf8")).toBe("preserve\n");
      expect(readdirSync(displacedOutput)).toContain("manifest.json");
      const claims = readdirSync(leaseRoot).map((name) =>
        JSON.parse(readFileSync(join(leaseRoot, name), "utf8")) as {
          readonly role: string;
          readonly directoryIdentity: { readonly device: string; readonly inode: string };
        });
      expect(claims).toHaveLength(1);
      expect(claims[0]?.role).toBe("bundle-stage");
      const displacedIdentity = lstatSync(displacedOutput);
      const replacementIdentity = lstatSync(output);
      expect(claims[0]?.directoryIdentity).toMatchObject({
        device: displacedIdentity.dev.toString(),
        inode: displacedIdentity.ino.toString(),
      });
      expect(claims[0]?.directoryIdentity.inode).not.toBe(replacementIdentity.ino.toString());
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
