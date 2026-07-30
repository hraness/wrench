import { describe, expect, test } from "bun:test";

import type { ResolvedNetworkAddress } from "@hraness/kb/clip/network";
import {
  createPinnedHttpsFetchScope,
  pinnedHttpsFetch,
  type PinnedHttpsDependencies,
  type PinnedHttpsRequest,
  type PinnedHttpsResponse,
} from "./pinned-https";

const address = { address: "203.0.113.50", family: 4 } as const satisfies ResolvedNetworkAddress;

function dependencies(
  handler: (request: PinnedHttpsRequest) => PinnedHttpsResponse | Promise<PinnedHttpsResponse>,
): PinnedHttpsDependencies & { readonly resolved: URL[] } {
  const resolved: URL[] = [];
  return {
    resolved,
    resolveTarget: (url, options) => {
      resolved.push(new URL(url));
      expect(options).toEqual({ allowPrivateNetwork: false, timeoutMs: 30_000 });
      return Promise.resolve([address]);
    },
    request: async (request) => await handler(request),
  };
}

function response(
  status = 200,
  body: AsyncIterable<unknown> | null = null,
  cancel = () => undefined,
): PinnedHttpsResponse {
  return { status, headers: new Headers({ "content-type": "application/json" }), body, cancel };
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected request to reject");
}

