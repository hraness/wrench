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
import type { LocalCliRecipe, OperationInput } from "../model";
import { OperationDeadline } from "../operation-deadline";
import {
  beeperSubjectFromAccountsAndTarget,
  executeBeeperLocalOperation,
  parseBeeperExportAccounts,
  type BeeperDirectDependencies,
} from "./beeper-local-runtime";

const roots: string[] = [];
const deadlines: OperationDeadline[] = [];
const baseUrl = "http://127.0.0.1:23373/";
const bundleId = "com.automattic.beeper.desktop" as const;
const selfAccount = Object.freeze({
  accountID: "account-self",
  bridge: Object.freeze({ id: "matrix", provider: "local", type: "matrix" }),
  network: "beeper",
  status: "connected",
  user: Object.freeze({ id: "@self:beeper.com", isSelf: true }),
});
const telegramAccount = Object.freeze({
  accountID: "account-telegram",
  bridge: Object.freeze({ id: "telegram", provider: "cloud", type: "telegram" }),
  network: "telegram",
  status: "connected",
  user: Object.freeze({ id: "telegram:self", isSelf: true }),
});
const accounts = Object.freeze([selfAccount, telegramAccount]);
const conversation = Object.freeze({
  id: "!fixture-group:beeper.test",
  accountID: "account-telegram",
  network: "telegram",
  participants: Object.freeze({
    hasMore: false,
    items: Object.freeze([
      Object.freeze({ id: "telegram:self", isSelf: true }),
      Object.freeze({ id: "telegram:friend", isSelf: false }),
    ]),
    total: 2,
  }),
  title: "Fixture Group",
  type: "group",
  unreadCount: 0,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const deadline of deadlines.splice(0)) deadline.dispose();
});

