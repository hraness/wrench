import { describe, expect, test } from "bun:test";

import type {
  CookieRecordReader,
  CookieSelection,
} from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "./auth";
import type { OperationInput } from "./model";
import {
  executeWebSessionTemplate,
  type WebSessionHttpDependencies,
  type WebSessionSecretSource,
} from "./web-session-http";
import type { WebSessionTemplate } from "./web-session-template";

const auth = {
  schemaVersion: 1,
  id: "arc-life",
  kind: "cookie-source",
  source: "arc",
  profile: "Profile 1",
} as const satisfies WrenchAuth;

const input = {
  post_id: "post é?value",
  text: "Hello & goodbye",
  count: 7,
  published: true,
  tags: ["alpha", "b eta"],
} as const satisfies OperationInput;

function strictCookie(name: string, value: string, overrides: Partial<StrictCookie> = {}): StrictCookie {
  return {
    name,
    value,
    domain: "x.com",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
    ...overrides,
  };
}

const defaultCookies = [
  strictCookie("ct0", '"csrf-private"'),
  strictCookie("auth_token", "cookie-private"),
] as const;

function template(overrides: {
  readonly headers?: WebSessionTemplate["request"]["headers"];
  readonly body?: WebSessionTemplate["request"]["body"];
  readonly response?: WebSessionTemplate["response"];
  readonly method?: WebSessionTemplate["request"]["method"];
} = {}): WebSessionTemplate {
  return {
    schemaVersion: 1,
    origin: "https://x.com",
    request: {
      method: overrides.method ?? "POST",
      path: [
        { kind: "literal", value: "i" },
        { kind: "literal", value: "api" },
        { kind: "literal", value: "graphql" },
        { kind: "input", name: "post_id", valueType: "string" },
      ],
      query: [
        {
          name: "variables",
          encoding: "json",
          value: {
            kind: "object",
            entries: [
              { name: "id", value: { kind: "input", name: "post_id", valueType: "string" } },
              { name: "tags", value: { kind: "input", name: "tags", valueType: "string[]" } },
            ],
          },
        },
        { name: "limit", encoding: "scalar", value: { kind: "input", name: "count", valueType: "number" } },
      ],
      headers: overrides.headers ?? [
        { name: "accept", value: { kind: "literal", value: "application/json" } },
        {
          name: "x-csrf-token",
          value: {
            kind: "browser-csrf",
            source: { kind: "cookie", name: "ct0" },
            transform: "strip-surrounding-quotes",
          },
        },
        {
          name: "authorization",
          value: {
            kind: "browser-authorization",
            source: { kind: "captured-header", name: "authorization" },
            transform: "identity",
          },
        },
      ],
      body: overrides.body ?? {
        kind: "json",
        value: {
          kind: "object",
          entries: [
            { name: "text", value: { kind: "input", name: "text", valueType: "string" } },
            { name: "count", value: { kind: "input", name: "count", valueType: "number" } },
            { name: "published", value: { kind: "input", name: "published", valueType: "boolean" } },
            { name: "client", value: { kind: "literal", value: "wrench" } },
          ],
        },
      },
    },
    response: overrides.response ?? {
      maxBytes: 4_096,
      variants: [{
        status: 200,
        contentType: "application/json",
        body: {
          kind: "json",
          bindings: [
            {
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "requestId" }],
              expected: { kind: "input", name: "post_id", valueType: "string" },
            },
            {
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "ok" }],
              expected: { kind: "literal", value: true },
            },
          ],
          projections: [
            {
              name: "id",
              path: [{ kind: "key", key: "data" }, { kind: "key", key: "id" }],
              valueType: "string",
              required: true,
            },
            {
              name: "firstItem",
              path: [
                { kind: "key", key: "data" },
                { kind: "key", key: "items" },
                { kind: "index", index: 0 },
              ],
              valueType: "string",
              required: false,
            },
          ],
        },
      }],
    },
  };
}

type CapturedRequest = {
  readonly url: string;
  readonly init: RequestInit;
};

function inputUrl(value: string | URL | Request): string {
  return typeof value === "string" ? value : value instanceof URL ? value.href : value.url;
}

function bodyText(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a captured string request body");
  return value;
}

function responsePayload(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    data: {
      requestId: input.post_id,
      ok: true,
      id: "result-id",
      items: ["first", "second"],
      unreviewedCredential: "response-private",
      ...overrides,
    },
  });
}

