import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import {
  PreservedBrowserArtifactsError,
  type BrowserSession,
  type CreateBrowserSessionOptions,
} from "../browser";
import { OperationDeadline } from "../operation-deadline";
import {
  createInstagramProfileBrowserTransport,
  InstagramProfileBrowserFailure,
  InstagramProfileBrowserResponseRejectedError,
} from "./instagram-web-profile-browser";

const VIEWER_ID = "123456789";
const PROFILE = "hranessdotcom";
const PROFILE_PATH =
  "/api/v1/users/web_profile_info/?username=hranessdotcom";

const profileAuth = {
  schemaVersion: 1,
  id: "instagram-profile-browser-test",
  kind: "browser-profile",
  profile: "Persistent Instagram",
  browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  trustUnfilteredEgress: true,
  subject: `instagram:${VIEWER_ID}`,
} as const satisfies WrenchAuth;

const cookieSourceAuth = {
  schemaVersion: 1,
  id: "instagram-cookie-source-test",
  kind: "cookie-source",
  source: "chrome",
  profile: "Profile 9",
  subject: `instagram:${VIEWER_ID}`,
} as const satisfies WrenchAuth;

const cookiesFileAuth = {
  schemaVersion: 1,
  id: "instagram-cookies-file-test",
  kind: "cookies-file",
  path: "/private/instagram-cookies.txt",
  subject: `instagram:${VIEWER_ID}`,
} as const satisfies WrenchAuth;

type BrowserReadBinding = {
  readonly kind: "html" | "json";
  readonly maxBytes: number;
  readonly path: string;
  readonly referrer: string;
};

const evaluatorSyntax = new Bun.Transpiler({ loader: "js" });

function requestBinding(source: string): BrowserReadBinding {
  expect(() => evaluatorSyntax.transformSync(source)).not.toThrow();
  expect(source).toContain('cache:"no-store"');
  expect(source).toContain('credentials:"include"');
  expect(source).toContain('redirect:"error"');
  expect(source).toContain('referrerPolicy:"same-origin"');
  expect(source).toContain('crypto.subtle.digest("SHA-256",body)');
  expect(source).toContain('"x-ig-app-id":"936619743392459"');
  const match = /const input=(\{.*?\});if\(location\.origin/u.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("test browser evaluation omitted its fixed request binding");
  }
  return JSON.parse(match[1]) as BrowserReadBinding;
}

function bodyRecord(
  body: string,
  contentType: string,
  options: {
    readonly authWall?: boolean;
    readonly bodyBase64?: string;
    readonly bodyBytes?: number;
    readonly bodySha256?: string;
    readonly origin?: string;
    readonly status?: number;
  } = {},
): Readonly<Record<string, unknown>> {
  const authWall = options.authWall ?? false;
  const bytes = Buffer.from(body, "utf8");
  return {
    success: true,
    result: {
      origin: options.origin ?? "https://www.instagram.com/robots.txt",
      result: {
        authWall,
        bodyBase64: authWall
          ? null
          : options.bodyBase64 ?? bytes.toString("base64"),
        bodyBytes: authWall ? 0 : options.bodyBytes ?? bytes.byteLength,
        bodySha256: authWall
          ? null
          : options.bodySha256
            ?? createHash("sha256").update(bytes).digest("hex"),
        contentType,
        status: options.status ?? 200,
      },
    },
  };
}

function rejectionRecord(
  status: number,
  contentType: string,
): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: {
      origin: "https://www.instagram.com/robots.txt",
      result: {
        authWall: false,
        bodyBase64: null,
        bodyBytes: 0,
        bodySha256: null,
        contentType,
        status,
      },
    },
  };
}

function viewerHtml(): string {
  return `<html><script type="application/json">{"viewerId":"${VIEWER_ID}"}</script></html>`;
}

