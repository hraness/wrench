import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import type { WrenchAuth } from "../auth";
import {
  PreservedBrowserArtifactsError,
  type BrowserSession,
  type CreateBrowserSessionOptions,
} from "../browser";
import {
  createLinkedInProfileBrowserTransport,
  LinkedInProfileBrowserFailure,
  LinkedInProfileBrowserResponseRejectedError,
} from "./linkedin-web-profile-browser";

const MEMBER_ID = "123456789";
const PROFILE_URL = "https://www.linkedin.com/in/0thernet/";
const ORGANIZATION_URL = "https://www.linkedin.com/company/hraness/";

const auth = {
  schemaVersion: 1,
  id: "linkedin-profile-browser-test",
  kind: "browser-profile",
  profile: "Persistent LinkedIn",
  browserExecutable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  trustUnfilteredEgress: true,
  subject: `urn:li:fsd_profile:${MEMBER_ID}`,
} as const satisfies WrenchAuth;

const cookieSourceAuth = {
  schemaVersion: 1,
  id: "linkedin-profile-cookie-source-test",
  kind: "cookie-source",
  source: "chrome",
  profile: "Profile 9",
  subject: `urn:li:fsd_profile:${MEMBER_ID}`,
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
  expect(source).toContain('redirect:"error"');
  expect(source).toContain('crypto.subtle.digest("SHA-256",body)');
  const match = /const input=(\{.*?\});if\(location\.origin/u.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("test browser evaluation omitted its fixed request binding");
  }
  return JSON.parse(match[1]) as BrowserReadBinding;
}