function dependencies(
  handler: (request: CapturedRequest) => Response | Promise<Response>,
  options: {
    readonly cookies?: readonly StrictCookie[];
    readonly selections?: CookieSelection[];
    readonly cookieUrls?: URL[];
    readonly resolveSecret?: WebSessionHttpDependencies["resolveSecret"];
  } = {},
): Partial<WebSessionHttpDependencies> {
  const acquireCookies: CookieRecordReader = (selection, url) => {
    options.selections?.push(selection);
    options.cookieUrls?.push(new URL(url));
    return Promise.resolve({ cookies: options.cookies ?? defaultCookies, warnings: [] });
  };
  const fetch = (async (value: string | URL | Request, init?: RequestInit) =>
    handler({ url: inputUrl(value), init: init ?? {} })) as typeof globalThis.fetch;
  return {
    acquireCookies,
    fetch,
    ...(options.resolveSecret === undefined ? {} : { resolveSecret: options.resolveSecret }),
  };
}

async function rejectionMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

function jsonResponse(body = responsePayload(), status = 200, contentType = "application/json; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("reviewed authenticated web-session HTTP", () => {
  test("keeps the abort deadline active while streaming a stalled response body", async () => {
    let observedSignal: AbortSignal | null = null;
    const started = Date.now();
    const message = await rejectionMessage(executeWebSessionTemplate(template({
      headers: [{ name: "accept", value: { kind: "literal", value: "application/json" } }],
    }), input, auth, {
      timeoutMs: 20,
      dependencies: dependencies((call) => {
        const signal = call.init.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("expected abort signal");
        observedSignal = signal;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(new DOMException("deadline", "AbortError")), { once: true });
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      }),
    }));
    expect(message).toContain("deadline");
    const capturedSignal = observedSignal as AbortSignal | null;
    expect(capturedSignal?.aborted).toBeTrue();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("renders one exact origin, independently encoded path, ordered query, typed JSON body, and cookie-backed CSRF", async () => {
    const calls: CapturedRequest[] = [];
    const selections: CookieSelection[] = [];
    const cookieUrls: URL[] = [];
    const secretCalls: { source: WebSessionSecretSource; origin: string; header: string }[] = [];
    const result = await executeWebSessionTemplate(template(), input, auth, {
      timeoutMs: 4_321,
      dependencies: dependencies((call) => {
        calls.push(call);
        return jsonResponse();
      }, {
        selections,
        cookieUrls,
        resolveSecret: (source, context) => {
          secretCalls.push({ source, ...context });
          return Promise.resolve("Bearer authorization-private");
        },
      }),
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("missing captured request");
    const url = new URL(call.url);
    expect(url.origin).toBe("https://x.com");
    expect(url.pathname).toBe("/i/api/graphql/post%20%C3%A9%3Fvalue");
    expect([...url.searchParams.keys()]).toEqual(["variables", "limit"]);
    expect(JSON.parse(url.searchParams.get("variables") ?? "null")).toEqual({
      id: input.post_id,
      tags: input.tags,
    });
    expect(url.searchParams.get("limit")).toBe("7");
    expect(JSON.parse(bodyText(call.init.body)) as unknown).toEqual({
      text: input.text,
      count: 7,
      published: true,
      client: "wrench",
    });
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call.init.headers);
    expect(headers.get("cookie")).toBe('ct0="csrf-private"; auth_token=cookie-private');
    expect(headers.get("x-csrf-token")).toBe("csrf-private");
    expect(headers.get("authorization")).toBe("Bearer authorization-private");
    expect(headers.get("origin")).toBe("https://x.com");
    expect(headers.get("content-type")).toBe("application/json");
    expect(selections).toEqual([{
      cookieSources: ["arc"],
      cookiesFile: undefined,
      cookieProfile: "Profile 1",
      requireExplicitCookieScope: true,
      timeoutMs: 4_321,
    }]);
    expect(cookieUrls.map((candidate) => candidate.href)).toEqual([url.href]);
    expect(secretCalls).toEqual([{
      source: { kind: "captured-header", name: "authorization" },
      origin: "https://x.com",
      header: "authorization",
    }]);
    expect(result).toEqual({
      status: 200,
      output: { id: "result-id", firstItem: "first" },
      responseBytes: new TextEncoder().encode(responsePayload()).byteLength,
    });
    expect(JSON.stringify(result)).not.toContain("response-private");
    expect(JSON.stringify(result)).not.toContain("authorization-private");
    expect(JSON.stringify(result)).not.toContain("cookie-private");
  });

  test("confines storage bootstraps to their reviewed authorization and CSRF header sinks", async () => {
    const calls: CapturedRequest[] = [];
    const resolved: { source: WebSessionSecretSource; origin: string; header: string }[] = [];
    const reviewed = template({
      headers: [
        {
          name: "authorization",
          value: {
            kind: "browser-authorization",
            source: { kind: "storage", area: "local", key: "bearer" },
            transform: "bearer",
          },
        },
        {
          name: "x-csrf-token",
          value: {
            kind: "browser-csrf",
            source: { kind: "storage", area: "session", key: "csrf" },
            transform: "url-decode",
          },
        },
      ],
    });
    const result = await executeWebSessionTemplate(reviewed, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies((call) => {
        calls.push(call);
        return jsonResponse();
      }, {
        resolveSecret: (source, context) => {
          resolved.push({ source, ...context });
          return Promise.resolve(context.header === "authorization" ? "bootstrap-private" : "csrf%2Fprivate");
        },
      }),
    });

    expect(resolved).toEqual([
      {
        source: { kind: "storage", area: "local", key: "bearer" },
        origin: "https://x.com",
        header: "authorization",
      },
      {
        source: { kind: "storage", area: "session", key: "csrf" },
        origin: "https://x.com",
        header: "x-csrf-token",
      },
    ]);
    const call = calls[0];
    if (call === undefined) throw new Error("missing captured request");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer bootstrap-private");
    expect(headers.get("x-csrf-token")).toBe("csrf/private");
    expect(call.url).not.toContain("bootstrap-private");
    expect(call.url).not.toContain("csrf%2Fprivate");
    expect(bodyText(call.init.body)).not.toContain("bootstrap-private");
    expect(bodyText(call.init.body)).not.toContain("csrf%2Fprivate");
    expect(JSON.stringify(result)).not.toContain("bootstrap-private");
    expect(JSON.stringify(result)).not.toContain("csrf/private");
  });

  test("renders reviewed form bodies exactly and leaves GET body and mutation-only headers absent", async () => {
    const formTemplate = template({
      headers: [],
      body: {
        kind: "form",
        fields: [
          { name: "text", value: { kind: "input", name: "text", valueType: "string" } },
          { name: "published", value: { kind: "input", name: "published", valueType: "boolean" } },
          { name: "fixed", value: { kind: "literal", value: "a+b & c" } },
        ],
      },
    });
    let formCall: CapturedRequest | undefined;
    await executeWebSessionTemplate(formTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies((call) => {
        formCall = call;
        return jsonResponse();
      }),
    });
    if (formCall === undefined) throw new Error("missing form request");
    expect(bodyText(formCall.init.body)).toBe("text=Hello+%26+goodbye&published=true&fixed=a%2Bb+%26+c");
    expect(new Headers(formCall.init.headers).get("content-type"))
      .toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(new Headers(formCall.init.headers).get("origin")).toBe("https://x.com");

    const getTemplate = template({ method: "GET", headers: [], body: { kind: "none" } });
    let getCall: CapturedRequest | undefined;
    await executeWebSessionTemplate(getTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies((call) => {
        getCall = call;
        return jsonResponse();
      }),
    });
    if (getCall === undefined) throw new Error("missing GET request");
    expect(getCall.init.method).toBe("GET");
    expect(getCall.init).not.toHaveProperty("body");
    const getHeaders = new Headers(getCall.init.headers);
    expect(getHeaders.has("origin")).toBeFalse();
    expect(getHeaders.has("content-type")).toBeFalse();
  });

  test("fails closed when a bootstrap is absent, malformed, or requests a meta source outside browser context", async () => {
    let fetches = 0;
    const storageTemplate = template({
      headers: [{
        name: "authorization",
        value: {
          kind: "browser-authorization",
          source: { kind: "storage", area: "local", key: "bearer" },
          transform: "bearer",
        },
      }],
    });
    const noBootstrap = await rejectionMessage(executeWebSessionTemplate(storageTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => {
        fetches += 1;
        return jsonResponse();
      }),
    }));
    expect(noBootstrap).toContain("requires a browser bootstrap");

    const malformedSecret = "bootstrap-private\r\nforged: value";
    const malformed = await rejectionMessage(executeWebSessionTemplate(storageTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => {
        fetches += 1;
        return jsonResponse();
      }, { resolveSecret: () => Promise.resolve(malformedSecret) }),
    }));
    expect(malformed).toContain("invalid authorization value");
    expect(malformed).not.toContain(malformedSecret);

    const metaTemplate = template({
      headers: [{
        name: "x-csrf-token",
        value: {
          kind: "browser-csrf",
          source: { kind: "meta", name: "csrf-token" },
          transform: "identity",
        },
      }],
    });
    let resolutions = 0;
    const meta = await rejectionMessage(executeWebSessionTemplate(metaTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => {
        fetches += 1;
        return jsonResponse();
      }, {
        resolveSecret: () => {
          resolutions += 1;
          return Promise.resolve("must-not-run");
        },
      }),
    }));
    expect(meta).toContain("requires a browser-context executor");
    expect(fetches).toBe(0);
    expect(resolutions).toBe(0);
  });

  test("requires exactly one named CSRF cookie and redacts every rejected cookie value", async () => {
    const variants: readonly (readonly StrictCookie[])[] = [
      [strictCookie("auth_token", "only-session-private")],
      [
        strictCookie("ct0", "first-csrf-private"),
        strictCookie("ct0", "second-csrf-private"),
      ],
    ];
    for (const cookies of variants) {
      let fetches = 0;
      const message = await rejectionMessage(executeWebSessionTemplate(template({
        headers: [{
          name: "x-csrf-token",
          value: {
            kind: "browser-csrf",
            source: { kind: "cookie", name: "ct0" },
            transform: "identity",
          },
        }],
      }), input, auth, {
        timeoutMs: 1_000,
        dependencies: dependencies(() => {
          fetches += 1;
          return jsonResponse();
        }, { cookies }),
      }));
      expect(message).toContain("exactly one reviewed ct0 cookie");
      for (const cookie of cookies) expect(message).not.toContain(cookie.value);
      expect(fetches).toBe(0);
    }

    const invalidEncoded = "%E0%A4%A";
    const decodeMessage = await rejectionMessage(executeWebSessionTemplate(template({
      headers: [{
        name: "x-csrf-token",
        value: {
          kind: "browser-csrf",
          source: { kind: "cookie", name: "ct0" },
          transform: "url-decode",
        },
      }],
    }), input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => jsonResponse(), { cookies: [strictCookie("ct0", invalidEncoded)] }),
    }));
    expect(decodeMessage).toContain("could not be URL-decoded");
    expect(decodeMessage).not.toContain(invalidEncoded);
  });

  test("pins redirect handling and rejects redirects, network failures, unreviewed statuses, and content-type drift", async () => {
    const cases = [
      [new Response(null, { status: 302, headers: { location: "https://evil.example" } }), "302/missing"],
      [jsonResponse("{}", 201), "201/application/json"],
      [new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }), "200/text/html"],
      [new Response("{}", { status: 200 }), "200/missing"],
    ] as const;
    for (const [response, expected] of cases) {
      const message = await rejectionMessage(executeWebSessionTemplate(template(), input, auth, {
        timeoutMs: 1_000,
        dependencies: dependencies((call) => {
          expect(call.init.redirect).toBe("error");
          return response;
        }, { resolveSecret: () => Promise.resolve("Bearer private") }),
      }));
      expect(message).toContain(`unreviewed status/content type ${expected}`);
      expect(message).not.toContain("<html>login</html>");
    }

    const fetchSecret = "network-private-detail";
    const networkMessage = await rejectionMessage(executeWebSessionTemplate(template(), input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => {
        throw new Error(fetchSecret);
      }, { resolveSecret: () => Promise.resolve("Bearer private") }),
    }));
    expect(networkMessage).toBe("authenticated web API request failed before a reviewed response was received");
    expect(networkMessage).not.toContain(fetchSecret);
  });

  test("bounds response bytes before parsing and never echoes an oversized body", async () => {
    const oversizedSecret = "oversized-response-private";
    const reviewed = template({ response: { ...template().response, maxBytes: 8 } });
    const message = await rejectionMessage(executeWebSessionTemplate(reviewed, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => jsonResponse(oversizedSecret), {
        resolveSecret: () => Promise.resolve("Bearer private"),
      }),
    }));
    expect(message).toContain("response exceeded 8 bytes");
    expect(message).not.toContain(oversizedSecret);
  });

  test("enforces every response binding, projection presence, projection type, and JSON validity", async () => {
    const failures = [
      [responsePayload({ requestId: "wrong-private-target" }), "failed its reviewed target binding"],
      [responsePayload({ requestId: undefined }), "failed its reviewed target binding"],
      [responsePayload({ ok: false }), "failed its reviewed target binding"],
      [responsePayload({ id: undefined }), "omitted required projection id"],
      [responsePayload({ id: 123 }), "projection id changed type"],
      ["not-json-private", "returned malformed JSON"],
    ] as const;
    for (const [body, expected] of failures) {
      const message = await rejectionMessage(executeWebSessionTemplate(template(), input, auth, {
        timeoutMs: 1_000,
        dependencies: dependencies(() => jsonResponse(body), {
          resolveSecret: () => Promise.resolve("Bearer private"),
        }),
      }));
      expect(message).toContain(expected);
      expect(message).not.toContain("wrong-private-target");
      expect(message).not.toContain("not-json-private");
    }
  });

  test("omits absent optional projections and returns no unreviewed response fields", async () => {
    const payload = responsePayload({ items: [], credential: "never-return-response-private" });
    const result = await executeWebSessionTemplate(template(), input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => jsonResponse(payload), {
        resolveSecret: () => Promise.resolve("Bearer private"),
      }),
    });
    expect(result.output).toEqual({ id: "result-id" });
    expect(Object.keys(result.output ?? {})).toEqual(["id"]);
    expect(JSON.stringify(result)).not.toContain("never-return-response-private");
  });

  test("handles exact empty and discard response variants without exposing bodies", async () => {
    const emptyTemplate = template({
      headers: [],
      body: { kind: "none" },
      method: "POST",
      response: {
        maxBytes: 128,
        variants: [{ status: 204, contentType: null, body: { kind: "empty" } }],
      },
    });
    expect(await executeWebSessionTemplate(emptyTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => new Response(null, { status: 204 })),
    })).toEqual({ status: 204, output: null, responseBytes: 0 });

    const discardSecret = "discarded-response-private";
    const discardTemplate = template({
      headers: [],
      response: {
        maxBytes: 128,
        variants: [{ status: 202, contentType: "text/plain", body: { kind: "discard" } }],
      },
    });
    const discarded = await executeWebSessionTemplate(discardTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => new Response(discardSecret, {
        status: 202,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })),
    });
    expect(discarded).toEqual({
      status: 202,
      output: null,
      responseBytes: new TextEncoder().encode(discardSecret).byteLength,
    });
    expect(JSON.stringify(discarded)).not.toContain(discardSecret);

    const unexpectedBodyTemplate = template({
      headers: [],
      response: {
        maxBytes: 128,
        variants: [{ status: 200, contentType: null, body: { kind: "empty" } }],
      },
    });
    const unexpected = await rejectionMessage(executeWebSessionTemplate(unexpectedBodyTemplate, input, auth, {
      timeoutMs: 1_000,
      dependencies: dependencies(() => new Response("unexpected-private", { status: 200 })),
    }));
    expect(unexpected).toContain("unexpected response body");
    expect(unexpected).not.toContain("unexpected-private");
  });

  test("accepts only cookie-capable auth locators and never asks for cookies with OAuth auth", async () => {
    const unsupported: readonly WrenchAuth[] = [
      {
        schemaVersion: 1,
        id: "profile-only",
        kind: "browser-profile",
        profile: "Profile 1",
        trustUnfilteredEgress: true,
      },
      {
        schemaVersion: 1,
        id: "oauth",
        kind: "oauth-token-file",
        provider: "x",
        path: "/private/token.json",
        scopes: ["tweet.read"],
      },
    ];
    for (const locator of unsupported) {
      const selections: CookieSelection[] = [];
      const message = await rejectionMessage(executeWebSessionTemplate(template({ headers: [] }), input, locator, {
        timeoutMs: 1_000,
        dependencies: dependencies(() => jsonResponse(), {
          selections,
          cookies: [],
        }),
      }));
      expect(message).toContain("requires");
      expect(message).not.toContain("/private/token.json");
      expect(selections).toEqual([]);
    }
  });

  test("maps cookies-file and hybrid browser-profile locators to exact cookie selections", async () => {
    const cases: readonly [WrenchAuth, CookieSelection][] = [
      [
        { schemaVersion: 1, id: "file", kind: "cookies-file", path: "/private/cookies.json" },
        { cookieSources: [], cookiesFile: "/private/cookies.json", cookieProfile: undefined, timeoutMs: 2_000 },
      ],
      [
        {
          schemaVersion: 1,
          id: "hybrid",
          kind: "browser-profile",
          profile: "/private/Profile 1",
          trustUnfilteredEgress: true,
          cookieSource: "arc",
          cookieProfile: "Profile 1",
        },
        { cookieSources: ["arc"], cookiesFile: undefined, cookieProfile: "Profile 1", timeoutMs: 2_000 },
      ],
    ];
    for (const [locator, expected] of cases) {
      const selections: CookieSelection[] = [];
      await executeWebSessionTemplate(template({ headers: [] }), input, locator, {
        timeoutMs: 2_000,
        dependencies: dependencies(() => jsonResponse(), { selections }),
      });
      expect(selections).toEqual([{ ...expected, requireExplicitCookieScope: true }]);
    }
  });
});
