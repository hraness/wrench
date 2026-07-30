import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAuth } from "./auth";
import {
  loadOAuthToken,
  ProviderHttpClient,
  requireOAuthScopes,
  type OAuthTokenAuth,
} from "./provider-http";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "./operation-deadline";

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
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

function fixture(provider: "linkedin" | "x" = "x"): {
  readonly root: string;
  readonly path: string;
  readonly auth: OAuthTokenAuth;
} {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "wrench-provider-token-test-"));
  chmodSync(root, 0o700);
  const path = join(root, "token.json");
  const scopes = provider === "x" ? ["tweet.read", "users.read"] : ["r_member_social"];
  const subject = provider === "x" ? "12345" : "urn:li:person:member";
  const auth = createAuth("official", {
    oauthProvider: provider,
    tokenFile: path,
    scopes,
    subject,
  });
  if (auth.kind !== "oauth-token-file") throw new Error("expected an OAuth locator");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    provider,
    subject,
    scopes,
    accessToken: "private-access-token-value",
    expiresAt: "2027-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  return { root, path, auth };
}

function writeTokenExpiry(path: string, expiresAt: string | null): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...value, expiresAt }), { mode: 0o600 });
}

function instrumentedResponse(
  chunks: readonly unknown[],
  options: {
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): {
  readonly response: Response;
  readonly cancellations: () => number;
  readonly pulls: () => number;
} {
  let cancellations = 0;
  let pulls = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk as Uint8Array);
    },
    cancel() {
      cancellations += 1;
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(stream, {
      status: options.status ?? 200,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    }),
    cancellations: () => cancellations,
    pulls: () => pulls,
  };
}

function expectResponseBodyUnlocked(response: Response): void {
  const reader = response.body?.getReader();
  reader?.releaseLock();
}

function gatedCancellationResponse(): {
  readonly response: Response;
  readonly cancelStarted: Promise<void>;
  readonly finishCancellation: () => void;
  readonly cancellations: () => number;
} {
  let cancellations = 0;
  let notifyCancelStarted: (() => void) | undefined;
  let finishCancellation: (() => void) | undefined;
  const cancelStarted = new Promise<void>((resolve) => {
    notifyCancelStarted = resolve;
  });
  const cancellation = new Promise<void>((resolve) => {
    finishCancellation = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations += 1;
      notifyCancelStarted?.();
      return cancellation;
    },
  }, { highWaterMark: 0 });
  return {
    response: new Response(stream),
    cancelStarted,
    finishCancellation: () => {
      finishCancellation?.();
    },
    cancellations: () => cancellations,
  };
}

