import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CookieRecordReader } from "@hraness/kb/clip/acquire";
import type { StrictCookie } from "@hraness/kb/clip/cookies";
import type { WrenchAuth } from "../auth";
import type { WebSessionRecipe } from "../model";
import { TWITCH_WEB_CLIENT_ID } from "./twitch-web";
import {
  executeTwitchWebOperation,
  probeTwitchWebSubject,
  type TwitchWebRuntimeDependencies,
} from "./twitch-web-runtime";

const VIEWER_ID = "123456789";
const AUTH_TOKEN = "private_auth_token_1234567890";

const boundAuth = {
  schemaVersion: 1,
  id: "twitch-test",
  kind: "cookie-source",
  source: "chrome",
  profile: "Profile 1",
  subject: `twitch:${VIEWER_ID}`,
} as const satisfies WrenchAuth;

type CapturedRequest = Readonly<{
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
  redirect: "error" | "follow" | "manual" | undefined;
}>;

function strictCookie(name: string, value: string): StrictCookie {
  return {
    name,
    value,
    domain: ".twitch.tv",
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: 0,
  };
}

const cookies = Object.freeze([
  strictCookie("auth-token", AUTH_TOKEN),
  strictCookie("ordinary-cookie", "ordinary-cookie-value"),
]);

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function viewerResponse(id = VIEWER_ID): unknown {
  return [{ data: { currentUser: { id } } }];
}

function profileResponse(
  id = VIEWER_ID,
  followers: unknown = 17,
): unknown {
  return [{
    data: {
      user: { id, followers: { totalCount: followers } },
    },
  }];
}

function inputUrl(value: string | URL | Request): URL {
  return new URL(
    typeof value === "string"
      ? value
      : value instanceof URL ? value.href : value.url,
  );
}