function browserBodyRecord(
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
      origin: options.origin ?? "https://www.linkedin.com/feed/",
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

function browserRejectionRecord(
  status: number,
  contentType: string,
): Readonly<Record<string, unknown>> {
  return {
    success: true,
    result: {
      origin: "https://www.linkedin.com/feed/",
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

function identityResponse(): string {
  return JSON.stringify({
    data: {
      plainId: MEMBER_ID,
      "*miniProfile": "urn:li:fs_miniProfile:profile-fixture",
    },
    included: [{
      entityUrn: "urn:li:fs_miniProfile:profile-fixture",
      objectUrn: `urn:li:member:${MEMBER_ID}`,
      publicIdentifier: "0thernet",
    }],
  });
}

describe("LinkedIn profile stats contained-browser transport", () => {
  test("performs one exact personal identity, profile, and connections sequence with a serialization-safe body bound", async () => {
    const escapeHeavyHtml = `<html>${'"\\\n'.repeat(300)}</html>`;
    expect(Buffer.byteLength(escapeHeavyHtml)).toBeLessThanOrEqual(1_024);
    const requests: BrowserReadBinding[] = [];
    const bootstrapCommands: string[][] = [];
    const evalOutputBounds: number[] = [];
    let sessionOptions: CreateBrowserSessionOptions | null = null;
    let closed = false;
    let cleaned = false;
    const session: BrowserSession = {
      runBatch: (commands, _timeoutMs, maxOutputBytes) => {
        const command = commands[0];
        if (command?.[0] === "open" || command?.[0] === "wait") {
          bootstrapCommands.push([...command]);
          return Promise.resolve([{ success: true, result: {} }]);
        }
        if (command?.[0] !== "eval" || command[1] === undefined) {
          throw new Error("unexpected LinkedIn profile browser command");
        }
        evalOutputBounds.push(maxOutputBytes);
        const binding = requestBinding(command[1]);
        requests.push(binding);
        if (binding.path === "/voyager/api/me") {
          return Promise.resolve([browserBodyRecord(
            identityResponse(),
            "application/vnd.linkedin.normalized+json+2.1",
          )]);
        }
        if (binding.path === "/in/0thernet/") {
          return Promise.resolve([browserBodyRecord(escapeHeavyHtml, "text/html")]);
        }
        if (binding.path === "/mynetwork/invite-connect/connections/") {
          return Promise.resolve([browserBodyRecord(
            "<html><h1>4,877 connections</h1></html>",
            "text/html",
          )]);
        }
        throw new Error(`unexpected LinkedIn profile browser path ${binding.path}`);
      },
      close: () => {
        closed = true;
        return Promise.resolve();
      },
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    };
    const transport = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      dependencies: {
        createBrowserSession: (manifest, receivedAuth, options) => {
          expect(manifest).toMatchObject({ id: "linkedin-profile-runtime" });
          expect(receivedAuth).toEqual(auth);
          sessionOptions = options;
          return Promise.resolve(session);
        },
      },
    });

    expect(await transport.currentIdentityResponse()).toEqual(
      JSON.parse(identityResponse()),
    );
    expect(await transport.readProfileHtml(PROFILE_URL)).toBe(escapeHeavyHtml);
    expect(await transport.readConnectionsHtml(PROFILE_URL)).toContain(
      "4,877 connections",
    );
    await transport.close();

    expect(requests).toEqual([
      {
        kind: "json",
        maxBytes: 1_024,
        path: "/voyager/api/me",
        referrer: "https://www.linkedin.com/feed/",
      },
      {
        kind: "html",
        maxBytes: 1_024,
        path: "/in/0thernet/",
        referrer: "https://www.linkedin.com/feed/",
      },
      {
        kind: "html",
        maxBytes: 1_024,
        path: "/mynetwork/invite-connect/connections/",
        referrer: PROFILE_URL,
      },
    ]);
    expect(bootstrapCommands).toEqual([]);
    const encodedBound = Math.ceil(1_024 / 3) * 4 + 64 * 1_024;
    expect(sessionOptions).not.toBeNull();
    expect((sessionOptions as unknown as CreateBrowserSessionOptions).maxOutputBytes)
      .toBe(encodedBound);
    expect(evalOutputBounds).toEqual([encodedBound, encodedBound, encodedBound]);
    expect(closed).toBeTrue();
    expect(cleaned).toBeTrue();
  });

  test("allows only one company page after the exact current-member request", async () => {
    const paths: string[] = [];
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open" || command?.[0] === "wait") {
          return Promise.resolve([{ success: true, result: {} }]);
        }
        if (command?.[0] !== "eval" || command[1] === undefined) {
          throw new Error("unexpected LinkedIn organization browser command");
        }
        const binding = requestBinding(command[1]);
        paths.push(binding.path);
        return Promise.resolve([binding.kind === "json"
          ? browserBodyRecord(identityResponse(), "application/json")
          : browserBodyRecord("<html>6 followers</html>", "text/html")]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    await transport.currentIdentityResponse();
    expect(await transport.readOrganizationHtml(ORGANIZATION_URL)).toBe(
      "<html>6 followers</html>",
    );
    expect(paths).toEqual(["/voyager/api/me", "/company/hraness/"]);
    await expect(transport.readProfileHtml(PROFILE_URL)).rejects.toThrow(
      "out of order",
    );
    await transport.close();
  });

  test("rejects cross-origin evaluations and each corrupt body-integrity field", async () => {
    const body = identityResponse();
    const fixtures = [
      {
        name: "cross-origin evaluation",
        response: browserBodyRecord(body, "application/json", {
          origin: "https://example.com/feed/",
        }),
        category: "response-envelope",
        message: "LinkedIn stats browser returned a malformed evaluation envelope",
      },
      {
        name: "invalid base64",
        response: browserBodyRecord(body, "application/json", {
          bodyBase64: "not-base64!",
        }),
        category: "body-envelope",
        message: "LinkedIn stats browser body envelope changed shape",
      },
      {
        name: "wrong byte count",
        response: browserBodyRecord(body, "application/json", {
          bodyBytes: Buffer.byteLength(body) + 1,
        }),
        category: "body-envelope",
        message: "LinkedIn stats browser body envelope failed integrity verification",
      },
      {
        name: "wrong SHA-256",
        response: browserBodyRecord(body, "application/json", {
          bodySha256: "0".repeat(64),
        }),
        category: "body-envelope",
        message: "LinkedIn stats browser body envelope failed integrity verification",
      },
      {
        name: "impossible JSON authwall",
        response: browserBodyRecord(body, "application/json", {
          authWall: true,
        }),
        category: "response-envelope",
        message: "LinkedIn stats browser returned a malformed authwall envelope",
      },
      {
        name: "body-bearing provider rejection",
        response: browserBodyRecord("private-token", "text/html", {
          status: 401,
        }),
        category: "response-envelope",
        message: "LinkedIn stats browser returned a malformed rejection envelope",
      },
    ] as const;

    for (const fixture of fixtures) {
      const session: BrowserSession = {
        runBatch: (commands) => {
          const command = commands[0];
          if (command?.[0] === "open" || command?.[0] === "wait") {
            return Promise.resolve([{ success: true, result: {} }]);
          }
          if (command?.[0] !== "eval") {
            throw new Error(`unexpected command in ${fixture.name} fixture`);
          }
          return Promise.resolve([fixture.response]);
        },
        close: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      };
      const transport = await createLinkedInProfileBrowserTransport(auth, {
        timeoutMs: 1_000,
        maxOutputBytes: 2 * 1024 * 1024,
        dependencies: { createBrowserSession: () => Promise.resolve(session) },
      });
      const error = await transport.currentIdentityResponse().then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(LinkedInProfileBrowserFailure);
      expect(error).toMatchObject({
        category: fixture.category,
        message: fixture.message,
      });
      await transport.close();
    }
  });

  test("never retries post-cookie context, origin, provider, or authwall failures", async () => {
    let evaluations = 0;
    let mode: "authwall" | "content-type" | "context" | "fetch" | "origin" | "session-cookie" | "status" = "context";
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] !== "eval" || command[1] === undefined) {
          throw new Error("unexpected LinkedIn retry browser command");
        }
        requestBinding(command[1]);
        evaluations += 1;
        if (mode === "context" && evaluations === 1) {
          return Promise.reject(new Error("Cannot find default execution context"));
        }
        if (mode === "origin") {
          return Promise.reject(new Error("unexpected LinkedIn origin"));
        }
        if (mode === "session-cookie") {
          return Promise.reject(new Error(
            "agent-browser batch failed with exit code 1: missing LinkedIn browser CSRF cookie",
          ));
        }
        if (mode === "fetch") {
          return Promise.reject(new Error(
            "agent-browser batch failed with exit code 1: page.evaluate: TypeError: Failed to fetch",
          ));
        }
        if (mode === "status") {
          return Promise.resolve([browserRejectionRecord(401, "text/html")]);
        }
        if (mode === "content-type") {
          return Promise.resolve([browserRejectionRecord(200, "text/html")]);
        }
        if (mode === "authwall" && evaluations > 1) {
          return Promise.resolve([browserBodyRecord("private-token", "text/html", {
            authWall: true,
          })]);
        }
        return Promise.resolve([browserBodyRecord(identityResponse(), "application/json")]);
      },
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };

    const first = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    const contextError = await first.currentIdentityResponse()
      .then(() => null, (error: unknown) => error);
    expect(contextError).toBeInstanceOf(LinkedInProfileBrowserFailure);
    expect(contextError).toMatchObject({ category: "execution-context" });
    expect(evaluations).toBe(1);
    await first.close();

    mode = "origin";
    evaluations = 0;
    const originRejected = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    const originError = await originRejected.currentIdentityResponse()
      .then(() => null, (error: unknown) => error);
    expect(originError).toBeInstanceOf(LinkedInProfileBrowserFailure);
    expect(originError).toMatchObject({ category: "bootstrap" });
    expect(evaluations).toBe(1);
    await originRejected.close();

    mode = "status";
    evaluations = 0;
    const rejected = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    const statusError = await rejected.currentIdentityResponse()
      .then(() => null, (error: unknown) => error);
    expect(statusError).toBeInstanceOf(LinkedInProfileBrowserResponseRejectedError);
    expect(statusError).toMatchObject({ status: 401, contentType: "text/html" });
    expect(String(statusError)).not.toContain("private-token");
    expect(evaluations).toBe(1);
    await rejected.close();

    mode = "content-type";
    evaluations = 0;
    const wrongContentType = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    const contentTypeError = await wrongContentType.currentIdentityResponse()
      .then(() => null, (error: unknown) => error);
    expect(contentTypeError).toBeInstanceOf(LinkedInProfileBrowserResponseRejectedError);
    expect(contentTypeError).toMatchObject({ status: 200, contentType: "text/html" });
    expect(String(contentTypeError)).not.toContain("private-token");
    expect(evaluations).toBe(1);
    await wrongContentType.close();

    for (const item of [
      { mode: "session-cookie", category: "session-cookie" },
      { mode: "fetch", category: "provider-fetch" },
    ] as const) {
      mode = item.mode;
      evaluations = 0;
      const commandRejected = await createLinkedInProfileBrowserTransport(auth, {
        timeoutMs: 1_000,
        maxOutputBytes: 2 * 1024 * 1024,
        dependencies: { createBrowserSession: () => Promise.resolve(session) },
      });
      const commandError = await commandRejected.currentIdentityResponse()
        .then(() => null, (error: unknown) => error);
      expect(commandError).toBeInstanceOf(LinkedInProfileBrowserFailure);
      expect(commandError).toMatchObject({ category: item.category });
      expect(evaluations).toBe(1);
      await commandRejected.close();
    }

    mode = "authwall";
    evaluations = 0;
    const authwall = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    await authwall.currentIdentityResponse();
    const authwallMessage = await authwall.readProfileHtml(PROFILE_URL)
      .then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(authwallMessage).toBe(
      "LinkedIn stats browser reached the signed-out authwall",
    );
    expect(authwallMessage).not.toContain("private-token");
    expect(evaluations).toBe(2);
    await authwall.close();
  });

  test("rewrites only the auth-kind-specific initial batch before command execution", async () => {
    type CommandRunner = NonNullable<
      NonNullable<CreateBrowserSessionOptions["dependencies"]>["runCommand"]
    >;
    type CommandOptions = Parameters<CommandRunner>[1];
    const calls: {
      readonly command: readonly string[];
      readonly options: CommandOptions;
    }[] = [];
    const execute: CommandRunner = (command, options) => {
      calls.push({ command, options });
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: "{}" });
    };
    const createWrapped = async (browserAuth: WrenchAuth): Promise<{
      readonly close: () => Promise<void>;
      readonly run: CommandRunner;
    }> => {
      let capturedOptions: CreateBrowserSessionOptions | null = null;
      const session: BrowserSession = {
        runBatch: () => Promise.resolve([{ success: true, result: {} }]),
        close: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      };
      const transport = await createLinkedInProfileBrowserTransport(browserAuth, {
        timeoutMs: 1_000,
        maxOutputBytes: 2 * 1024 * 1024,
        dependencies: {
          createBrowserSession: (_manifest, _auth, options) => {
            capturedOptions = options;
            return Promise.resolve(session);
          },
          runCommand: execute,
        },
      });
      const run = (capturedOptions as unknown as CreateBrowserSessionOptions)
        .dependencies?.runCommand;
      if (run === undefined) throw new Error("missing LinkedIn command wrapper");
      return { close: transport.close, run };
    };
    const command = Object.freeze(["agent-browser", "batch", "--bail", "--json"]);
    const baseOptions = Object.freeze({
      cwd: "/tmp/linkedin-profile-browser-test",
      environment: Object.freeze({ TEST_MODE: "contained" }),
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    });

    const profile = await createWrapped(auth);
    const exactBlankOptions = Object.freeze({
      ...baseOptions,
      stdin: '[["open","about:blank"]]',
    });
    await profile.run(command, exactBlankOptions);
    expect(calls[0]?.command).toBe(command);
    expect(calls[0]?.options).toEqual({
      ...exactBlankOptions,
      stdin: '[["open","https://www.linkedin.com/robots.txt"]]',
    });
    expect(calls[0]?.options).not.toBe(exactBlankOptions);

    await profile.run(command, exactBlankOptions);
    expect(calls[1]?.options).toBe(exactBlankOptions);
    await profile.close();

    const exact = await createWrapped(cookieSourceAuth);
    const exactRootOptions = Object.freeze({
      ...baseOptions,
      stdin: '[["open","https://www.linkedin.com"]]',
    });
    await exact.run(command, exactRootOptions);
    expect(calls[2]?.command).toBe(command);
    expect(calls[2]?.options).toEqual({
      ...exactRootOptions,
      stdin: '[["open","https://www.linkedin.com/robots.txt"]]',
    });
    expect(calls[2]?.options).not.toBe(exactRootOptions);

    await exact.run(command, exactRootOptions);
    expect(calls[3]?.options).toBe(exactRootOptions);
    const cookieOptions = Object.freeze({
      ...baseOptions,
      stdin: '[["cookies","set","li_at","fixture","--url","https://www.linkedin.com"]]',
    });
    const evaluationOptions = Object.freeze({
      ...baseOptions,
      stdin: '[["eval","readOnlyIdentityFixture()"]]',
    });
    await exact.run(command, cookieOptions);
    await exact.run(command, evaluationOptions);
    expect(calls[4]?.options).toBe(cookieOptions);
    expect(calls[5]?.options).toBe(evaluationOptions);
    await exact.close();

    const nonExact = await createWrapped(cookieSourceAuth);
    const whitespaceVariant = Object.freeze({
      ...baseOptions,
      stdin: '[[ "open", "https://www.linkedin.com" ]]',
    });
    await nonExact.run(command, whitespaceVariant);
    expect(calls[6]?.options).toBe(whitespaceVariant);
    await nonExact.close();
  });

  test("retries only the cookie-source root and never the browser-profile blank navigation", async () => {
    let capturedOptions: CreateBrowserSessionOptions | null = null;
    let commandCalls = 0;
    let settlements = 0;
    const contextFailure = {
      exitCode: 1,
      stderr: "",
      stdout: "Failed to install browser network controls: CDP error (Runtime.evaluate): Cannot find default execution context",
    } as const;
    const commandRunner = () => {
      commandCalls += 1;
      return Promise.resolve(commandCalls === 1 || commandCalls === 3
        ? contextFailure
        : { exitCode: 0, stderr: "", stdout: "{}" });
    };
    const session: BrowserSession = {
      runBatch: () => Promise.resolve([{ success: true, result: {} }]),
      close: () => Promise.resolve(),
      cleanup: () => Promise.resolve(),
    };
    const transport = await createLinkedInProfileBrowserTransport(cookieSourceAuth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: {
        createBrowserSession: (_manifest, _auth, options) => {
          capturedOptions = options;
          return Promise.resolve(session);
        },
        runCommand: commandRunner,
        settleContext: () => {
          settlements += 1;
          return Promise.resolve();
        },
      },
    });
    expect(capturedOptions).not.toBeNull();
    const wrapped = (capturedOptions as unknown as CreateBrowserSessionOptions)
      .dependencies?.runCommand;
    if (wrapped === undefined) throw new Error("missing LinkedIn command wrapper");
    const commandOptions = {
      cwd: "/tmp/linkedin-profile-browser-test",
      environment: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      stdin: JSON.stringify([["open", "https://www.linkedin.com"]]),
    } as const;
    expect(await wrapped(["agent-browser", "batch"], commandOptions))
      .toEqual({ exitCode: 0, stderr: "", stdout: "{}" });
    expect(commandCalls).toBe(2);
    expect(settlements).toBe(1);

    expect(await wrapped(["agent-browser", "batch"], {
      ...commandOptions,
      stdin: JSON.stringify([["eval", "readOnlyIdentityFixture()"]]),
    })).toEqual(contextFailure);
    expect(commandCalls).toBe(3);
    expect(settlements).toBe(1);
    await transport.close();

    let profileOptions: CreateBrowserSessionOptions | null = null;
    let profileCalls = 0;
    let profileSettlements = 0;
    const profileTransport = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: {
        createBrowserSession: (_manifest, _auth, options) => {
          profileOptions = options;
          return Promise.resolve(session);
        },
        runCommand: () => {
          profileCalls += 1;
          return Promise.resolve(contextFailure);
        },
        settleContext: () => {
          profileSettlements += 1;
          return Promise.resolve();
        },
      },
    });
    const profileWrapped = (profileOptions as unknown as CreateBrowserSessionOptions)
      .dependencies?.runCommand;
    if (profileWrapped === undefined) throw new Error("missing LinkedIn profile command wrapper");
    expect(await profileWrapped(["agent-browser", "batch"], {
      ...commandOptions,
      stdin: JSON.stringify([["open", "about:blank"]]),
    })).toEqual(contextFailure);
    expect(profileCalls).toBe(1);
    expect(profileSettlements).toBe(0);
    await profileTransport.close();
  });

  test("fails cleanup closed when private browser artifact removal is not verified", async () => {
    const session: BrowserSession = {
      runBatch: () => Promise.resolve([{ success: true, result: {} }]),
      close: () => Promise.resolve(),
      cleanup: () => Promise.reject(new Error("private cleanup fixture")),
      recoveryHandle: "session=private-fixture",
    };
    const transport = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    await expect(transport.close()).rejects.toBeInstanceOf(
      PreservedBrowserArtifactsError,
    );
  });
});