describe("private OAuth token documents", () => {
  test.skipIf(process.platform !== "darwin")("accepts the root-owned macOS /var compatibility alias", () => {
    const root = mkdtempSync(join(tmpdir(), "wrench-provider-var-alias-test-"));
    chmodSync(root, 0o700);
    const path = join(root, "token.json");
    const auth = createAuth("mac-alias", {
      oauthProvider: "x",
      tokenFile: path,
      scopes: ["tweet.read", "users.read"],
      subject: "12345",
    });
    if (auth.kind !== "oauth-token-file") throw new Error("expected an OAuth locator");
    try {
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        provider: "x",
        subject: "12345",
        scopes: ["tweet.read", "users.read"],
        accessToken: "private-access-token-value",
        expiresAt: null,
      }), { mode: 0o600 });
      expect(loadOAuthToken(auth)).toMatchObject({ accessToken: "private-access-token-value" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads only a canonical, locator-bound, unexpired token document", () => {
    const value = fixture();
    try {
      expect(loadOAuthToken(value.auth, new Date("2026-01-01T00:00:00.000Z"))).toEqual({
        accessToken: "private-access-token-value",
        expiresAt: "2027-01-01T00:00:00.000Z",
      });

      const parsed = JSON.parse(readFileSync(value.path, "utf8")) as Record<string, unknown>;
      writeFileSync(value.path, JSON.stringify({ ...parsed, refreshToken: "must-not-be-accepted" }), { mode: 0o600 });
      expect(() => loadOAuthToken(value.auth, new Date("2026-01-01T00:00:00.000Z")))
        .toThrow("unsupported fields");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("rejects loose permissions and every symlinked path component", () => {
    const value = fixture();
    const parent = join(value.root, "private");
    const parentLink = join(value.root, "private-link");
    mkdirSync(parent, { mode: 0o700 });
    const nestedToken = join(parent, "token.json");
    writeFileSync(nestedToken, readFileSync(value.path), { mode: 0o600 });
    symlinkSync(parent, parentLink);
    const linkedAuth = createAuth("linked", {
      oauthProvider: "x",
      tokenFile: join(parentLink, "token.json"),
      scopes: ["tweet.read", "users.read"],
      subject: "12345",
    });
    if (linkedAuth.kind !== "oauth-token-file") throw new Error("expected an OAuth locator");
    try {
      chmodSync(value.path, 0o644);
      expect(() => loadOAuthToken(value.auth)).toThrow("could not load private x OAuth token document");
      expect(() => loadOAuthToken(linkedAuth)).toThrow("could not load private x OAuth token document");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("rejects realm, scope, and expiry mismatches without echoing token contents", () => {
    const value = fixture();
    try {
      const variants: readonly Record<string, unknown>[] = [
        {
          schemaVersion: 1,
          provider: "linkedin",
          subject: "12345",
          scopes: ["tweet.read", "users.read"],
          accessToken: "never-echo-this-token",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
        {
          schemaVersion: 1,
          provider: "x",
          subject: "wrong",
          scopes: ["tweet.read", "users.read"],
          accessToken: "never-echo-this-token",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
        {
          schemaVersion: 1,
          provider: "x",
          subject: "12345",
          scopes: ["users.read", "tweet.read"],
          accessToken: "never-echo-this-token",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
        {
          schemaVersion: 1,
          provider: "x",
          subject: "12345",
          scopes: ["tweet.read", "users.read"],
          accessToken: "never-echo-this-token",
          expiresAt: "2026-01-01T00:00:20.000Z",
        },
      ];
      for (const document of variants) {
        writeFileSync(value.path, JSON.stringify(document), { mode: 0o600 });
        let message = "";
        try {
          loadOAuthToken(value.auth, new Date("2026-01-01T00:00:00.000Z"));
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toContain("never-echo-this-token");
        expect(message).not.toContain(value.path);
      }
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("enforces default and caller-supplied minimum validity at the exact boundary", () => {
    const value = fixture();
    const now = new Date("2026-01-01T00:00:00.000Z");
    try {
      writeTokenExpiry(value.path, "2026-01-01T00:00:30.000Z");
      expect(() => loadOAuthToken(value.auth, now)).toThrow("expires within 30 seconds");

      writeTokenExpiry(value.path, "2026-01-01T00:00:30.001Z");
      expect(() => loadOAuthToken(value.auth, now)).not.toThrow();

      writeTokenExpiry(value.path, "2026-01-01T00:02:00.000Z");
      expect(() => loadOAuthToken(value.auth, now, 120_000))
        .toThrow("required 120000ms budget");

      writeTokenExpiry(value.path, "2026-01-01T00:02:00.001Z");
      expect(() => loadOAuthToken(value.auth, now, 120_000)).not.toThrow();

      writeTokenExpiry(value.path, null);
      expect(() => loadOAuthToken(value.auth, now, 120_000)).not.toThrow();
      expect(() => loadOAuthToken(value.auth, now, -1)).toThrow("non-negative safe integer");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });

  test("requires one complete alternative scope set plus actor-specific scopes", () => {
    const value = fixture("linkedin");
    try {
      expect(() => requireOAuthScopes(value.auth, [["r_member_social"], ["r_organization_social"]]))
        .not.toThrow();
      expect(() => requireOAuthScopes(value.auth, [["w_member_social"], ["w_organization_social"]]))
        .toThrow("one complete required linkedin scope set");
      expect(() => requireOAuthScopes(value.auth, [["r_member_social"]], ["r_organization_social_feed"]))
        .toThrow("r_organization_social_feed");
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  });
});

describe("bounded official-provider HTTP", () => {
  test("pins HTTPS hosts and the default port, disables redirects, and parses a bounded JSON response", async () => {
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    const client = new ProviderHttpClient((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }, 30_000, 1_024);

    expect(await rejectionMessage(
      client.request("http://api.x.com/2/users/me", { method: "GET" }, [200], ["api.x.com"]),
    )).toContain("unapproved origin");
    expect(await rejectionMessage(
      client.request("https://api.x.com.evil.example/2/users/me", { method: "GET" }, [200], ["api.x.com"]),
    )).toContain("unapproved origin");
    expect(await rejectionMessage(
      client.request("https://child.api.x.com/2/users/me", { method: "GET" }, [200], ["api.x.com"]),
    )).toContain("unapproved origin");
    const portError = await rejectionMessage(
      client.request(
        "https://api.x.com:8443/2/users/me?access_token=never-echo-this-token",
        { method: "GET" },
        [200],
        ["api.x.com"],
      ),
    );
    expect(portError).toContain("unapproved origin");
    expect(portError).not.toContain("access_token");
    expect(portError).not.toContain("never-echo-this-token");
    expect(await client.request("https://api.x.com:443/2/users/me", { method: "GET" }, [200], ["api.x.com"]))
      .toMatchObject({ status: 200, body: { ok: true } });
    expect(await client.request("https://api.x.com/2/users/me", { method: "GET" }, [200], ["api.x.com"]))
      .toMatchObject({ status: 200, body: { ok: true } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.x.com/2/users/me");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("bounds response bodies and never includes an error response body in diagnostics", async () => {
    const huge = new ProviderHttpClient(() => Promise.resolve(new Response("x".repeat(1_025), { status: 200 })), 30_000, 1_024);
    expect(await rejectionMessage(
      huge.request("https://api.x.com/2/tweets", { method: "GET" }, [200], ["api.x.com"]),
    )).toContain("exceeds 1024 bytes");

    const privateBody = "private-provider-error-body";
    const failed = new ProviderHttpClient(() => Promise.resolve(new Response(privateBody, { status: 403 })), 30_000, 1_024);
    const message = await rejectionMessage(
      failed.request("https://api.x.com/2/tweets?secret=query-value", { method: "POST" }, [200], ["api.x.com"]),
    );
    expect(message).toContain("HTTP 403");
    expect(message).toContain("/2/tweets?…");
    expect(message).not.toContain(privateBody);
    expect(message).not.toContain("query-value");
  });

  test("cancels rejected statuses and oversized declared bodies before reading", async () => {
    const rejected = instrumentedResponse(
      [new TextEncoder().encode("private-provider-error-body")],
      { status: 403 },
    );
    const rejectedClient = new ProviderHttpClient(
      () => Promise.resolve(rejected.response),
      30_000,
      1_024,
    );
    expect(await rejectionMessage(
      rejectedClient.request("https://api.x.com/2/tweets", { method: "GET" }, [200], ["api.x.com"]),
    )).toContain("HTTP 403");
    expect(rejected.pulls()).toBe(0);
    expect(rejected.cancellations()).toBe(1);
    expect(() => expectResponseBodyUnlocked(rejected.response)).not.toThrow();

    const declaredOversized = instrumentedResponse(
      [new TextEncoder().encode('{"ok":true}')],
      { headers: { "content-length": "1025" } },
    );
    const declaredOversizedClient = new ProviderHttpClient(
      () => Promise.resolve(declaredOversized.response),
      30_000,
      1_024,
    );
    expect(await rejectionMessage(
      declaredOversizedClient.request("https://api.x.com/2/tweets", { method: "GET" }, [200], ["api.x.com"]),
    )).toContain("exceeds 1024 bytes");
    expect(declaredOversized.pulls()).toBe(0);
    expect(declaredOversized.cancellations()).toBe(1);
    expect(() => expectResponseBodyUnlocked(declaredOversized.response)).not.toThrow();
  });

  test("preserves a rejected-status diagnostic when body cancellation rejects", async () => {
    let cancellations = 0;
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        pulls += 1;
      },
      cancel() {
        cancellations += 1;
        return Promise.reject(new Error("private transport cancellation detail"));
      },
    }, { highWaterMark: 0 }), { status: 403 });
    const client = new ProviderHttpClient(
      () => Promise.resolve(response),
      30_000,
      1_024,
    );
    const message = await rejectionMessage(client.request(
      "https://api.x.com/2/tweets",
      { method: "POST" },
      [200],
      ["api.x.com"],
    ));
    expect(message).toContain("official provider returned HTTP 403");
    expect(message).toContain("response cleanup could not be verified");
    expect(message).not.toContain("private transport cancellation detail");
    expect(pulls).toBe(0);
    expect(cancellations).toBe(1);
    expect(() => expectResponseBodyUnlocked(response)).not.toThrow();
  });

  test("bounds stalled declared-oversize cancellation and preserves the size diagnostic", async () => {
    let cancellations = 0;
    let pulls = 0;
    let finishCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        pulls += 1;
      },
      cancel() {
        cancellations += 1;
        return cancellation;
      },
    }, { highWaterMark: 0 }), {
      headers: { "content-length": "1025" },
    });
    const client = new ProviderHttpClient(
      () => Promise.resolve(response),
      30_000,
      1_024,
    );
    const startedAt = performance.now();
    const message = await rejectionMessage(client.request(
      "https://api.x.com/2/tweets",
      { method: "GET" },
      [200],
      ["api.x.com"],
    ));
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(message).toContain("provider response exceeds 1024 bytes");
    expect(message).toContain("response cleanup could not be verified");
    expect(pulls).toBe(0);
    expect(cancellations).toBe(1);
    expect(() => expectResponseBodyUnlocked(response)).not.toThrow();
    finishCancellation?.();
  }, 3_000);

  test("cancels malformed and overflowing streams exactly once and releases their readers", async () => {
    const cases = [
      {
        response: instrumentedResponse(["not-a-byte-chunk"]),
        expected: "invalid body chunk",
      },
      {
        response: instrumentedResponse([new Uint8Array(1_025)]),
        expected: "exceeds 1024 bytes",
      },
    ] as const;
    for (const value of cases) {
      const client = new ProviderHttpClient(
        () => Promise.resolve(value.response.response),
        30_000,
        1_024,
      );
      expect(await rejectionMessage(
        client.request("https://api.x.com/2/tweets", { method: "GET" }, [200], ["api.x.com"]),
      )).toContain(value.expected);
      expect(value.response.cancellations()).toBe(1);
      expect(() => expectResponseBodyUnlocked(value.response.response)).not.toThrow();
    }
  });

  test("cancels and joins a pending body read after the operation deadline", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(100, { clock });
    let notifyPullStarted: (() => void) | undefined;
    let notifyCancelStarted: (() => void) | undefined;
    let finishCancellation: (() => void) | undefined;
    let cancellations = 0;
    const pullStarted = new Promise<void>((resolve) => {
      notifyPullStarted = resolve;
    });
    const cancelStarted = new Promise<void>((resolve) => {
      notifyCancelStarted = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        notifyPullStarted?.();
      },
      cancel() {
        cancellations += 1;
        notifyCancelStarted?.();
        return cancellation;
      },
    }, { highWaterMark: 0 }));
    const client = new ProviderHttpClient(
      () => Promise.resolve(response),
      deadline,
      1_024,
    );
    const request = client.request(
      "https://api.x.com/2/tweets",
      { method: "GET" },
      [200],
      ["api.x.com"],
    );
    await pullStarted;
    clock.advance(100);

    const first = await Promise.race([
      cancelStarted.then(() => "cancel-started" as const),
      request.then(
        () => "request-settled" as const,
        () => "request-settled" as const,
      ),
    ]);
    expect(first).toBe("cancel-started");
    expect(cancellations).toBe(1);

    let requestSettled = false;
    void request.then(
      () => {
        requestSettled = true;
      },
      () => {
        requestSettled = true;
      },
    );
    await Promise.resolve();
    expect(requestSettled).toBe(false);

    finishCancellation?.();
    expect(await rejectionMessage(request)).toContain("official provider operation timed out");
    expect(cancellations).toBe(1);
    expect(() => expectResponseBodyUnlocked(response)).not.toThrow();
  });

  test("retains and joins a response fulfilled at the deadline post-work check", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(100, { clock });
    const late = gatedCancellationResponse();
    const client = new ProviderHttpClient(
      () => {
        clock.advance(100);
        return Promise.resolve(late.response);
      },
      deadline,
      1_024,
    );
    const request = client.request(
      "https://api.x.com/2/tweets",
      { method: "GET" },
      [200],
      ["api.x.com"],
    );
    const first = await Promise.race([
      late.cancelStarted.then(() => "cancel-started" as const),
      request.then(
        () => "request-settled" as const,
        () => "request-settled" as const,
      ),
    ]);
    expect(first).toBe("cancel-started");
    expect(late.cancellations()).toBe(1);

    let requestSettled = false;
    void request.then(
      () => {
        requestSettled = true;
      },
      () => {
        requestSettled = true;
      },
    );
    await Promise.resolve();
    expect(requestSettled).toBe(false);

    late.finishCancellation();
    expect(await rejectionMessage(request)).toContain("official provider operation timed out");
    expect(late.cancellations()).toBe(1);
    expect(() => expectResponseBodyUnlocked(late.response)).not.toThrow();
  });

  test("cancels a response that fulfills after the deadline race before returning", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(100, { clock });
    const late = gatedCancellationResponse();
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchResponse = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const client = new ProviderHttpClient(
      () => fetchResponse,
      deadline,
      1_024,
    );
    const request = client.request(
      "https://api.x.com/2/tweets",
      { method: "GET" },
      [200],
      ["api.x.com"],
    );
    await Promise.resolve();
    clock.advance(100);
    resolveFetch?.(late.response);

    const first = await Promise.race([
      late.cancelStarted.then(() => "cancel-started" as const),
      request.then(
        () => "request-settled" as const,
        () => "request-settled" as const,
      ),
    ]);
    expect(first).toBe("cancel-started");
    expect(late.cancellations()).toBe(1);

    late.finishCancellation();
    expect(await rejectionMessage(request)).toContain("official provider operation timed out");
    expect(() => expectResponseBodyUnlocked(late.response)).not.toThrow();
  });

  test("fails closed when a late response body cannot be canceled", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(100, { clock });
    let cancellations = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
        return Promise.reject(new Error("transport refused cancellation"));
      },
    }, { highWaterMark: 0 }));
    const client = new ProviderHttpClient(
      () => {
        clock.advance(100);
        return Promise.resolve(response);
      },
      deadline,
      1_024,
    );
    const message = await rejectionMessage(client.request(
      "https://api.x.com/2/tweets",
      { method: "GET" },
      [200],
      ["api.x.com"],
    ));
    expect(message).toContain("official provider operation timed out");
    expect(message).toContain("response cleanup could not be verified");
    expect(message).not.toContain("transport refused cancellation");
    expect(cancellations).toBe(1);
    expect(() => expectResponseBodyUnlocked(response)).not.toThrow();
  });
});