describe("DNS-pinned authenticated HTTPS", () => {
  test("pins one validated address and preserves the exact method, headers, path, and owned body", async () => {
    const requests: PinnedHttpsRequest[] = [];
    const deps = dependencies((candidate) => {
      requests.push(candidate);
      return response(201, (async function* () {
        await Promise.resolve();
        yield new TextEncoder().encode('{"ok":true}');
      })());
    });
    const controller = new AbortController();
    const result = await pinnedHttpsFetch(
      new URL("https://example.com/api/items?view=one"),
      {
        method: "POST",
        headers: { accept: "application/json", "x-test": "fixed" },
        body: '{"body":"hello"}',
        redirect: "error",
        signal: controller.signal,
      },
      30_000,
      deps,
    );
    expect(deps.resolved.map((url) => url.href)).toEqual(["https://example.com/api/items?view=one"]);
    const request = requests[0];
    expect(request?.address).toEqual(address);
    expect(request?.method).toBe("POST");
    expect(request?.url.href).toBe("https://example.com/api/items?view=one");
    expect(request?.headers.get("x-test")).toBe("fixed");
    expect(new TextDecoder().decode(request?.body ?? new Uint8Array())).toBe('{"body":"hello"}');
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ ok: true });
  });

  test("never retries another resolved address after an ambiguous transport failure", async () => {
    let calls = 0;
    const requestedAddresses: ResolvedNetworkAddress[] = [];
    const deps: Partial<PinnedHttpsDependencies> = {
      resolveTarget: () => Promise.resolve([
        address,
        { address: "203.0.113.51", family: 4 },
      ]),
      request: (request) => {
        calls += 1;
        requestedAddresses.push(request.address);
        return Promise.reject(new Error("ambiguous failure"));
      },
    };
    const failure = await rejectedError(pinnedHttpsFetch(
      new URL("https://example.com/mutate"),
      { method: "POST", redirect: "error", signal: new AbortController().signal },
      30_000,
      deps,
    ));
    expect(failure.message).toContain("ambiguous failure");
    expect(calls).toBe(1);
    expect(requestedAddresses).toEqual([address]);
  });

  test("rejects unsafe URL, redirect, signal, timeout, body, and status shapes before exposure", () => {
    const deps = dependencies(() => response(200));
    const signal = new AbortController().signal;
    expect(pinnedHttpsFetch(new URL("http://example.com/"), { redirect: "error", signal }, 30_000, deps)).rejects.toThrow("HTTPS");
    expect(pinnedHttpsFetch(new URL("https://user:pass@example.com/"), { redirect: "error", signal }, 30_000, deps)).rejects.toThrow("credential-free");
    expect(pinnedHttpsFetch(new URL("https://example.com/#secret"), { redirect: "error", signal }, 30_000, deps)).rejects.toThrow("fragment");
    expect(pinnedHttpsFetch(new URL("https://example.com/"), { redirect: "follow", signal }, 30_000, deps)).rejects.toThrow("redirects");
    expect(pinnedHttpsFetch(new URL("https://example.com/"), { redirect: "error" }, 30_000, deps)).rejects.toThrow("abort signal");
    expect(pinnedHttpsFetch(new URL("https://example.com/"), { redirect: "error", signal }, 999, deps)).rejects.toThrow("timeout");
    expect(pinnedHttpsFetch(
      new URL("https://example.com/"),
      { method: "POST", redirect: "error", signal, body: new URLSearchParams({ unsafe: "shape" }) },
      30_000,
      deps,
    )).rejects.toThrow("owned string or byte array");

    let cancelled = 0;
    const badStatus = dependencies(() => response(199, null, () => { cancelled += 1; }));
    expect(pinnedHttpsFetch(new URL("https://example.com/"), { redirect: "error", signal }, 30_000, badStatus)).rejects.toThrow("status");
    expect(cancelled).toBe(1);
  });

  test("cancels a malformed or caller-cancelled response stream", async () => {
    let cancelled = 0;
    const malformed = dependencies(() => response(200, (async function* () {
      await Promise.resolve();
      yield "not bytes";
    })(), () => { cancelled += 1; }));
    const first = await pinnedHttpsFetch(
      new URL("https://example.com/"),
      { redirect: "error", signal: new AbortController().signal },
      30_000,
      malformed,
    );
    expect(first.arrayBuffer()).rejects.toThrow("non-byte");
    expect(cancelled).toBe(1);

    const never: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<unknown>>(() => undefined),
      }),
    };
    const cancellable = dependencies(() => response(200, never, () => { cancelled += 1; }));
    const second = await pinnedHttpsFetch(
      new URL("https://example.com/"),
      { redirect: "error", signal: new AbortController().signal },
      30_000,
      cancellable,
    );
    void second.body?.cancel();
    expect(cancelled).toBe(2);
  });

  test("one exact-origin invocation scope reuses one pool while resolving and pinning every request", async () => {
    let createdPools = 0;
    let closedPools = 0;
    let resolutionCount = 0;
    const requests: PinnedHttpsRequest[] = [];
    const scope = createPinnedHttpsFetchScope("https://example.com", {
      resolveTarget: (url, options) => {
        resolutionCount += 1;
        expect(url.origin).toBe("https://example.com");
        expect(options).toEqual({
          allowPrivateNetwork: false,
          timeoutMs: 30_000,
        });
        return Promise.resolve([address]);
      },
      createConnectionPool: () => {
        createdPools += 1;
        return {
          request: (request) => {
            requests.push(request);
            return Promise.resolve(response(200, (async function* () {
              await Promise.resolve();
              yield new TextEncoder().encode(request.url.pathname);
            })()));
          },
          close: () => {
            closedPools += 1;
          },
        };
      },
    });
    const init = (authorization: string): RequestInit => ({
      headers: { authorization },
      redirect: "error",
      signal: new AbortController().signal,
    });

    const first = await scope.fetch(
      new URL("https://example.com/first"),
      init("Bearer first"),
      30_000,
    );
    const second = await scope.fetch(
      new URL("https://example.com/second"),
      init("Bearer second"),
      30_000,
    );

    expect(await first.text()).toBe("/first");
    expect(await second.text()).toBe("/second");
    expect(createdPools).toBe(1);
    expect(resolutionCount).toBe(2);
    expect(requests.map((request) => ({
      address: request.address,
      authorization: request.headers.get("authorization"),
      path: request.url.pathname,
    }))).toEqual([
      {
        address,
        authorization: "Bearer first",
        path: "/first",
      },
      {
        address,
        authorization: "Bearer second",
        path: "/second",
      },
    ]);

    scope.close();
    scope.close();
    expect(closedPools).toBe(1);
    const closedFailure = await rejectedError(scope.fetch(
      new URL("https://example.com/after-close"),
      init("Bearer closed"),
      30_000,
    ));
    expect(closedFailure.message).toContain("scope is closed");
  });

  test("exact-origin scopes reject cross-origin requests before resolution or authentication", async () => {
    let resolved = 0;
    let requested = 0;
    const scope = createPinnedHttpsFetchScope("https://example.com", {
      resolveTarget: () => {
        resolved += 1;
        return Promise.resolve([address]);
      },
      createConnectionPool: () => ({
        request: () => {
          requested += 1;
          return Promise.resolve(response());
        },
        close: () => undefined,
      }),
    });
    try {
      const failure = await rejectedError(scope.fetch(
        new URL("https://other.example/private"),
        {
          headers: { authorization: "Bearer must-not-leak" },
          redirect: "error",
          signal: new AbortController().signal,
        },
        30_000,
      ));
      expect(failure.message).toContain("exact-origin");
      expect(resolved).toBe(0);
      expect(requested).toBe(0);
    } finally {
      scope.close();
    }
  });

  test("separate invocation scopes never share a connection pool", async () => {
    let createdPools = 0;
    let closedPools = 0;
    const createConnectionPool = () => {
      createdPools += 1;
      return {
        request: () => Promise.resolve(response()),
        close: () => {
          closedPools += 1;
        },
      };
    };
    const first = createPinnedHttpsFetchScope("https://example.com", {
      resolveTarget: () => Promise.resolve([address]),
      createConnectionPool,
    });
    const second = createPinnedHttpsFetchScope("https://example.com", {
      resolveTarget: () => Promise.resolve([address]),
      createConnectionPool,
    });
    try {
      const init = {
        redirect: "error",
        signal: new AbortController().signal,
      } as const;
      await first.fetch(new URL("https://example.com/one"), init, 30_000);
      await second.fetch(new URL("https://example.com/two"), init, 30_000);
      expect(createdPools).toBe(2);
    } finally {
      first.close();
      second.close();
    }
    expect(closedPools).toBe(2);
  });

  test("rejects a non-canonical scope origin before creating a pool", () => {
    let createdPools = 0;
    const createConnectionPool = () => {
      createdPools += 1;
      return {
        request: () => Promise.resolve(response()),
        close: () => undefined,
      };
    };
    for (const origin of [
      "http://example.com",
      "https://user@example.com",
      "https://example.com/",
      "https://example.com/path",
      "https://example.com:443",
    ]) {
      expect(() => createPinnedHttpsFetchScope(origin, {
        createConnectionPool,
      })).toThrow("exact HTTPS origin");
    }
    expect(createdPools).toBe(0);
  });
});
