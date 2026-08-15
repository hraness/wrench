import { describe, expect, test } from "bun:test";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "./auth";
import {
  OperationDeadline,
  type OperationDeadlineClock,
} from "./operation-deadline";
import {
  createWebSessionClient,
  fetchPublicWebAsset,
  type WebSessionCookieRotationState,
  type WebSessionNetworkDependencies,
} from "./web-session-client";

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
        .sort((left, right) =>
          left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.#scheduled.delete(due[0]);
      due[1].callback();
    }
  }

  pendingTimers(): number {
    return this.#scheduled.size;
  }
}

const auth = {
  schemaVersion: 1,
  id: "x-test",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
} as const satisfies WrenchAuth;

const cookies: readonly StrictCookie[] = [{
  name: "auth_token",
  value: "private-cookie",
  domain: "x.com",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
  expires: 0,
}];

const emptyRotationState = Object.freeze({
  cookies: Object.freeze([]),
  tombstones: Object.freeze([]),
}) satisfies WebSessionCookieRotationState;

const rotationPolicy = Object.freeze({
  allowedNames: Object.freeze(["__cf_bm"]),
  maxCachedCookieAgeSeconds: 24 * 60 * 60,
  tombstoneTtlSeconds: 60 * 60,
});

async function rejectionMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

function stalledDependencies(contentType: string): {
  readonly dependencies: WebSessionNetworkDependencies;
  readonly signal: () => AbortSignal | null;
} {
  let observed: AbortSignal | null = null;
  const acquireCookies: CookieRecordReader = () => Promise.resolve({ cookies, warnings: [] });
  const fetch: WebSessionNetworkDependencies["fetch"] = (_value, init) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) throw new Error("expected abort signal");
    observed = signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(new DOMException("deadline", "AbortError")), { once: true });
      },
    });
    return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": contentType } }));
  };
  return { dependencies: { acquireCookies, fetch }, signal: () => observed };
}

describe("authenticated web-session client deadlines", () => {
  test("shares one total budget across cookie acquisition and multiple requests", async () => {
    const clock = new FakeMonotonicClock();
    const deadline = new OperationDeadline(100, { clock });
    const signals: AbortSignal[] = [];
    let fetches = 0;
    try {
      const client = await createWebSessionClient("https://x.com", auth, {
        timeoutMs: 100,
        operationDeadline: deadline,
        dependencies: {
          acquireCookies: (selection) => {
            expect(selection.timeoutMs).toBe(100);
            clock.advance(30);
            return Promise.resolve({ cookies, warnings: [] });
          },
          fetch: (_input, init) => {
            const signal = init?.signal;
            if (!(signal instanceof AbortSignal)) {
              throw new Error("expected the shared deadline signal");
            }
            signals.push(signal);
            fetches += 1;
            clock.advance(fetches === 1 ? 30 : 40);
            return Promise.resolve(new Response('{"ok":true}', {
              status: 200,
              headers: { "content-type": "application/json" },
            }));
          },
        },
      });
      expect(await client.requestJson({
        url: new URL("https://x.com/i/api/first"),
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: 1_024,
      })).toEqual({ ok: true });
      expect(await rejectionMessage(client.requestJson({
        url: new URL("https://x.com/i/api/second"),
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: 1_024,
      }))).toContain("timed out");
      expect(fetches).toBe(2);
      expect(signals).toEqual([deadline.signal, deadline.signal]);
      expect(deadline.remainingTimeMs()).toBe(0);
      expect(clock.pendingTimers()).toBe(0);
    } finally {
      deadline.dispose();
    }
  });

  test("cover JSON and text response body streaming", async () => {
    for (const mode of ["json", "text"] as const) {
      const stalled = stalledDependencies(mode === "json" ? "application/json" : "text/html");
      const client = await createWebSessionClient("https://x.com", auth, {
        timeoutMs: 20,
        dependencies: stalled.dependencies,
      });
      const action = mode === "json"
        ? client.requestJson({
          url: new URL("https://x.com/i/api/test"),
          method: "GET",
          headers: { accept: "application/json" },
          maxBytes: 1_024,
        })
        : client.requestText({
          url: new URL("https://x.com/home"),
          headers: { accept: "text/html" },
          expectedContentTypes: ["text/html"],
          maxBytes: 1_024,
        });
      expect(await rejectionMessage(action)).toContain("deadline");
      expect(stalled.signal()?.aborted).toBeTrue();
    }
  });

  test("covers public first-party asset body streaming", async () => {
    const stalled = stalledDependencies("application/javascript");
    expect(await rejectionMessage(fetchPublicWebAsset(
      new URL("https://abs.twimg.com/responsive-web/client-web/main.test.js"),
      {
        allowedOrigin: "https://abs.twimg.com",
        contentTypes: ["application/javascript"],
        maxBytes: 1_024,
        timeoutMs: 20,
        dependencies: stalled.dependencies,
      },
    ))).toContain("deadline");
    expect(stalled.signal()?.aborted).toBeTrue();
  });
});