function profileResponse(): Readonly<Record<string, unknown>> {
  return {
    data: {
      user: {
        id: VIEWER_ID,
        username: PROFILE,
        edge_followed_by: { count: 547 },
        edge_follow: { count: 1_041 },
        edge_owner_to_timeline_media: { count: 77 },
      },
    },
  };
}

function sessionFor(
  responses: readonly Readonly<Record<string, unknown>>[],
  bindings: BrowserReadBinding[] = [],
  lifecycle: { closed: boolean; cleaned: boolean } = {
    closed: false,
    cleaned: false,
  },
): BrowserSession {
  let cursor = 0;
  return {
    runBatch: (commands) => {
      const command = commands[0];
      if (command?.[0] !== "eval" || command[1] === undefined) {
        throw new Error("unexpected Instagram profile browser command");
      }
      bindings.push(requestBinding(command[1]));
      const response = responses[cursor];
      cursor += 1;
      if (response === undefined) throw new Error("unexpected extra evaluation");
      return Promise.resolve([response]);
    },
    close: () => {
      lifecycle.closed = true;
      return Promise.resolve();
    },
    cleanup: () => {
      lifecycle.cleaned = true;
      return Promise.resolve();
    },
  };
}

describe("Instagram profile stats contained-browser transport", () => {
  test("performs one exact viewer and target sequence with fixed first-party bindings", async () => {
    const bindings: BrowserReadBinding[] = [];
    const lifecycle = { closed: false, cleaned: false };
    let receivedOptions: CreateBrowserSessionOptions | null = null;
    const profileJson = JSON.stringify(profileResponse());
    const transport = await createInstagramProfileBrowserTransport(profileAuth, {
      timeoutMs: 2_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: {
        createBrowserSession: (manifest, auth, options) => {
          expect(manifest).toEqual({
            schemaVersion: 4,
            id: "instagram-profile-runtime",
            version: "1.0.0",
            displayName: "Instagram profile stats runtime",
            surfaceId: "instagram",
            origins: ["https://www.instagram.com"],
            browserDomains: ["www.instagram.com"],
            operations: {},
          });
          expect(auth).toBe(profileAuth);
          receivedOptions = options;
          return Promise.resolve(sessionFor([
            bodyRecord(viewerHtml(), "text/html"),
            bodyRecord(profileJson, "application/json"),
          ], bindings, lifecycle));
        },
      },
    });

    expect(await transport.readCurrentViewerHtml()).toBe(viewerHtml());
    expect(await transport.readProfileJson(PROFILE)).toEqual(profileResponse());
    await transport.close();

    expect(bindings).toEqual([
      {
        kind: "html",
        maxBytes: 2 * 1024 * 1024,
        path: "/",
        referrer: "https://www.instagram.com/",
      },
      {
        kind: "json",
        maxBytes: 2 * 1024 * 1024,
        path: PROFILE_PATH,
        referrer: "https://www.instagram.com/hranessdotcom/",
      },
    ]);
    expect(receivedOptions).not.toBeNull();
    expect((receivedOptions as unknown as CreateBrowserSessionOptions)
      .allowCodeOwnedEvaluation).toBeTrue();
    expect((receivedOptions as unknown as CreateBrowserSessionOptions).headed)
      .toBeTrue();
    expect(lifecycle).toEqual({ closed: true, cleaned: true });
  });

  test("accepts each browser-session auth realm and rejects non-browser realms before startup", async () => {
    for (const auth of [profileAuth, cookieSourceAuth, cookiesFileAuth]) {
      const receivedAuth: WrenchAuth[] = [];
      const transport = await createInstagramProfileBrowserTransport(auth, {
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        dependencies: {
          createBrowserSession: (_manifest, candidate) => {
            receivedAuth.push(candidate);
            return Promise.resolve(sessionFor([]));
          },
        },
      });
      expect(receivedAuth).toEqual([auth]);
      await transport.close();
    }

    const oauthAuth = {
      schemaVersion: 1,
      id: "instagram-oauth-test",
      kind: "oauth-token-file",
      provider: "instagram",
      path: "/private/token.json",
      scopes: [],
    } as const satisfies WrenchAuth;
    await expect(createInstagramProfileBrowserTransport(oauthAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      dependencies: {
        createBrowserSession: () => {
          throw new Error("must not start");
        },
      },
    })).rejects.toThrow("requires browser-session or cookie auth");
  });

  test("rewrites only the exact initial realm navigation and never retries it", async () => {
    type CommandRunner = NonNullable<
      NonNullable<CreateBrowserSessionOptions["dependencies"]>["runCommand"]
    >;
    type CommandOptions = Parameters<CommandRunner>[1];
    const calls: CommandOptions[] = [];
    let capturedOptions: CreateBrowserSessionOptions | null = null;
    const transport = await createInstagramProfileBrowserTransport(profileAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      dependencies: {
        createBrowserSession: (_manifest, _auth, options) => {
          capturedOptions = options;
          return Promise.resolve(sessionFor([]));
        },
        runCommand: (_command, options) => {
          calls.push(options);
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "{}" });
        },
      },
    });
    const wrapped = (capturedOptions as unknown as CreateBrowserSessionOptions)
      .dependencies?.runCommand;
    if (wrapped === undefined) throw new Error("missing Instagram command wrapper");
    const base = {
      cwd: "/tmp/instagram-profile-browser-test",
      environment: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    } as const;
    const blank = { ...base, stdin: '[["open","about:blank"]]' };
    await wrapped(["agent-browser", "batch"], blank);
    expect(calls[0]).toEqual({
      ...blank,
      stdin: '[["open","https://www.instagram.com/robots.txt"]]',
    });
    await wrapped(["agent-browser", "batch"], blank);
    expect(calls[1]).toBe(blank);
    expect(calls).toHaveLength(2);
    await transport.close();

    let cookieOptions: CreateBrowserSessionOptions | null = null;
    const cookieTransport = await createInstagramProfileBrowserTransport(
      cookieSourceAuth,
      {
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        dependencies: {
          createBrowserSession: (_manifest, _auth, options) => {
            cookieOptions = options;
            return Promise.resolve(sessionFor([]));
          },
          runCommand: (_command, options) => {
            calls.push(options);
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "{}" });
          },
        },
      },
    );
    const cookieWrapped = (cookieOptions as unknown as CreateBrowserSessionOptions)
      .dependencies?.runCommand;
    if (cookieWrapped === undefined) throw new Error("missing cookie command wrapper");
    const root = { ...base, stdin: '[["open","https://www.instagram.com"]]' };
    await cookieWrapped(["agent-browser", "batch"], root);
    expect(calls[2]).toEqual({
      ...root,
      stdin: '[["open","https://www.instagram.com/robots.txt"]]',
    });
    expect(calls).toHaveLength(3);
    await cookieTransport.close();
  });

  test("projects throttle and authentication rejections without response bodies", async () => {
    for (const item of [
      { status: 429, contentType: "application/json" },
      { status: 401, contentType: "application/json" },
      { status: 403, contentType: "text/html" },
    ]) {
      const transport = await createInstagramProfileBrowserTransport(profileAuth, {
        timeoutMs: 1_000,
        maxOutputBytes: 2 * 1024 * 1024,
        dependencies: {
          createBrowserSession: () => Promise.resolve(sessionFor([
            bodyRecord(viewerHtml(), "text/html"),
            rejectionRecord(item.status, item.contentType),
          ])),
        },
      });
      await transport.readCurrentViewerHtml();
      const error = await transport.readProfileJson(PROFILE).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(InstagramProfileBrowserResponseRejectedError);
      expect(error).toMatchObject(item);
      expect(String(error)).not.toContain("private");
      await expect(transport.readProfileJson(PROFILE)).rejects.toThrow(
        "out of order",
      );
      await transport.close();
    }
  });

  test("rejects malformed envelopes, cross-origin results, and body-integrity drift", async () => {
    const body = viewerHtml();
    const fixtures = [
      {
        response: bodyRecord(body, "text/html", {
          origin: "https://example.com/",
        }),
        category: "response-envelope",
      },
      {
        response: bodyRecord(body, "text/html", { bodyBase64: "not-base64!" }),
        category: "body-envelope",
      },
      {
        response: bodyRecord(body, "text/html", {
          bodyBytes: Buffer.byteLength(body) + 1,
        }),
        category: "body-envelope",
      },
      {
        response: bodyRecord(body, "text/html", {
          bodySha256: "0".repeat(64),
        }),
        category: "body-envelope",
      },
      {
        response: {
          success: true,
          result: {
            origin: "https://www.instagram.com/",
            result: { unexpected: true },
          },
        },
        category: "response-envelope",
      },
    ] as const;

    for (const fixture of fixtures) {
      const transport = await createInstagramProfileBrowserTransport(profileAuth, {
        timeoutMs: 1_000,
        maxOutputBytes: 2 * 1024 * 1024,
        dependencies: {
          createBrowserSession: () => Promise.resolve(sessionFor([
            fixture.response,
          ])),
        },
      });
      const error = await transport.readCurrentViewerHtml().then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(InstagramProfileBrowserFailure);
      expect(error).toMatchObject({ category: fixture.category });
      await expect(transport.readCurrentViewerHtml()).rejects.toThrow(
        "out of order",
      );
      await transport.close();
    }
  });

  test("rejects authwall HTML, invalid JSON, target escape, and route escape", async () => {
    const authwall = await createInstagramProfileBrowserTransport(profileAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: {
        createBrowserSession: () => Promise.resolve(sessionFor([
          bodyRecord("<form action='/accounts/login/'>private</form>", "text/html", {
            authWall: true,
          }),
        ])),
      },
    });
    await expect(authwall.readCurrentViewerHtml()).rejects.toMatchObject({
      category: "authwall",
    });
    await authwall.close();

    const invalidJson = await createInstagramProfileBrowserTransport(profileAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: {
        createBrowserSession: () => Promise.resolve(sessionFor([
          bodyRecord(viewerHtml(), "text/html"),
          bodyRecord("not-json", "application/json"),
        ])),
      },
    });
    await invalidJson.readCurrentViewerHtml();
    await expect(invalidJson.readProfileJson(PROFILE)).rejects.toMatchObject({
      category: "profile-json",
    });
    await invalidJson.close();

    const targetEscape = await createInstagramProfileBrowserTransport(profileAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: {
        createBrowserSession: () => Promise.resolve(sessionFor([
          bodyRecord(viewerHtml(), "text/html"),
        ])),
      },
    });
    await targetEscape.readCurrentViewerHtml();
    await expect(targetEscape.readProfileJson("../other"))
      .rejects.toThrow("canonical lowercase handle");
    await targetEscape.close();

    const routeEscape = await createInstagramProfileBrowserTransport(profileAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: {
        createBrowserSession: () => Promise.resolve({
          runBatch: () => Promise.reject(new Error(
            "Instagram profile browser response escaped its exact route",
          )),
          close: () => Promise.resolve(),
          cleanup: () => Promise.resolve(),
        }),
      },
    });
    await expect(routeEscape.readCurrentViewerHtml()).rejects.toMatchObject({
      category: "response-envelope",
    });
    await routeEscape.close();
  });

  test("classifies command, context, origin, fetch, and output failures once", async () => {
    for (const item of [
      {
        error: new Error("Cannot find default execution context"),
        category: "execution-context",
      },
      {
        error: new Error("unexpected Instagram origin"),
        category: "bootstrap",
      },
      {
        error: new Error("page.evaluate: TypeError: Failed to fetch"),
        category: "provider-fetch",
      },
      {
        error: new Error("response exceeded its reviewed byte bound"),
        category: "output-bound",
      },
      {
        error: new Error("private command failure"),
        category: "browser-command",
      },
    ] as const) {
      let calls = 0;
      const transport = await createInstagramProfileBrowserTransport(profileAuth, {
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        dependencies: {
          createBrowserSession: () => Promise.resolve({
            runBatch: () => {
              calls += 1;
              return Promise.reject(item.error);
            },
            close: () => Promise.resolve(),
            cleanup: () => Promise.resolve(),
          }),
        },
      });
      await expect(transport.readCurrentViewerHtml()).rejects.toMatchObject({
        category: item.category,
      });
      expect(calls).toBe(1);
      await expect(transport.readCurrentViewerHtml()).rejects.toThrow(
        "out of order",
      );
      expect(calls).toBe(1);
      await transport.close();
    }
  });

  test("preserves startup and command deadline state before classification", async () => {
    for (const failure of ["cancelled", "timed-out"] as const) {
      const deadline = (): OperationDeadline => {
        if (failure === "timed-out") return new OperationDeadline(0);
        const controller = new AbortController();
        controller.abort("private cancellation reason");
        return new OperationDeadline(1_000, { signal: controller.signal });
      };
      const startup = deadline();
      try {
        await expect(createInstagramProfileBrowserTransport(profileAuth, {
          timeoutMs: 1_000,
          maxOutputBytes: 1_024,
          operationDeadline: startup,
          dependencies: {
            createBrowserSession: () => Promise.reject(
              new Error("private startup failure"),
            ),
          },
        })).rejects.toMatchObject({ failure });
      } finally {
        startup.dispose();
      }

      const command = deadline();
      try {
        const transport = await createInstagramProfileBrowserTransport(
          profileAuth,
          {
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
            operationDeadline: command,
            dependencies: {
              createBrowserSession: () => Promise.resolve({
                runBatch: () => Promise.reject(
                  new Error("private command failure"),
                ),
                close: () => Promise.resolve(),
                cleanup: () => Promise.resolve(),
              }),
            },
          },
        );
        await expect(transport.readCurrentViewerHtml()).rejects.toMatchObject({
          failure,
        });
        await transport.close();
      } finally {
        command.dispose();
      }
    }
  });

  test("propagates operation deadline and cleanup publication to session setup", async () => {
    const deadline = new OperationDeadline(5_000);
    const publishCleanupResource = Object.assign(
      () => undefined,
      {
        markBrowserCleanupQuiescent: () => undefined,
        markBrowserCleanupRootRemoved: () => undefined,
      },
    );
    let options: CreateBrowserSessionOptions | null = null;
    try {
      const transport = await createInstagramProfileBrowserTransport(profileAuth, {
        timeoutMs: 2_000,
        maxOutputBytes: 1_024,
        operationDeadline: deadline,
        publishCleanupResource,
        dependencies: {
          createBrowserSession: (_manifest, _auth, received) => {
            options = received;
            return Promise.resolve(sessionFor([]));
          },
        },
      });
      expect((options as unknown as CreateBrowserSessionOptions).operationDeadline)
        .toBe(deadline);
      expect((options as unknown as CreateBrowserSessionOptions)
        .publishCleanupResource).toBe(publishCleanupResource);
      await transport.close();
    } finally {
      deadline.dispose();
    }
  });

  test("fails cleanup closed and preserves a recovery handle", async () => {
    const transport = await createInstagramProfileBrowserTransport(profileAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      dependencies: {
        createBrowserSession: () => Promise.resolve({
          runBatch: () => Promise.resolve([]),
          close: () => Promise.resolve(),
          cleanup: () => Promise.reject(new Error("private cleanup fixture")),
          recoveryHandle: "session=private-fixture",
        }),
      },
    });
    const error = await transport.close().then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PreservedBrowserArtifactsError);
    expect(error).toMatchObject({ recoveryHandle: "session=private-fixture" });
    expect(String(error)).not.toContain("private cleanup fixture");
  });
});
