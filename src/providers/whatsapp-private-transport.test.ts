import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  executeWhatsAppPrivateTextSend,
  type WacliInvocation,
  type WacliInvocationResult,
  type WhatsAppWebRuntimeDependencies,
} from "./whatsapp-web-runtime";
import {
  planWhatsAppPrivateTextSend,
  qualifiedWhatsAppPrivateMessagingAction,
} from "./whatsapp-private-transport";
import { WHATSAPP_PROTOCOL_PIN } from "./whatsapp-web";

const CHAT_JID = "15557654321@s.whatsapp.net";
const PROTOCOL_HASH =
  "6032c414835e4370de96718d9cc5add08e7f9f59354217e3e46d73a97d3e2ba1";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function binding(store: string): Record<string, unknown> {
  return {
    protocol_hash: PROTOCOL_HASH,
    tool_hash: WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256,
    store_subject: sha256(store),
    auth_subject: HASH_A,
    daemon_pid: 4242,
    daemon_started_at: "2026-08-27T16:00:00.123456789Z",
    connection_epoch: 7,
  };
}

function privateEnvelope(
  store: string,
  state: "idle" | "submitted" | "still_in_flight" | "indeterminate" | "failed",
  overrides: Record<string, unknown> = {},
): string {
  const ok = state === "idle" || state === "submitted";
  return `${JSON.stringify({
    success: true,
    data: {
      schema_version: 1,
      ok,
      state,
      ...(!ok ? { reason: "mutation_worker_active" } : {}),
      binding: binding(store),
      nonce: "d".repeat(48),
      recorded_at: "2026-08-27T16:00:01.123456789Z",
      mac: "e".repeat(64),
      ...(state === "idle" ? { barrier_sequence: 3 } : {}),
      ...overrides,
    },
    error: null,
  })}\n`;
}

function submittedEnvelope(store: string, routeSha256: string): string {
  return privateEnvelope(store, "submitted", {
    route_sha256: routeSha256,
    request_sha256: HASH_A,
    message_id_sha256: HASH_B,
    committed_revision: HASH_C,
    barrier_sequence: 9,
  });
}

function runtime(store: string): Parameters<typeof executeWhatsAppPrivateTextSend>[0] {
  return {
    auth: {
      schemaVersion: 1,
      id: "whatsapp-test",
      kind: "linked-device-store",
      provider: "whatsapp",
      path: store,
      subject: "whatsapp:pn:15551234567",
    },
    binary: "/fixture/wacli",
    store,
    subject: "whatsapp:pn:15551234567",
  };
}

function recipe() {
  return {
    site: "whatsapp",
    action: "messaging.send",
    contractVersion: 1,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
  } as const;
}