describe("authenticated text API transport", () => {
  test("sends one reviewed POST body and refuses a body on GET", async () => {
    const observed: { method: string | null; body: string }[] = [];
    const client = await createWebSessionClient("https://x.com", auth, {
      timeoutMs: 1_000,
      dependencies: {
        acquireCookies: () => Promise.resolve({ cookies, warnings: [] }),
        fetch: (_value, init) => {
          observed.push({
            method: init?.method ?? null,
            body: typeof init?.body === "string" ? init.body : "",
          });
          return Promise.resolve(new Response("{\"data\":{}}\n{\"path\":[\"feed\"]}\n", {
            status: 200,
            headers: { "content-type": "text/html" },
          }));
        },
      },
    });
    expect(await client.requestText({
      url: new URL("https://x.com/api/graphql/"),
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "reviewed=form",
      expectedContentTypes: ["text/html"],
      maxBytes: 1_024,
    })).toContain("\"data\"");
    expect(observed).toEqual([{ method: "POST", body: "reviewed=form" }]);

    expect(await rejectionMessage(client.requestText({
      url: new URL("https://x.com/api/graphql/"),
      method: "GET",
      body: "must-not-send",
      expectedContentTypes: ["text/html"],
      maxBytes: 1_024,
    }))).toContain("body requires POST");
    expect(observed).toHaveLength(1);
  });
});

describe("reviewed authenticated status transport", () => {
  test("preserves a bounded binary POST body and binds the acquired cookies", async () => {
    const body = new Uint8Array([0, 1, 2, 127, 255]);
    let observedBody: number[] = [];
    let observedCookie = "";
    const client = await createWebSessionClient("https://x.com", auth, {
      timeoutMs: 1_000,
      dependencies: {
        acquireCookies: () => Promise.resolve({ cookies, warnings: [] }),
        fetch: async (_value, init) => {
          observedBody = Array.from(
            new Uint8Array(await new Response(init?.body).arrayBuffer()),
          );
          observedCookie = new Headers(init?.headers).get("cookie") ?? "";
          return new Response(null, { status: 204 });
        },
      },
    });

    expect(await client.requestStatus({
      url: new URL("https://x.com/i/media/upload.json"),
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
      expectedStatuses: [204],
    })).toEqual({ status: 204, location: null });
    expect(observedBody).toEqual(Array.from(body));
    expect(observedCookie).toContain("auth_token=private-cookie");
  });
});

