import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth } from "./auth";
import { isProviderOperation, type WrenchManifest } from "./model";
import {
  executeProviderOperation as executeProviderOperationWithRegistry,
  requireExecutableProviderOperation,
  type ProviderActionContext,
} from "./provider";
import type { OperationDeadlineClock } from "./operation-deadline";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";

type ExecuteProviderOptions =
  Parameters<typeof executeProviderOperationWithRegistry>[4];

function executeProviderOperation(
  manifest: Parameters<typeof executeProviderOperationWithRegistry>[0],
  recipe: Parameters<typeof executeProviderOperationWithRegistry>[1],
  input: Parameters<typeof executeProviderOperationWithRegistry>[2],
  auth: Parameters<typeof executeProviderOperationWithRegistry>[3],
  options: Omit<ExecuteProviderOptions, "registry"> & {
    readonly registry?: ProviderPluginRegistry;
  },
) {
  return executeProviderOperationWithRegistry(
    manifest,
    recipe,
    input,
    auth,
    {
      ...options,
      registry: options.registry ?? providerPluginRegistry,
    },
  );
}

class FakeMonotonicClock implements OperationDeadlineClock {
  #nowMs = 0;
  #nextId = 1;
  readonly #scheduled = new Map<number, {
    readonly at: number;
    readonly callback: () => void;
  }>();

  readonly now = (): number => this.#nowMs;

  readonly schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#scheduled.set(id, { at: this.#nowMs + delayMs, callback });
    return () => {
      this.#scheduled.delete(id);
    };
  };

  advance(milliseconds: number): void {
    this.#nowMs += milliseconds;
    for (;;) {
      const due = [...this.#scheduled.entries()]
        .filter(([, value]) => value.at <= this.#nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }

  pendingTimers(): number {
    return this.#scheduled.size;
  }
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return new URL(input);
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function fixture(scopes: readonly string[]): {
  readonly root: string;
  readonly manifest: WrenchManifest;
  readonly auth: ReturnType<typeof createAuth>;
  readonly token: string;
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wrench-provider-test-"));
  chmodSync(root, 0o700);
  const tokenPath = join(root, "token.json");
  const token = "private-provider-access-token";
  const auth = createAuth("x-official", {
    oauthProvider: "x",
    tokenFile: tokenPath,
    scopes,
    subject: "12345",
  });
  writeFileSync(tokenPath, JSON.stringify({
    schemaVersion: 1,
    provider: "x",
    subject: "12345",
    scopes: auth.kind === "oauth-token-file" ? auth.scopes : [],
    accessToken: token,
    expiresAt: "2099-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  const manifest = JSON.parse(readFileSync(
    join(import.meta.dir, "assets", "adapters", "x", "wrench-adapter.json"),
    "utf8",
  )) as WrenchManifest;
  return { root, manifest, auth, token };
}

function providerRecipe(manifest: WrenchManifest, operationId: string) {
  const operation = manifest.operations[operationId];
  if (operation === undefined || !isProviderOperation(operation)) throw new Error("expected provider operation");
  return operation.provider;
}

function updateTokenExpiry(root: string, expiresAt: string): void {
  const path = join(root, "token.json");
  const token = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...token, expiresAt }), { mode: 0o600 });
}

function withProviderExecute(
  execute: (context: ProviderActionContext) => Promise<void>,
): ProviderPluginRegistry {
  const requireOperationDefinition:
    ProviderPluginRegistry["requireOperationDefinition"] = (...args) => {
      const resolution = providerPluginRegistry.requireOperationDefinition(...args);
      if (resolution.binding.transport !== "provider-api") return resolution;
      return Object.freeze({
        ...resolution,
        binding: Object.freeze({
          ...resolution.binding,
          execute,
        }),
      });
    };
  return Object.freeze({
    ...providerPluginRegistry,
    requireOperationDefinition,
  });
}

describe("official-provider execution boundary", () => {
  test("fails closed for a capture-required provider descriptor", () => {
    expect(() => requireExecutableProviderOperation({
      name: "timelines.bulk-read",
      state: "capture-required",
    })).toThrow("requires a reviewed provider contract before execution");
  });

  test("loads a private token and executes a contract-bound, zero-dispatch X read", async () => {
    const value = fixture(["tweet.read", "users.read"]);
    const calls: { readonly url: URL; readonly authorization: string | null }[] = [];
    try {
      const execution = await executeProviderOperation(
        value.manifest,
        providerRecipe(value.manifest, "posts.read"),
        { post_ids: ["123"] },
        value.auth,
        {
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            calls.push({ url: requestUrl(input), authorization: headers.get("Authorization") });
            return Promise.resolve(new Response(JSON.stringify({
              data: [{ id: "123", text: "hello" }],
              includes: {},
            }), { status: 200, headers: { "Content-Type": "application/json" } }));
          },
        },
      );

      expect(execution).toMatchObject({
        status: "succeeded",
        finalUrl: "https://x.com/i/web/status/123",
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
        output: {
          provider: "x",
          operation: "posts.read",
          items: [{ id: "123", text: "hello" }],
          coverage: { complete: true, requestedIds: ["123"], returned: 1 },
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url.origin).toBe("https://api.x.com");
      expect(calls[0]?.url.pathname).toBe("/2/tweets");
      expect(calls[0]?.authorization).toBe(`Bearer ${value.token}`);
      expect(JSON.stringify(execution)).not.toContain(value.token);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("routes the production default through the DNS-pinned Wrench transport", async () => {
    const value = fixture(["tweet.read", "users.read"]);
    const calls: {
      readonly url: URL;
      readonly timeoutMs: number;
      readonly redirect: RequestInit["redirect"];
      readonly signal: AbortSignal | null | undefined;
    }[] = [];
    try {
      const execution = await executeProviderOperation(
        value.manifest,
        providerRecipe(value.manifest, "posts.read"),
        { post_ids: ["123"] },
        value.auth,
        {
          pinnedFetch: (url, init, timeoutMs) => {
            calls.push({
              url,
              timeoutMs,
              redirect: init.redirect,
              signal: init.signal,
            });
            return Promise.resolve(new Response(JSON.stringify({
              data: [{ id: "123", text: "hello" }],
              includes: {},
            }), { status: 200 }));
          },
        },
      );

      expect(execution.status).toBe("succeeded");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url.origin).toBe("https://api.x.com");
      expect(calls[0]?.timeoutMs).toBeGreaterThanOrEqual(1_000);
      expect(calls[0]?.redirect).toBe("error");
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("durably brackets exactly one desired-state write dispatch", async () => {
    const value = fixture(["bookmark.write", "tweet.read", "users.read"]);
    const events: string[] = [];
    let calls = 0;
    try {
      const execution = await executeProviderOperation(
        value.manifest,
        providerRecipe(value.manifest, "content.save"),
        { post_id: "777", enabled: true },
        value.auth,
        {
          fetch: (input, init) => {
            calls += 1;
            const url = requestUrl(input);
            if (url.pathname === "/2/users/me") {
              return Promise.resolve(new Response('{"data":{"id":"12345"}}', { status: 200 }));
            }
            expect(url.pathname).toBe("/2/users/12345/bookmarks");
            expect(init?.method).toBe("POST");
            expect(init?.body).toBe('{"tweet_id":"777"}');
            return Promise.resolve(new Response('{"data":{"bookmarked":true}}', { status: 200 }));
          },
          beforeDispatch: (event) => {
            events.push(`before:${event.id}:${event.progress.started}/${event.progress.verified}`);
            return Promise.resolve();
          },
          afterDispatchVerified: (event) => {
            events.push(`after:${event.id}:${event.progress.started}/${event.progress.verified}`);
            return Promise.resolve();
          },
        },
      );

      expect(calls).toBe(2);
      expect(events).toEqual(["before:content-save:0/0", "after:content-save:1/1"]);
      expect(execution).toMatchObject({
        status: "succeeded",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 1 },
        output: { provider: "x", operation: "content.save", postId: "777", enabled: true },
      });
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("fails before network access when the OAuth locator lacks a complete contract scope set", async () => {
    const value = fixture(["users.read"]);
    let calls = 0;
    try {
      const execution = await executeProviderOperation(
        value.manifest,
        providerRecipe(value.manifest, "posts.read"),
        { post_ids: ["123"] },
        value.auth,
        { fetch: () => { calls += 1; return Promise.resolve(new Response("{}")); } },
      );
      expect(calls).toBe(0);
      expect(execution).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      expect(execution.error).toContain("lacks one complete required x scope set");
      expect(JSON.stringify(execution)).not.toContain(value.token);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("requires OAuth validity for the remaining total budget plus skew", async () => {
    const value = fixture(["tweet.read", "users.read"]);
    const recipe = providerRecipe(value.manifest, "posts.read");
    const now = new Date("2026-01-01T00:00:00.000Z");
    let calls = 0;
    const fetch = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(new Response(JSON.stringify({
        data: [{ id: "123", text: "hello" }],
        includes: {},
      }), { status: 200 }));
    };
    try {
      updateTokenExpiry(
        value.root,
        new Date(now.getTime() + recipe.timeoutMs + 30_000).toISOString(),
      );
      const rejected = await executeProviderOperation(
        value.manifest,
        recipe,
        { post_ids: ["123"] },
        value.auth,
        {
          now,
          deadlineClock: new FakeMonotonicClock(),
          fetch,
        },
      );
      expect(rejected.status).toBe("failed");
      expect(rejected.error).toContain(`required ${recipe.timeoutMs + 30_000}ms budget`);
      expect(calls).toBe(0);

      updateTokenExpiry(
        value.root,
        new Date(now.getTime() + recipe.timeoutMs + 30_001).toISOString(),
      );
      const accepted = await executeProviderOperation(
        value.manifest,
        recipe,
        { post_ids: ["123"] },
        value.auth,
        {
          now,
          deadlineClock: new FakeMonotonicClock(),
          fetch,
        },
      );
      expect(accepted.status).toBe("succeeded");
      expect(calls).toBe(1);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("does not reset the total budget after preflight or dispatch after expiry", async () => {
    const value = fixture(["bookmark.write", "tweet.read", "users.read"]);
    const recipe = providerRecipe(value.manifest, "content.save");
    const clock = new FakeMonotonicClock();
    let calls = 0;
    let beforeDispatch = 0;
    try {
      const execution = await executeProviderOperation(
        value.manifest,
        recipe,
        { post_id: "777", enabled: true },
        value.auth,
        {
          deadlineClock: clock,
          fetch: (input) => {
            calls += 1;
            expect(requestUrl(input).pathname).toBe("/2/users/me");
            clock.advance(recipe.timeoutMs);
            return Promise.resolve(new Response('{"data":{"id":"12345"}}', { status: 200 }));
          },
          beforeDispatch: () => {
            beforeDispatch += 1;
            return Promise.resolve();
          },
        },
      );

      expect(execution.status).toBe("failed");
      expect(execution.error).toContain("timed out");
      expect(execution.dispatch).toEqual({ planned: 1, started: 0, verified: 0 });
      expect(calls).toBe(1);
      expect(beforeDispatch).toBe(0);
      expect(clock.pendingTimers()).toBe(0);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("releases a provider runtime hook that ignores the total deadline", async () => {
    const value = fixture(["tweet.read", "users.read"]);
    const recipe = providerRecipe(value.manifest, "posts.read");
    const clock = new FakeMonotonicClock();
    let hookSignal: AbortSignal | undefined;
    try {
      const executionPromise = executeProviderOperation(
        value.manifest,
        recipe,
        { post_ids: ["123"] },
        value.auth,
        {
          deadlineClock: clock,
          registry: withProviderExecute((context) => {
            hookSignal = context.signal;
            return new Promise<void>(() => undefined);
          }),
        },
      );

      expect(hookSignal?.aborted).toBeFalse();
      clock.advance(recipe.timeoutMs);
      const execution = await executionPromise;

      expect(execution).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      expect(execution.error).toContain("timed out");
      expect(hookSignal?.aborted).toBeTrue();
      expect(clock.pendingTimers()).toBe(0);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("releases a provider runtime hook that ignores caller abort", async () => {
    const value = fixture(["tweet.read", "users.read"]);
    const caller = new AbortController();
    const clock = new FakeMonotonicClock();
    let hookSignal: AbortSignal | undefined;
    try {
      const executionPromise = executeProviderOperation(
        value.manifest,
        providerRecipe(value.manifest, "posts.read"),
        { post_ids: ["123"] },
        value.auth,
        {
          deadlineClock: clock,
          signal: caller.signal,
          registry: withProviderExecute((context) => {
            hookSignal = context.signal;
            return new Promise<void>(() => undefined);
          }),
        },
      );

      expect(hookSignal).not.toBe(caller.signal);
      expect(hookSignal?.aborted).toBeFalse();
      caller.abort("private cancellation reason");
      const execution = await executionPromise;

      expect(execution).toMatchObject({
        status: "failed",
        dispatchStarted: false,
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
      expect(execution.error).toContain("was cancelled");
      expect(execution.error).not.toContain("private cancellation reason");
      expect(hookSignal?.aborted).toBeTrue();
      expect(clock.pendingTimers()).toBe(0);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("rejects a late dispatch verification after the provider hook times out", async () => {
    const value = fixture(["bookmark.write", "tweet.read", "users.read"]);
    const recipe = providerRecipe(value.manifest, "content.save");
    const clock = new FakeMonotonicClock();
    let exposeVerify: ((verify: () => Promise<void>) => void) | undefined;
    const capturedVerify = new Promise<() => Promise<void>>((resolve) => {
      exposeVerify = resolve;
    });
    let afterDispatch = 0;
    try {
      const executionPromise = executeProviderOperation(
        value.manifest,
        recipe,
        { post_id: "777", enabled: true },
        value.auth,
        {
          deadlineClock: clock,
          registry: withProviderExecute(async (context) => {
            const boundary = await context.beginDispatch();
            exposeVerify?.(boundary.verify);
            return new Promise<void>(() => undefined);
          }),
          afterDispatchVerified: () => {
            afterDispatch += 1;
            return Promise.resolve();
          },
        },
      );
      const verify = await capturedVerify;

      clock.advance(recipe.timeoutMs);
      const execution = await executionPromise;

      expect(execution).toMatchObject({
        status: "indeterminate",
        dispatchStarted: true,
        dispatch: { planned: 1, started: 1, verified: 0 },
      });
      expect(execution.error).toContain("timed out");
      expect(await (async () => {
        try {
          await verify();
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        throw new Error("late provider verification unexpectedly succeeded");
      })()).toContain("timed out");
      expect(afterDispatch).toBe(0);
      expect(clock.pendingTimers()).toBe(0);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("honors caller abort after durable dispatch marking without issuing the write", async () => {
    const value = fixture(["bookmark.write", "tweet.read", "users.read"]);
    const caller = new AbortController();
    let calls = 0;
    let afterDispatch = 0;
    try {
      const execution = await executeProviderOperation(
        value.manifest,
        providerRecipe(value.manifest, "content.save"),
        { post_id: "777", enabled: true },
        value.auth,
        {
          signal: caller.signal,
          fetch: (input) => {
            calls += 1;
            expect(requestUrl(input).pathname).toBe("/2/users/me");
            return Promise.resolve(new Response('{"data":{"id":"12345"}}', { status: 200 }));
          },
          beforeDispatch: () => {
            caller.abort("private cancellation reason");
            return Promise.resolve();
          },
          afterDispatchVerified: () => {
            afterDispatch += 1;
            return Promise.resolve();
          },
        },
      );

      expect(execution.status).toBe("indeterminate");
      expect(execution.error).toContain("was cancelled");
      expect(execution.error).not.toContain("private cancellation reason");
      expect(execution.dispatch).toEqual({ planned: 1, started: 1, verified: 0 });
      expect(calls).toBe(1);
      expect(afterDispatch).toBe(0);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});