function dependencies(
  calls: CapturedRequest[],
  handler: (
    request: CapturedRequest,
    index: number,
  ) => Response | Promise<Response>,
  sourceCookies: readonly StrictCookie[] = cookies,
): TwitchWebRuntimeDependencies {
  const acquireCookies: CookieRecordReader = () =>
    Promise.resolve({ cookies: sourceCookies, warnings: [] });
  const fetch = (async (
    value: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = init?.body;
    const request = Object.freeze({
      url: inputUrl(value),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof body === "string" ? body : null,
      redirect: init?.redirect,
    });
    calls.push(request);
    return handler(request, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { acquireCookies, fetch };
}

const recipe: WebSessionRecipe = {
  site: "twitch",
  action: "profiles.read",
  contractVersion: 1,
  timeoutMs: 1_000,
  maxOutputBytes: 2 * 1024 * 1024,
};

function parsedBody(request: CapturedRequest): readonly Record<string, unknown>[] {
  if (request.body === null) throw new Error("missing request body");
  return JSON.parse(request.body) as readonly Record<string, unknown>[];
}

describe("Twitch authenticated profile runtime", () => {
  test("probes one exact viewer operation with contained cookie authority", async () => {
    const calls: CapturedRequest[] = [];
    const subject = await probeTwitchWebSubject(boundAuth, {
      dependencies: dependencies(calls, (request) => {
        expect(request.url.href).toBe("https://gql.twitch.tv/gql");
        expect(request.method).toBe("POST");
        expect(request.redirect).toBe("error");
        expect(request.headers.get("authorization")).toBe(
          `OAuth ${AUTH_TOKEN}`,
        );
        expect(request.headers.get("client-id")).toBe(TWITCH_WEB_CLIENT_ID);
        expect(request.headers.has("client-integrity")).toBeFalse();
        expect(request.headers.get("content-type")).toBe("text/plain");
        expect(parsedBody(request)).toMatchObject([{
          operationName: "TopNav_CurrentUser",
          variables: {},
          extensions: {
            persistedQuery: { version: 1 },
          },
        }]);
        return jsonResponse(viewerResponse());
      }),
    });
    expect(subject).toBe(`twitch:${VIEWER_ID}`);
    expect(calls).toHaveLength(1);
  });

  test("reads only an exact viewer-bound requested profile and count", async () => {
    const calls: CapturedRequest[] = [];
    let callbacks = 0;
    const result = await executeTwitchWebOperation(
      recipe,
      { profile: "wrench_test" },
      boundAuth,
      {
        beforeDispatch: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        afterDispatchVerified: () => {
          callbacks += 1;
          return Promise.resolve();
        },
        dependencies: {
          ...dependencies(calls, (request, index) => {
            if (index === 0) return jsonResponse(viewerResponse());
            expect(request.headers.has("client-integrity")).toBeFalse();
            expect(request.headers.get("referer")).toBe(
              "https://www.twitch.tv/wrench_test/about",
            );
            expect(parsedBody(request)).toMatchObject([{
              operationName: "ChannelRoot_AboutPanel",
              variables: {
                channelLogin: "wrench_test",
                skipSchedule: true,
              },
              extensions: {
                persistedQuery: { version: 1 },
              },
            }]);
            return jsonResponse(profileResponse());
          }),
          now: () => Date.parse("2026-08-25T12:34:56.789Z"),
        },
      },
    );
    expect(callbacks).toBe(0);
    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      status: "succeeded",
      output: {
        schemaVersion: 1,
        provider: "twitch",
        target: {
          kind: "profile",
          id: VIEWER_ID,
          url: "https://www.twitch.tv/wrench_test",
        },
        observedAt: "2026-08-25T12:34:56.789Z",
        completeness: "complete",
        metrics: {
          followers: {
            status: "available",
            value: 17,
            precision: "exact",
            unit: "count",
          },
        },
        metadata: { login: "wrench_test" },
      },
      finalUrl: "https://www.twitch.tv/wrench_test",
      dispatchStarted: false,
      dispatch: { planned: 0, started: 0, verified: 0 },
    });
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
  });

  test("fails closed before the target read on missing or mismatched binding", async () => {
    const missingCalls: CapturedRequest[] = [];
    const { subject: _subject, ...unboundAuth } = boundAuth;
    await expect(executeTwitchWebOperation(
      recipe,
      { profile: "wrench_test" },
      unboundAuth,
      {
        dependencies: dependencies(
          missingCalls,
          () => jsonResponse(viewerResponse()),
        ),
      },
    )).rejects.toThrow("bound to the exact viewer subject");
    expect(missingCalls).toHaveLength(1);

    const mismatchCalls: CapturedRequest[] = [];
    await expect(executeTwitchWebOperation(
      recipe,
      { profile: "wrench_test" },
      boundAuth,
      {
        dependencies: dependencies(
          mismatchCalls,
          () => jsonResponse(viewerResponse("987654321")),
        ),
      },
    )).rejects.toThrow("no longer matches the confirmed auth subject");
    expect(mismatchCalls).toHaveLength(1);
  });

  test("rejects response status, content type, byte, token, and target drift", async () => {
    const scenarios: readonly [
      string,
      readonly StrictCookie[],
      (index: number) => Response,
    ][] = [
      ["unreviewed status", cookies, () => jsonResponse({}, 403)],
      ["unreviewed status/content type", cookies, () => new Response("ok", {
        status: 200,
        headers: { "content-type": "text/html" },
      })],
      ["exceeded its reviewed byte limit", cookies, () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(256 * 1024 + 1),
        },
      })],
      ["exactly one auth-token", [], () => jsonResponse(viewerResponse())],
      [
        "cookie source returned malformed or out-of-scope records",
        [
          strictCookie("auth-token", AUTH_TOKEN),
          strictCookie("auth-token", `${AUTH_TOKEN}_duplicate`),
        ],
        () => jsonResponse(viewerResponse()),
      ],
      ["did not bind the current viewer ID", cookies, (index) =>
        jsonResponse(index === 0
          ? viewerResponse()
          : profileResponse("987654321"))],
    ];
    for (const [message, sourceCookies, response] of scenarios) {
      const calls: CapturedRequest[] = [];
      await expect(executeTwitchWebOperation(
        recipe,
        { profile: "wrench_test" },
        boundAuth,
        {
          dependencies: dependencies(
            calls,
            (_request, index) => response(index),
            sourceCookies,
          ),
        },
      )).rejects.toThrow(message);
    }
  });

  test("accepts no input aliases or extra transport fields", async () => {
    for (const input of [
      {},
      { login: "wrench_test" },
      { profile: "wrench_test", url: "https://example.com" },
      { profile: "Wrench_Test" },
    ]) {
      const calls: CapturedRequest[] = [];
      await expect(executeTwitchWebOperation(
        recipe,
        input,
        boundAuth,
        { dependencies: dependencies(calls, () => jsonResponse({})) },
      )).rejects.toThrow();
      expect(calls).toHaveLength(0);
    }
  });

  test("contains no DOM, browser action, or raw transport fallback", () => {
    const source = readFileSync(
      join(import.meta.dir, "twitch-web-runtime.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/agent-browser|document\.|querySelector/u);
    expect(source).not.toMatch(
      /\bpage\.(?:click|fill|goto|press|type|upload)\s*\(/u,
    );
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toMatch(/\b(?:http|https)\.request\s*\(/u);
  });
});
