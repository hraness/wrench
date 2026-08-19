import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAuth, removeAuth } from "./auth";
import {
  GOOGLE_GMAIL_READ_SCOPES,
  installManagedGoogleOAuth,
  loginGoogleOAuth,
  parseGoogleDesktopClient,
  resolveOAuthToken,
} from "./oauth-google";

const CLIENT = {
  installed: {
    client_id: "1234567890-example.apps.googleusercontent.com",
    project_id: "private-rolodex",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: "desktop-client-secret",
    redirect_uris: ["http://localhost"],
    universe_domain: "googleapis.com",
  },
} as const;

function workspace(): {
  readonly root: string;
  readonly clientFile: string;
  readonly environment: Readonly<Record<string, string>>;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-google-oauth-test-"));
  chmodSync(root, 0o700);
  const clientFile = join(root, "desktop-client.json");
  writeFileSync(clientFile, JSON.stringify(CLIENT), { mode: 0o600 });
  const state = join(root, "state");
  return {
    root,
    clientFile,
    environment: { WRENCH_STATE_HOME: state },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Google OAuth lifecycle", () => {
  test("strictly accepts one downloaded Google Desktop client", () => {
    expect(parseGoogleDesktopClient(CLIENT)).toEqual({
      clientId: CLIENT.installed.client_id,
      clientSecret: CLIENT.installed.client_secret,
      projectId: CLIENT.installed.project_id,
    });
    expect(() => parseGoogleDesktopClient({
      ...CLIENT,
      installed: { ...CLIENT.installed, token_uri: "https://example.com/token" },
    })).toThrow("unreviewed token endpoint");
    expect(() => parseGoogleDesktopClient({
      ...CLIENT,
      installed: { ...CLIENT.installed, extra: true },
    })).toThrow("unsupported field extra");
  });

  test("logs in without exposing tokens and installs a private managed locator", async () => {
    const fixture = workspace();
    const requests: URL[] = [];
    try {
      const login = await loginGoogleOAuth({
        clientFile: fixture.clientFile,
        openBrowser: false,
      }, {
        now: () => new Date("2026-08-14T12:00:00.000Z"),
        randomBytes: (size) => new Uint8Array(size).fill(7),
        authorize: async (request) => {
          expect(request.openBrowser).toBe(false);
          expect(request.scopes).toEqual(GOOGLE_GMAIL_READ_SCOPES);
          expect(request.codeChallenge).toHaveLength(43);
          return {
            code: "authorization-code-value",
            redirectUri: "http://127.0.0.1:43123/oauth2/callback",
          };
        },
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          requests.push(url);
          if (url.hostname === "oauth2.googleapis.com") {
            expect(init?.method).toBe("POST");
            const form = new URLSearchParams(String(init?.body));
            expect(form.get("grant_type")).toBe("authorization_code");
            expect(form.get("code_verifier")).toHaveLength(86);
            return jsonResponse({
              access_token: "private-initial-access-token",
              expires_in: 3600,
              refresh_token: "private-durable-refresh-token",
              scope: GOOGLE_GMAIL_READ_SCOPES.join(" "),
              token_type: "Bearer",
            });
          }
          expect(url.href).toBe(
            "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
          );
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            "Bearer private-initial-access-token",
          );
          return jsonResponse({ emailAddress: "Person@Example.com" });
        },
      });
      expect(requests.map((url) => url.hostname)).toEqual([
        "oauth2.googleapis.com",
        "gmail.googleapis.com",
      ]);
      expect(login).toMatchObject({
        subject: "person@example.com",
        refreshTokenExpiresAt: null,
      });
      expect(JSON.stringify({
        subject: login.subject,
        scopes: login.scopes,
        refreshTokenExpiresAt: login.refreshTokenExpiresAt,
      })).not.toContain("private-");

      const installed = installManagedGoogleOAuth(
        "gmail-main",
        login,
        fixture.environment,
      );
      expect(installed.auth).toMatchObject({
        id: "gmail-main",
        kind: "oauth-token-file",
        managed: true,
        provider: "gmail",
        subject: "person@example.com",
      });
      expect(loadAuth("gmail-main", fixture.environment)).toEqual(installed.auth);
      expect(Number(lstatSync(installed.auth.path).mode & 0o777)).toBe(0o600);
      expect(readFileSync(installed.auth.path, "utf8")).toContain(
        "private-durable-refresh-token",
      );

      expect(removeAuth("gmail-main", fixture.environment)).toBe(true);
      expect(() => lstatSync(installed.auth.path)).toThrow();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("accepts Google's exact RFC 9207 issuer in the loopback callback", async () => {
    const fixture = workspace();
    let callbackResponse: Promise<Response> | undefined;
    try {
      const login = await loginGoogleOAuth({
        clientFile: fixture.clientFile,
        openBrowser: false,
        onAuthorizationUrl: (authorizationUrl) => {
          const authorization = new URL(authorizationUrl);
          const redirectUri = authorization.searchParams.get("redirect_uri");
          const state = authorization.searchParams.get("state");
          if (redirectUri === null || state === null) {
            throw new Error("authorization URL omitted its loopback binding");
          }
          const callback = new URL(redirectUri);
          callback.searchParams.set("authuser", "0");
          callback.searchParams.set("code", "authorization-code-value");
          callback.searchParams.set("iss", "https://accounts.google.com");
          callback.searchParams.set("prompt", "consent");
          callback.searchParams.set("scope", GOOGLE_GMAIL_READ_SCOPES.join(" "));
          callback.searchParams.set("state", state);
          callbackResponse = fetch(callback);
        },
      }, {
        now: () => new Date("2026-08-14T12:00:00.000Z"),
        randomBytes: (size) => new Uint8Array(size).fill(11),
        fetch: async (input) => {
          const host = new URL(input instanceof Request ? input.url : input.toString()).hostname;
          return host === "oauth2.googleapis.com"
            ? jsonResponse({
                access_token: "private-loopback-access-token",
                expires_in: 3600,
                refresh_token: "private-loopback-refresh-token",
                scope: GOOGLE_GMAIL_READ_SCOPES.join(" "),
                token_type: "Bearer",
              })
            : jsonResponse({ emailAddress: "person@example.com" });
        },
      });

      expect(login.subject).toBe("person@example.com");
      if (callbackResponse === undefined) throw new Error("loopback callback was not requested");
      expect((await callbackResponse).status).toBe(200);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects invalid RFC 9207 issuers and unknown loopback fields", async () => {
    const scenarios = [
      {
        expected: "issuer did not match",
        mutate: (callback: URL): void => {
          callback.searchParams.set("iss", "https://example.com");
        },
      },
      {
        expected: "issuer did not match",
        mutate: (callback: URL): void => {
          callback.searchParams.append("iss", "https://accounts.google.com");
          callback.searchParams.append("iss", "https://accounts.google.com");
        },
      },
      {
        expected: "unsupported fields",
        mutate: (callback: URL): void => {
          callback.searchParams.set("unexpected", "value");
        },
      },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      const fixture = workspace();
      let callbackResponse: Promise<Response> | undefined;
      try {
        const login = loginGoogleOAuth({
          clientFile: fixture.clientFile,
          openBrowser: false,
          onAuthorizationUrl: (authorizationUrl) => {
            const authorization = new URL(authorizationUrl);
            const redirectUri = authorization.searchParams.get("redirect_uri");
            const state = authorization.searchParams.get("state");
            if (redirectUri === null || state === null) {
              throw new Error("authorization URL omitted its loopback binding");
            }
            const callback = new URL(redirectUri);
            callback.searchParams.set("code", "authorization-code-value");
            callback.searchParams.set("state", state);
            scenario.mutate(callback);
            callbackResponse = fetch(callback);
          },
        }, {
          randomBytes: (size) => new Uint8Array(size).fill(13 + index),
          fetch: async () => {
            throw new Error("invalid callback must fail before token exchange");
          },
        });

        await expect(login).rejects.toThrow(scenario.expected);
        if (callbackResponse === undefined) throw new Error("loopback callback was not requested");
        expect((await callbackResponse).status).toBe(400);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("refreshes an expired managed token once and preserves its durable grant", async () => {
    const fixture = workspace();
    try {
      const login = await loginGoogleOAuth({ clientFile: fixture.clientFile }, {
        now: () => new Date("2026-08-14T12:00:00.000Z"),
        randomBytes: (size) => new Uint8Array(size).fill(9),
        authorize: async () => ({
          code: "authorization-code-value",
          redirectUri: "http://127.0.0.1:43124/oauth2/callback",
        }),
        fetch: async (input) => {
          const host = new URL(input instanceof Request ? input.url : input.toString()).hostname;
          return host === "oauth2.googleapis.com"
            ? jsonResponse({
                access_token: "private-expiring-access-token",
                expires_in: 60,
                refresh_token: "private-durable-refresh-token",
                scope: GOOGLE_GMAIL_READ_SCOPES.join(" "),
                token_type: "Bearer",
              })
            : jsonResponse({ emailAddress: "person@example.com" });
        },
      });
      const { auth } = installManagedGoogleOAuth(
        "gmail-main",
        login,
        fixture.environment,
      );
      let refreshes = 0;
      const token = await resolveOAuthToken(auth, {
        environment: fixture.environment,
        now: new Date("2026-08-14T12:02:00.000Z"),
        minimumValidityMs: 30_000,
        fetch: async (_input, init) => {
          refreshes += 1;
          const form = new URLSearchParams(String(init?.body));
          expect(form.get("grant_type")).toBe("refresh_token");
          expect(form.get("refresh_token")).toBe("private-durable-refresh-token");
          return jsonResponse({
            access_token: "private-refreshed-access-token",
            expires_in: 3600,
            token_type: "Bearer",
          });
        },
      });
      expect(refreshes).toBe(1);
      expect(token).toEqual({
        accessToken: "private-refreshed-access-token",
        expiresAt: "2026-08-14T13:02:00.000Z",
      });
      const stored = readFileSync(auth.path, "utf8");
      expect(stored).toContain("private-refreshed-access-token");
      expect(stored).toContain("private-durable-refresh-token");

      const reused = await resolveOAuthToken(auth, {
        environment: fixture.environment,
        now: new Date("2026-08-14T12:03:00.000Z"),
        minimumValidityMs: 30_000,
        fetch: async () => {
          throw new Error("refresh should not run");
        },
      });
      expect(reused.accessToken).toBe("private-refreshed-access-token");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