describe("reviewed authenticated response-cookie rotation", () => {
  test("absorbs only an allowlisted exact-origin cookie and reuses it on the next request", async () => {
    const cookieHeaders: string[] = [];
    const saved: WebSessionCookieRotationState[] = [];
    const acquireCookies: CookieRecordReader = () => Promise.resolve({ cookies, warnings: [] });
    let call = 0;
    const fetch: WebSessionNetworkDependencies["fetch"] = (_value, init) => {
      cookieHeaders.push(new Headers(init?.headers).get("cookie") ?? "");
      call += 1;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(call === 1
            ? {
                "set-cookie": "__cf_bm=rotated-private; Max-Age=1800; Path=/; Domain=.x.com; Secure; HttpOnly; SameSite=None; Priority=High",
              }
            : {}),
        },
      }));
    };
    const client = await createWebSessionClient("https://x.com", auth, {
      timeoutMs: 1_000,
      dependencies: { acquireCookies, fetch },
      cookieRotation: {
        ...rotationPolicy,
        cachedState: emptyRotationState,
        save: (next) => {
          saved.push(next);
        },
      },
    });
    for (const path of ["/i/api/first", "/i/api/second"]) {
      await client.requestJson({
        url: new URL(path, "https://x.com"),
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: 1_024,
      });
    }
    expect(cookieHeaders[0]).toContain("auth_token=private-cookie");
    expect(cookieHeaders[0]).not.toContain("__cf_bm");
    expect(cookieHeaders[1]).toContain("__cf_bm=rotated-private");
    expect(saved).toHaveLength(1);
    expect(typeof saved[0]?.cookies[0]?.acceptedAtSeconds).toBe("number");
    expect(saved[0]).toMatchObject({
      cookies: [{
        cookie: {
          name: "__cf_bm",
          domain: "x.com",
          hostOnly: false,
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "None",
        },
      }],
      tombstones: [],
    });
    expect(client.cookies.some((cookie) => cookie.name === "__cf_bm")).toBeTrue();
  });

  test("ignores unreviewed response cookies and rejects drift in an allowlisted cookie", async () => {
    for (const setCookie of [
      "unreviewed=private; Path=/; Secure",
      "__cf_bm=private; Path=/; Secure; SameParty",
    ]) {
      let saved = 0;
      const client = await createWebSessionClient("https://x.com", auth, {
        timeoutMs: 1_000,
        dependencies: {
          acquireCookies: () => Promise.resolve({ cookies, warnings: [] }),
          fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": setCookie,
            },
          })),
        },
        cookieRotation: {
          ...rotationPolicy,
          cachedState: emptyRotationState,
          save: () => {
            saved += 1;
          },
        },
      });
      const action = client.requestJson({
        url: new URL("https://x.com/i/api/test"),
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: 1_024,
      });
      if (setCookie.startsWith("unreviewed=")) {
        expect(await action).toEqual({ ok: true });
        expect(saved).toBe(0);
      } else {
        expect(await rejectionMessage(action)).toContain("unsupported attribute");
        expect(saved).toBe(0);
      }
    }
  });

  test("keeps a persisted reviewed rotation authoritative over a later-expiry source snapshot", async () => {
    const source = [{
      ...cookies[0]!,
      name: "__cf_bm",
      value: "stale-source",
      domain: "x.com",
      hostOnly: false,
      expires: Math.floor(Date.now() / 1_000) + 86_400,
    }];
    let persisted: WebSessionCookieRotationState | null = null;
    const firstClient = await createWebSessionClient("https://x.com", auth, {
      timeoutMs: 1_000,
      dependencies: {
        acquireCookies: () => Promise.resolve({ cookies: source, warnings: [] }),
        fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "__cf_bm=fresh-response; Max-Age=1800; Domain=.x.com; Path=/; Secure; HttpOnly; SameSite=None",
          },
        })),
      },
      cookieRotation: {
        ...rotationPolicy,
        cachedState: emptyRotationState,
        save: (state) => {
          persisted = state;
        },
      },
    });
    await firstClient.requestJson({
      url: new URL("/i/api/first", "https://x.com"),
      method: "GET",
      headers: { accept: "application/json" },
      maxBytes: 1_024,
    });
    if (persisted === null) throw new Error("expected a persisted rotating-cookie cache");

    let nextCookieHeader = "";
    const secondClient = await createWebSessionClient("https://x.com", auth, {
      timeoutMs: 1_000,
      dependencies: {
        acquireCookies: () => Promise.resolve({ cookies: source, warnings: [] }),
        fetch: (_value, init) => {
          nextCookieHeader = new Headers(init?.headers).get("cookie") ?? "";
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        },
      },
      cookieRotation: {
        ...rotationPolicy,
        cachedState: persisted,
        save: () => undefined,
      },
    });
    await secondClient.requestJson({
      url: new URL("/i/api/second", "https://x.com"),
      method: "GET",
      headers: { accept: "application/json" },
      maxBytes: 1_024,
    });
    expect(nextCookieHeader).toContain("__cf_bm=fresh-response");
    expect(nextCookieHeader).not.toContain("__cf_bm=stale-source");
  });

  test("gives positive Max-Age precedence over an expired Expires in either attribute order", async () => {
    for (const attributes of [
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=1800",
      "Max-Age=1800; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ]) {
      let call = 0;
      let secondCookieHeader = "";
      const client = await createWebSessionClient("https://x.com", auth, {
        timeoutMs: 1_000,
        dependencies: {
          acquireCookies: () => Promise.resolve({ cookies, warnings: [] }),
          fetch: (_value, init) => {
            call += 1;
            if (call === 2) secondCookieHeader = new Headers(init?.headers).get("cookie") ?? "";
            return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                ...(call === 1
                  ? {
                      "set-cookie": `__cf_bm=fresh-response; ${attributes}; Domain=.x.com; Path=/; Secure; HttpOnly; SameSite=None`,
                    }
                  : {}),
              },
            }));
          },
        },
        cookieRotation: {
          ...rotationPolicy,
          cachedState: emptyRotationState,
          save: () => undefined,
        },
      });
      for (const path of ["/i/api/first", "/i/api/second"]) {
        await client.requestJson({
          url: new URL(path, "https://x.com"),
          method: "GET",
          headers: { accept: "application/json" },
          maxBytes: 1_024,
        });
      }
      expect(secondCookieHeader).toContain("__cf_bm=fresh-response");
    }
  });

  test("persists a reviewed deletion and suppresses the stale source in a new client", async () => {
    for (const attributes of [
      "Expires=Wed, 31 Dec 2099 23:59:59 GMT; Max-Age=0",
      "Max-Age=0; Expires=Wed, 31 Dec 2099 23:59:59 GMT",
    ]) {
      const source = [{
        ...cookies[0]!,
        name: "__cf_bm",
        value: "source-value",
        domain: "x.com",
        hostOnly: false,
      }];
      let persisted: WebSessionCookieRotationState | null = null;
      let persistedAcceptedAtSeconds: number | null = null;
      const firstClient = await createWebSessionClient("https://x.com", auth, {
        timeoutMs: 1_000,
        dependencies: {
          acquireCookies: () => Promise.resolve({ cookies: source, warnings: [] }),
          fetch: () => Promise.resolve(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": `__cf_bm=deleted; ${attributes}; Domain=.x.com; Path=/; Secure; HttpOnly; SameSite=None`,
            },
          })),
        },
        cookieRotation: {
          ...rotationPolicy,
          cachedState: emptyRotationState,
          save: (state) => {
            persisted = state;
            persistedAcceptedAtSeconds = state.tombstones[0]?.acceptedAtSeconds ?? null;
          },
        },
      });
      await firstClient.requestJson({
        url: new URL("/i/api/delete", "https://x.com"),
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: 1_024,
      });
      if (persisted === null) throw new Error("expected a persisted rotating-cookie tombstone");

      let nextCookieHeader = "";
      const secondClient = await createWebSessionClient("https://x.com", auth, {
        timeoutMs: 1_000,
        dependencies: {
          acquireCookies: () => Promise.resolve({ cookies: source, warnings: [] }),
          fetch: (_value, init) => {
            nextCookieHeader = new Headers(init?.headers).get("cookie") ?? "";
            return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }));
          },
        },
        cookieRotation: {
          ...rotationPolicy,
          cachedState: persisted,
          save: () => undefined,
        },
      });
      await secondClient.requestJson({
        url: new URL("/i/api/after-delete", "https://x.com"),
        method: "GET",
        headers: { accept: "application/json" },
        maxBytes: 1_024,
      });
      expect(nextCookieHeader).not.toContain("__cf_bm=");
      expect(typeof persistedAcceptedAtSeconds).toBe("number");
      expect(persisted).toMatchObject({
        cookies: [],
        tombstones: [{
          name: "__cf_bm",
          domain: "x.com",
          hostOnly: false,
          path: "/",
        }],
      });
    }
  });
});