describe("WhatsApp private transport provider boundary", () => {
  test("keeps recipient and text in one strict stdin payload", () => {
    const plan = planWhatsAppPrivateTextSend({
      conversation_jid: CHAT_JID,
      body: "private fixture body",
    }, 5_000);
    expect(JSON.parse(plan.stdin)).toEqual({
      to: CHAT_JID,
      message: "private fixture body",
      no_preview: true,
      no_retry: true,
      timeout_ms: 5_000,
    });
    expect(plan.routeSha256).toBe(sha256(CHAT_JID));
    expect(plan.bodySha256).toBe(sha256("private fixture body"));
    expect(() => planWhatsAppPrivateTextSend({
      conversation_jid: CHAT_JID,
      body: " private fixture body",
    }, 5_000)).toThrow("leading or trailing whitespace");
    expect(() => planWhatsAppPrivateTextSend({
      conversation_jid: CHAT_JID,
      body: "😀".repeat(5_000),
    }, 5_000)).toThrow("UTF-8 byte bound");
    expect(() => planWhatsAppPrivateTextSend({
      conversation_jid: CHAT_JID,
      body: "body",
      reply_to_message_id: "MSG-1",
    }, 5_000)).toThrow("unsupported fields");
  });

  test("runs an authenticated idle barrier then submits exactly once without argv or env body", async () => {
    const store = "/private/fixture/whatsapp-store";
    const calls: WacliInvocation[] = [];
    const events: string[] = [];
    const dependencies: WhatsAppWebRuntimeDependencies = {
      binaryPath: "/fixture/wacli",
      run: (invocation) => {
        calls.push(invocation);
        if (invocation.arguments.includes("status")) {
          events.push("status-barrier");
          return Promise.resolve({
            exitCode: 0,
            stdout: privateEnvelope(store, "idle"),
            stderr: "",
          });
        }
        invocation.onSpawn?.();
        events.push("send-process");
        const payload = JSON.parse(invocation.stdin ?? "null") as {
          readonly to: string;
          readonly message: string;
        };
        return Promise.resolve({
          exitCode: 0,
          stdout: submittedEnvelope(store, sha256(payload.to)),
          stderr: "",
        });
      },
    };
    const result = await executeWhatsAppPrivateTextSend(
      runtime(store),
      recipe(),
      { conversation_jid: CHAT_JID, body: "private fixture body" },
      {
        dependencies,
        beforeDispatch: () => {
          events.push("journal-durable");
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          events.push("proof-durable");
          return Promise.resolve();
        },
      },
    );
    expect(result.status).toBe("succeeded");
    expect(result.dispatch).toEqual({ planned: 1, started: 1, verified: 1 });
    expect(events).toEqual([
      "journal-durable",
      "status-barrier",
      "send-process",
      "proof-durable",
    ]);
    expect(calls).toHaveLength(2);
    const send = calls[1]!;
    expect(send.arguments).toEqual([
      "--store",
      store,
      "--json",
      "--full",
      "--timeout",
      "29500ms",
      "wrench-private",
      "send",
      "--input",
      "-",
    ]);
    expect(send.arguments.join(" ")).not.toContain(CHAT_JID);
    expect(send.arguments.join(" ")).not.toContain("private fixture body");
    expect(JSON.stringify(send.environment)).not.toContain(CHAT_JID);
    expect(JSON.stringify(send.environment)).not.toContain("private fixture body");
    expect(send.stdin).toContain("private fixture body");
    const accepted = qualifiedWhatsAppPrivateMessagingAction.mapAcceptedResult(
      result.output,
    );
    expect(accepted).toEqual({ state: "submitted", providerMessageId: HASH_B });
  });

  test("never retries when a late worker remains in flight", async () => {
    const store = "/private/fixture/late-store";
    const calls: WacliInvocation[] = [];
    let finish: ((result: WacliInvocationResult) => void) | undefined;
    const late = new Promise<WacliInvocationResult>((resolve) => {
      finish = resolve;
    });
    const operation = executeWhatsAppPrivateTextSend(
      runtime(store),
      recipe(),
      { conversation_jid: CHAT_JID, body: "late fixture" },
      {
        dependencies: {
          binaryPath: "/fixture/wacli",
          run: (invocation) => {
            calls.push(invocation);
            if (invocation.arguments.includes("status")) {
              return Promise.resolve({
                exitCode: 0,
                stdout: privateEnvelope(store, "idle"),
                stderr: "",
              });
            }
            invocation.onSpawn?.();
            return late;
          },
        },
      },
    );
    for (let index = 0; index < 10 && calls.length < 2; index += 1) {
      await Promise.resolve();
    }
    expect(calls.filter((call) => call.arguments.includes("send"))).toHaveLength(1);
    finish?.({
      exitCode: 1,
      stdout: privateEnvelope(store, "still_in_flight", {
        route_sha256: sha256(CHAT_JID),
        request_sha256: HASH_A,
        message_id_sha256: HASH_B,
      }),
      stderr: "",
    });
    const result = await operation;
    expect(result.status).toBe("indeterminate");
    expect(result.dispatch).toEqual({ planned: 1, started: 1, verified: 0 });
    expect(calls.filter((call) => call.arguments.includes("send"))).toHaveLength(1);
    expect(result.error).toContain("reconciled");
  });
});

describe("WhatsApp private transport provenance", () => {
  test("binds every vendored patch and license to the source manifest", () => {
    const vendor = join(import.meta.dir, "../vendor/whatsapp-private-transport");
    const manifest = JSON.parse(
      readFileSync(join(vendor, "manifest.json"), "utf8"),
    ) as {
      readonly wacli: Record<string, string>;
      readonly whatsmeow: Record<string, string>;
      readonly build: Record<string, string>;
      readonly protocol: Record<string, string | number>;
    };
    expect(manifest.wacli.patchSha256).toBe(sha256(readFileSync(
      join(vendor, manifest.wacli.patchFile!),
    )));
    expect(manifest.whatsmeow.patchSha256).toBe(sha256(readFileSync(
      join(vendor, manifest.whatsmeow.patchFile!),
    )));
    expect(manifest.wacli.licenseSha256).toBe(sha256(readFileSync(
      join(vendor, manifest.wacli.licenseFile!),
    )));
    expect(manifest.whatsmeow.licenseSha256).toBe(sha256(readFileSync(
      join(vendor, manifest.whatsmeow.licenseFile!),
    )));
    expect(manifest.build.binarySha256).toBe(
      WHATSAPP_PROTOCOL_PIN.darwinArm64BinarySha256,
    );
    expect(manifest.protocol.descriptorSha256).toBe(PROTOCOL_HASH);
  });
});