function fixtureAuth(): WrenchAuth {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wrench-beeper-direct-read-")));
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
  return Object.freeze({
    schemaVersion: 1,
    id: "beeper-main",
    kind: "linked-device-store",
    provider: "beeper",
    path: root,
    subject: beeperSubjectFromAccountsAndTarget(
      parseBeeperExportAccounts(accounts),
      baseUrl,
      bundleId,
      "4.2.999",
    ),
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

function message(id: string, timestamp: string): unknown {
  return {
    id,
    accountID: "account-telegram",
    chatID: "!fixture-group:beeper.test",
    senderID: id === "message-1" ? "telegram:self" : "telegram:friend",
    senderName: id === "message-1" ? "Self" : "Friend",
    isSender: id === "message-1",
    sortKey: id,
    timestamp,
    text: `body ${id}`,
    type: "TEXT",
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function recipe(action: string): LocalCliRecipe {
  return {
    surface: "beeper",
    action,
    contractVersion: 2,
    timeoutMs: 120_000,
    maxOutputBytes: 10 * 1024 * 1024,
  };
}

async function execute(
  action: string,
  input: OperationInput,
  dependencies: BeeperDirectDependencies,
) {
  const deadline = new OperationDeadline(120_000);
  deadlines.push(deadline);
  return executeBeeperLocalOperation(
    recipe(action),
    input,
    fixtureAuth(),
    {
      operationDeadline: deadline,
      signal: deadline.signal,
      directDependencies: dependencies,
    },
  );
}

describe("Beeper Desktop direct read contract v2", () => {
  test("lists the bound account realm without starting a CLI child", async () => {
    const requests: Array<{ route: string; authorization: string | null }> = [];
    const result = await execute("accounts.list", {}, {
      fetch: (input, init) => {
        const url = String(input);
        requests.push({
          route: `${init?.method ?? "GET"} ${new URL(url).pathname}`,
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return Promise.resolve(jsonResponse(
          url.endsWith("/v1/info") ? info() : accounts,
        ));
      },
    });

    expect(requests).toEqual([
      { route: "GET /v1/info", authorization: "Bearer fixture-secret" },
      { route: "GET /v1/accounts", authorization: "Bearer fixture-secret" },
    ]);
    expect(result.status).toBe("succeeded");
    expect(result.dispatchStarted).toBeFalse();
    expect((result.output as { accounts: readonly unknown[] }).accounts)
      .toHaveLength(2);
    expect(JSON.stringify(result.output)).not.toContain("fixture-secret");
  });

  test("fails closed on malformed direct-info metadata", async () => {
    let requests = 0;
    const promise = execute("accounts.list", {}, {
      fetch: (input) => {
        requests += 1;
        const url = String(input);
        if (url.endsWith("/v1/info")) {
          const valid = info() as Readonly<Record<string, unknown>>;
          const app = valid.app as Readonly<Record<string, unknown>>;
          return Promise.resolve(jsonResponse({
            ...valid,
            app: { ...app, name: { unreviewed: true } },
          }));
        }
        return Promise.resolve(jsonResponse(accounts));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
    expect(requests).toBe(1);
  });

  test("searches the fixed chat endpoint with repeated-key account binding", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const result = await execute("messaging.search", {
      account_id: "account-telegram",
      query: "Fixture Group",
      limit: 20,
    }, {
      fetch: (input, init) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET", body: init?.body });
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse({
          items: [conversation],
          hasMore: false,
          oldestCursor: null,
          newestCursor: null,
        }));
      },
    });

    const search = new URL(requests[2]!.url);
    expect(search.pathname).toBe("/v1/chats/search");
    expect(search.searchParams.get("query")).toBe("Fixture Group");
    expect(search.searchParams.getAll("accountIDs")).toEqual(["account-telegram"]);
    expect(search.searchParams.get("limit")).toBe("20");
    expect(requests.every(({ method, body }) => method === "GET" && body == null))
      .toBeTrue();
    const output = result.output as {
      conversations: readonly { title: string; network: string }[];
    };
    expect(output.conversations).toEqual([
      expect.objectContaining({ title: "Fixture Group", network: "telegram" }),
    ]);
    expect(requests.some(({ url }) => new URL(url).pathname.endsWith("/read")))
      .toBeFalse();
  });

  test("rejects an unbound search account before the semantic request", async () => {
    const requests: string[] = [];
    const promise = execute("messaging.search", {
      account_id: "account-outside-realm",
      query: "Fixture Group",
      limit: 20,
    }, {
      fetch: (input) => {
        const url = String(input);
        requests.push(new URL(url).pathname);
        return Promise.resolve(jsonResponse(
          url.endsWith("/v1/info") ? info() : accounts,
        ));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
    expect(requests).toEqual(["/v1/info", "/v1/accounts"]);
  });

  test("rejects replayed chat-search cursors and duplicate chat identities", async () => {
    for (const mode of ["cursor", "chat"] as const) {
      let page = 0;
      const promise = execute("messaging.search", {
        account_id: "account-telegram",
        query: "Fixture Group",
        limit: 20,
      }, {
        fetch: (input) => {
          const url = String(input);
          if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
          if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
          page += 1;
          return Promise.resolve(jsonResponse({
            items: [mode === "chat" || page === 1
              ? conversation
              : { ...conversation, id: "!other:beeper.com", title: "Other" }],
            hasMore: true,
            oldestCursor: mode === "cursor" || page === 1
              ? "opaque-chat-cursor"
              : "opaque-chat-cursor-next",
            newestCursor: `opaque-newest-chat-${String(page)}`,
          }));
        },
      });

      await expect(promise).rejects.toThrow(
        "Beeper local execution failed at a protected local boundary",
      );
      expect(page).toBe(2);
    }
  });

  test("reads one exact chat without invoking a read-state route", async () => {
    const requests: string[] = [];
    const result = await execute("conversations.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      max_participants: 500,
    }, {
      fetch: (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse(conversation));
      },
    });

    const chat = new URL(requests[2]!);
    expect(chat.pathname).toBe("/v1/chats/!fixture-group%3Abeeper.test");
    expect(chat.searchParams.get("maxParticipantCount")).toBe("500");
    expect((result.output as { conversation: { title: string } }).conversation.title)
      .toBe("Fixture Group");
    expect(requests.some((url) => new URL(url).pathname.endsWith("/read")))
      .toBeFalse();
  });

  test("searches message content through exact filters without requiring query text", async () => {
    const requests: URL[] = [];
    const result = await execute("messaging.content.search", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      chat_type: "group",
      after: "2026-08-31T00:00:00.000Z",
      before: "2026-08-31T04:00:00.000Z",
      exclude_low_priority: false,
      include_muted: true,
      media: ["link", "file"],
      sender: "others",
      limit: 20,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        requests.push(new URL(url));
        return Promise.resolve(jsonResponse({
          chats: { [conversation.id]: conversation },
          items: [message("message-2", "2026-08-31T02:00:00.000Z")],
          hasMore: false,
          oldestCursor: "opaque-before-message-2",
          newestCursor: "opaque-after-message-2",
        }));
      },
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.pathname).toBe("/v1/messages/search");
    expect(request.searchParams.has("query")).toBeFalse();
    expect(request.searchParams.getAll("accountIDs")).toEqual(["account-telegram"]);
    expect(request.searchParams.getAll("chatIDs")).toEqual(["!fixture-group:beeper.test"]);
    expect(request.searchParams.get("chatType")).toBe("group");
    expect(request.searchParams.get("dateAfter")).toBe("2026-08-31T00:00:00.000Z");
    expect(request.searchParams.get("dateBefore")).toBe("2026-08-31T04:00:00.000Z");
    expect(request.searchParams.get("excludeLowPriority")).toBe("false");
    expect(request.searchParams.get("includeMuted")).toBe("true");
    expect(request.searchParams.getAll("mediaTypes")).toEqual(["link", "file"]);
    expect(request.searchParams.get("sender")).toBe("others");
    expect(request.searchParams.get("limit")).toBe("20");
    const output = result.output as {
      messages: readonly { id: string }[];
      continuation: unknown;
      completeness: { resultWindowComplete: boolean };
    };
    expect(output.messages.map(({ id }) => id)).toEqual(["message-2"]);
    expect(output.continuation).toBeNull();
    expect(output.completeness.resultWindowComplete).toBeTrue();
  });

  test("paginates message search with the documented directional cursor", async () => {
    const requests: URL[] = [];
    const result = await execute("messaging.content.search", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      before_cursor: "opaque-before-start",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        const request = new URL(url);
        requests.push(request);
        return Promise.resolve(jsonResponse(requests.length === 1
          ? {
              chats: { [conversation.id]: conversation },
              items: [message("message-2", "2026-08-31T02:00:00.000Z")],
              hasMore: true,
              oldestCursor: "opaque-before-message-2",
              newestCursor: "opaque-after-message-2",
            }
          : {
              chats: { [conversation.id]: conversation },
              items: [message("message-1", "2026-08-31T01:00:00.000Z")],
              hasMore: true,
              oldestCursor: "opaque-before-message-1",
              newestCursor: "opaque-after-message-1",
            }));
      },
    });

    expect(requests.map((request) => ({
      cursor: request.searchParams.get("cursor"),
      direction: request.searchParams.get("direction"),
      limit: request.searchParams.get("limit"),
    }))).toEqual([
      { cursor: "opaque-before-start", direction: "before", limit: "2" },
      { cursor: "opaque-before-message-2", direction: "before", limit: "1" },
    ]);
    expect((result.output as { continuation: unknown }).continuation).toEqual({
      direction: "before",
      cursor: "opaque-before-message-1",
    });
  });

  test("rejects replayed message-search cursors and duplicate message identities", async () => {
    for (const mode of ["cursor", "message"] as const) {
      let page = 0;
      const promise = execute("messaging.content.search", {
        account_id: "account-telegram",
        conversation_id: "!fixture-group:beeper.test",
        before_cursor: "opaque-before-start",
        limit: 3,
      }, {
        fetch: (input) => {
          const url = String(input);
          if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
          if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
          page += 1;
          return Promise.resolve(jsonResponse({
            chats: { [conversation.id]: conversation },
            items: [message(
              mode === "message" ? "message-2" : `message-${String(3 - page)}`,
              page === 1
                ? "2026-08-31T02:00:00.000Z"
                : "2026-08-31T01:00:00.000Z",
            )],
            hasMore: true,
            oldestCursor: mode === "cursor" || page === 1
              ? "opaque-before-message-2"
              : "opaque-before-message-1",
            newestCursor: `opaque-after-${String(page)}`,
          }));
        },
      });

      await expect(promise).rejects.toThrow(
        "Beeper local execution failed at a protected local boundary",
      );
      expect(page).toBe(2);
    }
  });

  test("rejects message-search results whose chat map or exact coordinates drift", async () => {
    for (const drift of ["map", "coordinate"] as const) {
      const promise = execute("messaging.content.search", {
        account_id: "account-telegram",
        conversation_id: "!fixture-group:beeper.test",
        limit: 20,
      }, {
        fetch: (input) => {
          const url = String(input);
          if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
          if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
          const exact = message(
            "message-2",
            "2026-08-31T02:00:00.000Z",
          ) as Readonly<Record<string, unknown>>;
          const escaped = drift === "coordinate"
            ? { ...exact, chatID: "!other:beeper.com" }
            : exact;
          return Promise.resolve(jsonResponse({
            chats: drift === "map" ? {} : { [conversation.id]: conversation },
            items: [escaped],
            hasMore: false,
            oldestCursor: null,
            newestCursor: null,
          }));
        },
      });

      await expect(promise).rejects.toThrow(
        "Beeper local execution failed at a protected local boundary",
      );
    }
  });

  test("binds each message-search chat map entry to its result account", async () => {
    const promise = execute("messaging.content.search", {
      conversation_id: "!fixture-group:beeper.test",
      limit: 20,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse({
          chats: {
            [conversation.id]: {
              ...conversation,
              accountID: "account-self",
              network: "beeper",
            },
          },
          items: [message("message-2", "2026-08-31T02:00:00.000Z")],
          hasMore: false,
          oldestCursor: null,
          newestCursor: null,
        }));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
  });

  test("enforces the requested participant projection bound", async () => {
    const promise = execute("conversations.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      max_participants: 1,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse(conversation));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
  });

  test("paginates bounded message history and returns no continuation at the local end", async () => {
    const requests: string[] = [];
    const result = await execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      limit: 3,
    }, {
      fetch: (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        const cursor = new URL(url).searchParams.get("cursor");
        return Promise.resolve(jsonResponse(cursor === null
          ? {
              items: [
                message("message-3", "2026-08-31T03:00:00.000Z"),
                message("message-2", "2026-08-31T02:00:00.000Z"),
              ],
              hasMore: true,
              oldestCursor: "cursor-message-2",
              newestCursor: "cursor-message-3",
            }
          : {
              items: [message("message-1", "2026-08-31T01:00:00.000Z")],
              hasMore: false,
              oldestCursor: "cursor-message-1",
              newestCursor: "cursor-message-1",
            }));
      },
    });

    const messageRequests = requests.slice(2).map((url) => new URL(url));
    expect(messageRequests.map((url) => url.pathname)).toEqual([
      "/v1/chats/!fixture-group%3Abeeper.test/messages",
      "/v1/chats/!fixture-group%3Abeeper.test/messages",
    ]);
    expect(messageRequests[1]!.searchParams.get("cursor"))
      .toBe("cursor-message-2");
    expect(messageRequests[1]!.searchParams.get("direction")).toBe("before");
    const output = result.output as {
      messages: readonly { id: string }[];
      continuation: unknown;
      completeness: { localPageComplete: boolean };
    };
    expect(output.messages.map(({ id }) => id)).toEqual([
      "message-3",
      "message-2",
      "message-1",
    ]);
    expect(output.continuation).toBeNull();
    expect(output.completeness.localPageComplete).toBeTrue();
    expect(requests.some((url) => new URL(url).pathname.endsWith("/read")))
      .toBeFalse();
  });

  test("rejects duplicate message IDs within one history provider page", async () => {
    const promise = execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        const duplicate = message("message-1", "2026-08-31T01:00:00.000Z");
        return Promise.resolve(jsonResponse({
          items: [duplicate, duplicate],
          hasMore: false,
          oldestCursor: null,
          newestCursor: null,
        }));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
  });

  test("round-trips the opaque provider cursor at a no-skip page boundary", async () => {
    const first = await execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse({
          items: [
            message("message-3", "2026-08-31T03:00:00.000Z"),
            message("message-2", "2026-08-31T02:00:00.000Z"),
          ],
          hasMore: true,
          oldestCursor: "opaque-before-message-2",
          newestCursor: "opaque-after-message-3",
        }));
      },
    });

    expect((first.output as { continuation: unknown }).continuation).toEqual({
      direction: "before",
      cursor: "opaque-before-message-2",
    });

    const messageRequests: URL[] = [];
    const second = await execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      before_cursor: "opaque-before-message-2",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        messageRequests.push(new URL(url));
        return Promise.resolve(jsonResponse({
          items: [message("message-1", "2026-08-31T01:00:00.000Z")],
          hasMore: false,
          oldestCursor: "opaque-before-message-1",
          newestCursor: "opaque-after-message-1",
        }));
      },
    });

    expect(messageRequests[0]!.searchParams.get("cursor"))
      .toBe("opaque-before-message-2");
    expect(messageRequests[0]!.searchParams.get("direction")).toBe("before");
    expect((second.output as { messages: readonly { id: string }[] }).messages)
      .toEqual([expect.objectContaining({ id: "message-1" })]);
    expect((second.output as { continuation: unknown }).continuation).toBeNull();
  });

  test("fails closed instead of cutting inside the first provider page", async () => {
    const promise = execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      limit: 1,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse({
          items: [
            message("message-3", "2026-08-31T03:00:00.000Z"),
            message("message-2", "2026-08-31T02:00:00.000Z"),
          ],
          hasMore: false,
          oldestCursor: "opaque-before-message-2",
          newestCursor: "opaque-after-message-3",
        }));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
  });

  test("advances forward history with the newest opaque cursor", async () => {
    const messageRequests: URL[] = [];
    const result = await execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      after_cursor: "opaque-after-start",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        const request = new URL(url);
        messageRequests.push(request);
        return Promise.resolve(jsonResponse(messageRequests.length === 1
          ? {
              items: [message("message-1", "2026-08-31T01:00:00.000Z")],
              hasMore: true,
              oldestCursor: "opaque-oldest-message-1",
              newestCursor: "opaque-newest-message-1",
            }
          : {
              items: [message("message-2", "2026-08-31T02:00:00.000Z")],
              hasMore: false,
              oldestCursor: "opaque-oldest-message-2",
              newestCursor: "opaque-newest-message-2",
            }));
      },
    });

    expect(messageRequests.map((request) => ({
      cursor: request.searchParams.get("cursor"),
      direction: request.searchParams.get("direction"),
    }))).toEqual([
      { cursor: "opaque-after-start", direction: "after" },
      { cursor: "opaque-newest-message-1", direction: "after" },
    ]);
    expect((result.output as { messages: readonly { id: string }[] }).messages
      .map(({ id }) => id)).toEqual(["message-1", "message-2"]);
    expect((result.output as { continuation: unknown }).continuation).toBeNull();
  });

  test("crosses an empty provider page only through an advancing opaque cursor", async () => {
    const messageRequests: URL[] = [];
    const result = await execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        const request = new URL(url);
        messageRequests.push(request);
        if (messageRequests.length === 1) {
          return Promise.resolve(jsonResponse({
            items: [message("message-2", "2026-08-31T02:00:00.000Z")],
            hasMore: true,
            oldestCursor: "opaque-before-message-2",
            newestCursor: "opaque-after-message-2",
          }));
        }
        if (messageRequests.length === 2) {
          return Promise.resolve(jsonResponse({
            items: [],
            hasMore: true,
            oldestCursor: "opaque-before-empty-gap",
            newestCursor: "opaque-after-empty-gap",
          }));
        }
        return Promise.resolve(jsonResponse({
          items: [message("message-1", "2026-08-31T01:00:00.000Z")],
          hasMore: false,
          oldestCursor: "opaque-before-message-1",
          newestCursor: "opaque-after-message-1",
        }));
      },
    });

    expect(messageRequests.map((request) => request.searchParams.get("cursor")))
      .toEqual([null, "opaque-before-message-2", "opaque-before-empty-gap"]);
    expect((result.output as { messages: readonly { id: string }[] }).messages
      .map(({ id }) => id)).toEqual(["message-2", "message-1"]);
    expect((result.output as { continuation: unknown }).continuation).toBeNull();
  });

  test("rejects an empty provider page whose opaque cursor does not advance", async () => {
    let messageRequests = 0;
    const promise = execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      before_cursor: "opaque-before-gap",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        messageRequests += 1;
        if (messageRequests === 1) {
          return Promise.resolve(jsonResponse({
            items: [message("message-1", "2026-08-31T01:00:00.000Z")],
            hasMore: true,
            oldestCursor: "opaque-before-next",
            newestCursor: "opaque-after-message-1",
          }));
        }
        return Promise.resolve(jsonResponse({
          items: [],
          hasMore: true,
          oldestCursor: "opaque-before-next",
          newestCursor: "opaque-after-gap",
        }));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
    expect(messageRequests).toBe(2);
  });

  test("returns an opaque checkpoint at the internal eight-page request bound", async () => {
    let messagePage = 0;
    const result = await execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      limit: 9,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        messagePage += 1;
        return Promise.resolve(jsonResponse({
          items: [message(
            `message-${String(messagePage)}`,
            `2026-08-31T${String(messagePage).padStart(2, "0")}:00:00.000Z`,
          )],
          hasMore: true,
          oldestCursor: `opaque-before-${String(messagePage)}`,
          newestCursor: `opaque-after-${String(messagePage)}`,
        }));
      },
    });

    const output = result.output as {
      messages: readonly unknown[];
      continuation: unknown;
      completeness: { localPageComplete: boolean };
    };
    expect(messagePage).toBe(8);
    expect(output.messages).toHaveLength(8);
    expect(output.continuation).toEqual({
      direction: "before",
      cursor: "opaque-before-8",
    });
    expect(output.completeness.localPageComplete).toBeFalse();
  });

  test("requires both documented cursor keys in every provider page", async () => {
    const promise = execute("messaging.read", {
      account_id: "account-telegram",
      conversation_id: "!fixture-group:beeper.test",
      limit: 2,
    }, {
      fetch: (input) => {
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse({
          items: [message("message-1", "2026-08-31T01:00:00.000Z")],
          hasMore: false,
          oldestCursor: null,
        }));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
  });

  test("fails closed on an unreviewed cursor envelope without retrying", async () => {
    let requests = 0;
    const promise = execute("messaging.search", {
      query: "Fixture Group",
      limit: 20,
    }, {
      fetch: (input) => {
        requests += 1;
        const url = String(input);
        if (url.endsWith("/v1/info")) return Promise.resolve(jsonResponse(info()));
        if (url.endsWith("/v1/accounts")) return Promise.resolve(jsonResponse(accounts));
        return Promise.resolve(jsonResponse({
          items: [conversation],
          hasMore: false,
          oldestCursor: null,
          newestCursor: null,
          unreviewed: true,
        }));
      },
    });

    await expect(promise).rejects.toThrow(
      "Beeper local execution failed at a protected local boundary",
    );
    expect(requests).toBe(3);
  });
});
