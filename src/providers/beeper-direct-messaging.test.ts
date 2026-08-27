import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WrenchAuth } from "../auth";
import {
  beeperSubjectFromAccountsAndTarget,
  executeBeeperDirectMessagingPart,
  parseBeeperExportAccounts,
} from "./beeper-local-runtime";

const roots: string[] = [];
const baseUrl = "http://127.0.0.1:23373/";
const bundleId = "com.automattic.beeper.desktop" as const;
const account = Object.freeze({
  accountID: "account-1",
  bridge: Object.freeze({ id: "matrix", provider: "local", type: "matrix" }),
  network: "beeper",
  status: "connected",
  user: Object.freeze({ id: "@self:beeper.com", isSelf: true }),
});
const conversation = Object.freeze({
  id: "!room:beeper.com",
  accountID: "account-1",
  network: "beeper",
  participants: Object.freeze({
    hasMore: false,
    items: Object.freeze([
      Object.freeze({ id: "@self:beeper.com", isSelf: true }),
      Object.freeze({ id: "@friend:beeper.com", isSelf: false }),
    ]),
    total: 2,
  }),
  title: "Friend",
  type: "single",
  unreadCount: 0,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureAuth(): WrenchAuth {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-beeper-direct-")));
  roots.push(root);
  const targets = join(root, "targets");
  mkdirSync(targets, { mode: 0o700 });
  chmodSync(root, 0o700);
  writeFileSync(
    join(root, "config.json"),
    `${JSON.stringify({ defaultTarget: "desktop" })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(targets, "desktop.json"),
    `${JSON.stringify({
      id: "desktop",
      type: "desktop",
      baseURL: baseUrl,
      auth: { accessToken: "fixture-secret", tokenType: "Bearer" },
      managed: false,
      port: 23_373,
      runtime: { install: "desktop", port: 23_373 },
    })}\n`,
    { mode: 0o600 },
  );
  const subject = beeperSubjectFromAccountsAndTarget(
    parseBeeperExportAccounts([account]),
    baseUrl,
    bundleId,
    "4.2.999",
  );
  return Object.freeze({
    schemaVersion: 1,
    id: "beeper-main",
    kind: "linked-device-store",
    provider: "beeper",
    path: root,
    subject,
  });
}

function info(): unknown {
  return {
    app: { bundle_id: bundleId, name: "Beeper", version: "4.2.999" },
    endpoints: {},
    platform: {},
    server: {
      base_url: baseUrl,
      hostname: "127.0.0.1",
      mcp_enabled: true,
      port: 23_373,
      remote_access: false,
      status: "ready",
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Beeper direct messaging transport", () => {
  test("reads and binds the local realm before one fenced no-retry POST", async () => {
    const events: string[] = [];
    const requests: Array<{ url: string; method: string; body: string | null; auth: string | null }> = [];
    const result = await executeBeeperDirectMessagingPart({
      account_id: "account-1",
      conversation_id: "!room:beeper.com",
      kind: "text",
      text: "private exact body",
      reply_to: "event-1",
    }, fixtureAuth(), {
      beforeExternalBegin: () => {
        events.push("boundary");
        return Promise.resolve();
      },
      dependencies: {
        fetch: (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          requests.push({
            url,
            method,
            body: typeof init?.body === "string" ? init.body : null,
            auth: new Headers(init?.headers).get("Authorization"),
          });
          events.push(`${method} ${new URL(url).pathname}`);
          if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
          if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse([account]));
          if (method === "GET") return Promise.resolve(jsonResponse(conversation));
          return Promise.resolve(jsonResponse({
            chatID: "!room:beeper.com",
            pendingMessageID: "pending-1",
          }));
        },
      },
    });

    expect(events).toEqual([
      "GET /v1/info",
      "GET /v1/accounts",
      "GET /v1/chats/!room%3Abeeper.com",
      "boundary",
      "POST /v1/chats/!room%3Abeeper.com/messages",
    ]);
    expect(requests.at(-1)).toEqual({
      url: `${baseUrl.slice(0, -1)}/v1/chats/!room%3Abeeper.com/messages`,
      method: "POST",
      body: JSON.stringify({ text: "private exact body", replyToMessageID: "event-1" }),
      auth: "Bearer fixture-secret",
    });
    expect(result).toMatchObject({
      provider: "beeper",
      operation: "messaging.send",
      accountId: "account-1",
      conversationId: "!room:beeper.com",
      pendingMessageId: "pending-1",
      providerRevision: null,
    });
    expect(JSON.stringify(result)).not.toContain("private exact body");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  test("does not retry a lost response after the durable mutation boundary", async () => {
    let boundary = 0;
    let posts = 0;
    const promise = executeBeeperDirectMessagingPart({
      account_id: "account-1",
      conversation_id: "!room:beeper.com",
      kind: "text",
      text: "one attempt",
    }, fixtureAuth(), {
      beforeExternalBegin: () => {
        boundary += 1;
        return Promise.resolve();
      },
      dependencies: {
        fetch: (input, init) => {
          const url = String(input);
          if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
          if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse([account]));
          if ((init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse(conversation));
          posts += 1;
          return Promise.reject(new Error("synthetic lost response"));
        },
      },
    });
    await expect(promise).rejects.toThrow("synthetic lost response");
    expect(boundary).toBe(1);
    expect(posts).toBe(1);
  });

  test("fails before the boundary when the exact account or chat drifts", async () => {
    let boundary = 0;
    let posts = 0;
    const promise = executeBeeperDirectMessagingPart({
      account_id: "account-1",
      conversation_id: "!room:beeper.com",
      kind: "text",
      text: "never sent",
    }, fixtureAuth(), {
      beforeExternalBegin: () => {
        boundary += 1;
        return Promise.resolve();
      },
      dependencies: {
        fetch: (input, init) => {
          const url = String(input);
          if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
          if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse([account]));
          if ((init?.method ?? "GET") === "GET") {
            return Promise.resolve(jsonResponse({ ...conversation, accountID: "other" }));
          }
          posts += 1;
          return Promise.resolve(jsonResponse({ chatID: "!room:beeper.com", pendingMessageID: "x" }));
        },
      },
    });
    await expect(promise).rejects.toThrow("did not bind the requested account realm");
    expect(boundary).toBe(0);
    expect(posts).toBe(0);
  });

  test("does not start a request when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("synthetic already cancelled"));
    let requests = 0;
    let boundary = 0;
    const promise = executeBeeperDirectMessagingPart({
      account_id: "account-1",
      conversation_id: "!room:beeper.com",
      kind: "text",
      text: "never requested",
    }, fixtureAuth(), {
      beforeExternalBegin: () => {
        boundary += 1;
        return Promise.resolve();
      },
      signal: controller.signal,
      dependencies: {
        fetch: () => {
          requests += 1;
          return Promise.resolve(jsonResponse(info()));
        },
      },
    });
    await expect(promise).rejects.toThrow("synthetic already cancelled");
    expect(requests).toBe(0);
    expect(boundary).toBe(0);
  });

  test("keeps the request deadline active through the bounded response body", async () => {
    let requests = 0;
    let cancelled = false;
    let boundary = 0;
    const promise = executeBeeperDirectMessagingPart({
      account_id: "account-1",
      conversation_id: "!room:beeper.com",
      kind: "text",
      text: "never sent after body stall",
    }, fixtureAuth(), {
      beforeExternalBegin: () => {
        boundary += 1;
        return Promise.resolve();
      },
      dependencies: {
        requestTimeoutMs: 10,
        fetch: () => {
          requests += 1;
          return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"app":'));
            },
            cancel() {
              cancelled = true;
            },
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }));
        },
      },
    });
    await expect(promise).rejects.toThrow("Beeper Desktop direct info timed out");
    expect(requests).toBe(1);
    expect(cancelled).toBeTrue();
    expect(boundary).toBe(0);
  });
});
