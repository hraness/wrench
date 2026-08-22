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
    expect(bootstrapCommands).toEqual([
      ["open", "https://www.linkedin.com/robots.txt"],
      ["wait", "2000"],
    ]);
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
        message: "LinkedIn stats browser returned a malformed evaluation envelope",
      },
      {
        name: "invalid base64",
        response: browserBodyRecord(body, "application/json", {
          bodyBase64: "not-base64!",
        }),
        message: "LinkedIn stats browser body envelope changed shape",
      },
      {
        name: "wrong byte count",
        response: browserBodyRecord(body, "application/json", {
          bodyBytes: Buffer.byteLength(body) + 1,
        }),
        message: "LinkedIn stats browser body envelope failed integrity verification",
      },
      {
        name: "wrong SHA-256",
        response: browserBodyRecord(body, "application/json", {
          bodySha256: "0".repeat(64),
        }),
        message: "LinkedIn stats browser body envelope failed integrity verification",
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
      const message = await transport.currentIdentityResponse().then(
        () => "resolved",
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      expect(message).toBe(fixture.message);
      await transport.close();
    }
  });

  test("retries one context-settlement failure but never retries a provider rejection or authwall", async () => {
    let evaluations = 0;
    let contextWaits = 0;
    let mode: "context" | "status" | "authwall" = "context";
    const session: BrowserSession = {
      runBatch: (commands) => {
        const command = commands[0];
        if (command?.[0] === "open") {
          return Promise.resolve([{ success: true, result: {} }]);
        }
        if (command?.[0] === "wait") {
          if (command[1] === "2000" && evaluations > 0) contextWaits += 1;
          return Promise.resolve([{ success: true, result: {} }]);
        }
        if (command?.[0] !== "eval" || command[1] === undefined) {
          throw new Error("unexpected LinkedIn retry browser command");
        }
        requestBinding(command[1]);
        evaluations += 1;
        if (mode === "context" && evaluations === 1) {
          return Promise.reject(new Error("no default execution context"));
        }
        if (mode === "status") {
          return Promise.resolve([browserBodyRecord("private-token", "text/html", {
            status: 401,
          })]);
        }
        if (mode === "authwall") {
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
    await first.currentIdentityResponse();
    expect(evaluations).toBe(2);
    expect(contextWaits).toBe(1);
    await first.close();

    mode = "status";
    evaluations = 0;
    const rejected = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    const statusMessage = await rejected.currentIdentityResponse()
      .then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(statusMessage).toBe(
      "LinkedIn stats browser request returned an unreviewed status",
    );
    expect(statusMessage).not.toContain("private-token");
    expect(evaluations).toBe(1);
    await rejected.close();

    mode = "authwall";
    evaluations = 0;
    const authwall = await createLinkedInProfileBrowserTransport(auth, {
      timeoutMs: 1_000,
      maxOutputBytes: 2 * 1024 * 1024,
      dependencies: { createBrowserSession: () => Promise.resolve(session) },
    });
    const authwallMessage = await authwall.currentIdentityResponse()
      .then(() => "resolved", (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(authwallMessage).toBe(
      "LinkedIn stats browser reached the signed-out authwall",
    );
    expect(authwallMessage).not.toContain("private-token");
    expect(evaluations).toBe(1);
    await authwall.close();
  });

  test("rewrites only the exact initial LinkedIn root batch before command execution", async () => {
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
    const createWrapped = async (): Promise<{
      readonly close: () => Promise<void>;
      readonly run: CommandRunner;
    }> => {
      let capturedOptions: CreateBrowserSessionOptions | null = null;
      const session: BrowserSession = {
        runBatch: () => Promise.resolve([{ success: true, result: {} }]),
        close: () => Promise.resolve(),
        cleanup: () => Promise.resolve(),
      };
      const transport = await createLinkedInProfileBrowserTransport(auth, {
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

    const exact = await createWrapped();
    const exactRootOptions = Object.freeze({
      ...baseOptions,
      stdin: '[["open","https://www.linkedin.com"]]',
    });
    await exact.run(command, exactRootOptions);
    expect(calls[0]?.command).toBe(command);
    expect(calls[0]?.options).toEqual({
      ...exactRootOptions,
      stdin: '[["open","https://www.linkedin.com/robots.txt"]]',
    });
    expect(calls[0]?.options).not.toBe(exactRootOptions);

    await exact.run(command, exactRootOptions);
    expect(calls[1]?.options).toBe(exactRootOptions);
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
    expect(calls[2]?.options).toBe(cookieOptions);
    expect(calls[3]?.options).toBe(evaluationOptions);
    await exact.close();

    const nonExact = await createWrapped();
    const whitespaceVariant = Object.freeze({
      ...baseOptions,
      stdin: '[[ "open", "https://www.linkedin.com" ]]',
    });
    await nonExact.run(command, whitespaceVariant);
    expect(calls[4]?.options).toBe(whitespaceVariant);
    await nonExact.close();
  });

  test("retries only one fixed pre-identity command after agent-browser reports a missing default context", async () => {
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
    const transport = await createLinkedInProfileBrowserTransport(auth, {
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
      stdin: JSON.stringify([["wait", "2000"]]),
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
