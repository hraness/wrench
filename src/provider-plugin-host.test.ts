import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  renderPortableProviderPluginManifest,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginManifestV1,
  type VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  PortableProviderPluginHostError,
  observePortableProviderPluginHostProcessForTest,
  runPortableProviderPluginHost,
  type PortableProviderPluginCapabilityHost,
} from "./provider-plugin-host";
import {
  settlePortableProviderPluginCleanup,
} from "./provider-plugin-cleanup-barrier";
import type {
  PortablePluginCapabilityRequest,
  PortablePluginCapabilityResult,
} from "./provider-plugin-protocol";

const fixtureRuntime = `
import { createInterface } from "node:readline";

let hello = null;
let invocation = null;
let fileOutcome = null;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const capability = (requestId, request) => send({
  protocolVersion: 1,
  kind: "plugin.capability.request",
  invocationId: invocation.invocationId,
  requestId,
  request,
});
const result = (output, finalUrl = null) => send({
  protocolVersion: 1,
  kind: "plugin.result",
  invocationId: invocation.invocationId,
  output,
  finalUrl,
});

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    hello = message;
    send({
      protocolVersion: 1,
      kind: "plugin.ready",
      plugin: message.plugin,
    });
    continue;
  }
  if (message.kind === "host.invoke") {
    invocation = message;
    fileOutcome = null;
    const mode = message.input.mode;
    if (mode === "success") {
      result({ ok: true }, "https://www.example.com/feed");
    } else if (mode === "denied") {
      capability("state-1", { kind: "state.read", key: "private" });
    } else if (mode === "state-version") {
      capability("state-1", {
        kind: "state.read",
        key: "private",
        includeVersion: true,
      });
    } else if (
      mode === "session-http"
      || mode === "session-wrong-origin"
      || mode === "session-wrong-sink"
    ) {
      capability("session-1", { kind: "session.acquire", name: "cookie-jar" });
    } else if (
      mode === "dispatch"
      || mode === "exit-after-begin"
      || mode === "retry-after-write-failure"
    ) {
      capability("dispatch-1", { kind: "dispatch.begin", dispatchId: "messages.send" });
    } else if (mode === "file-dispatch") {
      capability("file-1", {
        kind: "file.read",
        handle: "scalar-file",
        offset: message.input.read_offset ?? 0,
        length: message.input.read_length ?? 4,
      });
    }
    continue;
  }
  if (
    message.kind === "host.capability.error"
    && (
      message.requestId === "state-1"
      || message.requestId === "http-1"
      || message.requestId === "file-1"
    )
  ) {
    if (message.requestId === "file-1") {
      fileOutcome = { denied: message.error.code };
      capability("dispatch-1", {
        kind: "dispatch.begin",
        dispatchId: "messages.send",
      });
      continue;
    }
    result({ denied: message.error.code });
    continue;
  }
  if (message.kind !== "host.capability.result") continue;
  if (message.requestId === "file-1") {
    fileOutcome = {
      eof: message.result.eof,
      fileRead: message.result.data,
    };
    capability("dispatch-1", {
      kind: "dispatch.begin",
      dispatchId: "messages.send",
    });
  } else if (message.requestId === "session-1") {
    capability("http-1", {
      kind: "http.request",
      method: "GET",
      url: invocation.input.mode === "session-wrong-origin"
        ? "https://other.example.com/api/feed"
        : "https://www.example.com/api/feed",
      headers: [],
      credentials: [{
        handle: message.result.materialHandle,
        sink: invocation.input.mode === "session-wrong-sink"
          ? { kind: "header", name: "authorization" }
          : { kind: "cookie-jar" },
      }],
      body: { kind: "none" },
      redirect: "error",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
    });
  } else if (message.requestId === "http-1") {
    result(
      { status: message.result.status },
      message.result.finalUrl,
    );
  } else if (message.requestId === "dispatch-1") {
    if (invocation.input.mode === "exit-after-begin") process.exit(91);
    const write = (requestId) => capability(requestId, {
      kind: "http.request",
      method: "POST",
      url: "https://www.example.com/api/messages",
      headers: [],
      credentials: [],
      body: {
        kind: "utf8",
        mediaType: "application/json",
        text: "{\\"text\\":\\"hello\\"}",
      },
      redirect: "error",
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      dispatchHandle: message.result.dispatchHandle,
    });
    write("http-write-1");
    if (invocation.input.mode === "retry-after-write-failure") {
      write("http-write-2");
    }
  } else if (
    message.requestId === "http-write-1"
    || message.requestId === "http-write-2"
  ) {
    capability("verify-1", {
      kind: "dispatch.verify",
      dispatchHandle: message.result.dispatchHandle ?? "dispatch-handle",
      proof: { status: message.result.status },
    });
  } else if (message.requestId === "verify-1") {
    result(
      fileOutcome ?? { submitted: true },
      "https://www.example.com/messages/1",
    );
  }
}
`.trimStart();

const hardenedLaunchRuntime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let invocationId = null;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({
      protocolVersion: 1,
      kind: "plugin.ready",
      plugin: message.plugin,
    });
    continue;
  }
  if (message.kind === "host.invoke") {
    invocationId = message.invocationId;
    send({
      protocolVersion: 1,
      kind: "plugin.result",
      invocationId,
      output: {
        envLoaded: process.env.WRENCH_PORTABLE_PLUGIN_ENV_POISON === "loaded",
        preloadLoaded: globalThis.__wrenchPortablePluginPreloadPoison === true,
      },
      finalUrl: null,
    });
  }
}
`.trimStart();

const sigtermIgnoringRuntime = `
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`.trimStart();

const dataReadingRuntime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({
      protocolVersion: 1,
      kind: "plugin.ready",
      plugin: message.plugin,
    });
    continue;
  }
  if (message.kind === "host.invoke") {
    send({
      protocolVersion: 1,
      kind: "plugin.result",
      invocationId: message.invocationId,
      output: {
        fixture: (await Bun.file("fixtures/value.txt").text()).trim(),
      },
      finalUrl: null,
    });
  }
}
`.trimStart();

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type PackageOptions = {
  readonly operation?: "read" | "write";
  readonly fileInputs?: boolean;
  readonly capabilities?: Partial<
    PortableProviderPluginManifestV1["capabilities"]
  >;
  readonly runtime?: string;
  readonly dataFiles?: readonly {
    readonly path: string;
    readonly contents: string;
  }[];
};

function createFixturePackage(
  parent: string,
  options: PackageOptions = {},
): VerifiedPortableProviderPluginPackage {
  const root = join(parent, "package");
  const runtime = Buffer.from(options.runtime ?? fixtureRuntime, "utf8");
  const dataFiles = options.dataFiles ?? [];
  mkdirSync(join(root, "dist"), { recursive: true, mode: 0o700 });
  const writeOperation = options.operation === "write";
  const fileInputs = options.fileInputs === true;
  const manifest: PortableProviderPluginManifestV1 = {
    schemaVersion: 1,
    hostApiVersion: 1,
    id: "example-web",
    version: "1.0.0",
    displayName: "Example web",
    runtime: {
      kind: "bun-js",
      entrypoint: "dist/plugin.mjs",
    },
    provenance: { kind: "local" },
    capabilities: {
      networkOrigins: ["https://www.example.com"],
      planFiles: fileInputs ? "read" : "none",
      state: "none",
      sessionMaterial: ["cookie-jar"],
      ...options.capabilities,
    },
    bindings: [{
      transport: "web-session-api",
      adapterId: "example-web",
      surfaceId: "example",
      origin: "https://www.example.com",
      authKinds: ["cookies-file"],
      subject: {
        format: "bounded example account identifier",
        kind: "opaque-token",
        probe: {
          operation: "profiles.read",
          contractVersion: 1,
        },
      },
      operations: [
        {
          name: writeOperation ? "messages.send" : "feeds.read",
          contractVersion: 1,
          timeoutMs: 3_000,
          maxOutputBytes: 4_096,
          state: "observed",
          risk: writeOperation ? "R3" : "R1",
          dispatch: writeOperation ? "single" : "none",
          sideEffect: writeOperation ? "sends one message" : "none",
          idempotency: writeOperation ? "local-at-most-once" : "none",
          dedupeWindowMs: writeOperation ? 60_000 : 0,
          input: {
            properties: {
              ...(fileInputs
                ? {
                  attachment: {
                    type: "file" as const,
                    description: "One bounded fixture attachment.",
                    maxBytes: 4,
                    mediaTypes: ["text/plain"],
                  },
                  attachments: {
                    type: "array" as const,
                    description: "Bounded fixture attachments.",
                    items: {
                      type: "file" as const,
                      description: "One bounded fixture attachment.",
                      maxBytes: 8,
                      mediaTypes: ["image/png", "text/plain"],
                    },
                    minItems: 1,
                    maxItems: 2,
                  },
                  read_length: {
                    type: "number" as const,
                    description: "Fixture file read length.",
                    minimum: 1,
                    maximum: 256 * 1024,
                  },
                  read_offset: {
                    type: "number" as const,
                    description: "Fixture file read offset.",
                    minimum: 0,
                    maximum: 2_147_483_647,
                  },
                }
                : {}),
              mode: {
                type: "string",
                description: "Deterministic fixture mode.",
                enum: writeOperation
                  ? [
                      "dispatch",
                      "exit-after-begin",
                      ...(fileInputs ? ["file-dispatch"] : []),
                      "retry-after-write-failure",
                    ]
                  : [
                      "denied",
                      "session-http",
                      "session-wrong-origin",
                      "session-wrong-sink",
                      "state-version",
                      "success",
                    ],
              },
            },
            required: fileInputs
              ? ["attachment", "attachments", "mode"]
              : ["mode"],
          },
          implementation: writeOperation
            ? "Sends one fixture message."
            : "Reads one fixture feed.",
        },
        ...[
          {
              name: "profiles.read",
              contractVersion: 1,
              timeoutMs: 3_000,
              maxOutputBytes: 4_096,
              state: "observed" as const,
              risk: "R1" as const,
              dispatch: "none" as const,
              sideEffect: "none",
              idempotency: "none" as const,
              dedupeWindowMs: 0,
              input: { properties: {}, required: [] },
              implementation: "Reads the current fixture profile.",
          },
        ],
      ],
    }],
    files: [
      {
        path: "dist/plugin.mjs",
        kind: "runtime" as const,
        bytes: runtime.byteLength,
        sha256: digest(runtime),
      },
      ...dataFiles.map((file) => {
        const bytes = Buffer.from(file.contents, "utf8");
        return {
          path: file.path,
          kind: "data" as const,
          bytes: bytes.byteLength,
          sha256: digest(bytes),
        };
      }),
    ].sort((left, right) => {
      if (left.path < right.path) return -1;
      if (left.path > right.path) return 1;
      return 0;
    }),
  };
  writeFileSync(join(root, "dist", "plugin.mjs"), runtime);
  for (const file of dataFiles) {
    const path = join(root, ...file.path.split("/"));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.contents);
  }
  writeFileSync(
    join(root, "wrench-plugin.json"),
    renderPortableProviderPluginManifest(manifest),
  );
  return verifyPortableProviderPluginPackageDirectory(root);
}

function withPackage(
  options: PackageOptions,
  callback: (
    packageValue: VerifiedPortableProviderPluginPackage,
  ) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wrench-portable-plugin-host-"));
  return callback(createFixturePackage(root, options))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function invocation(
  packageValue: VerifiedPortableProviderPluginPackage,
  mode: string,
  plannedDispatchIds: readonly string[] = [],
): Parameters<typeof runPortableProviderPluginHost>[0] {
  const operation = packageValue.manifest.bindings[0]?.operations[0];
  if (operation === undefined) throw new Error("fixture operation is absent");
  return {
    package: packageValue,
    route: {
      transport: "web-session-api",
      surfaceId: "example",
      operation: operation.name,
      contractVersion: operation.contractVersion,
    },
    input: { mode },
    auth: {
      kind: "cookies-file",
      handle: "auth-1",
      subject: "example:user:1",
    },
    files: [],
    // Success fixtures exercise process launch and staging, which can be
    // delayed substantially by unrelated repository checks on shared hosts.
    timeoutMs: 90_000,
    hostVersion: "1.0.0",
    plannedDispatchIds,
  };
}

function fileInvocation(
  packageValue: VerifiedPortableProviderPluginPackage,
  read: {
    readonly length?: number;
    readonly offset?: number;
  } = {},
): Parameters<typeof runPortableProviderPluginHost>[0] {
  return {
    ...invocation(packageValue, "file-dispatch", ["messages.send"]),
    input: {
      attachment: "scalar-file",
      attachments: ["array-file-1", "array-file-2"],
      mode: "file-dispatch",
      ...(read.length === undefined ? {} : { read_length: read.length }),
      ...(read.offset === undefined ? {} : { read_offset: read.offset }),
    },
    files: [
      {
        input: "attachment",
        handle: "scalar-file",
        bytes: 4,
        mediaType: "text/plain",
        sha256: "1".repeat(64),
      },
      {
        input: "attachments",
        handle: "array-file-1",
        bytes: 8,
        mediaType: "image/png",
        sha256: "2".repeat(64),
      },
      {
        input: "attachments",
        handle: "array-file-2",
        bytes: 3,
        mediaType: "text/plain; charset=utf-8",
        sha256: "3".repeat(64),
      },
    ],
  };
}

async function hostError(
  promise: Promise<unknown>,
): Promise<PortableProviderPluginHostError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PortableProviderPluginHostError);
    return error as PortableProviderPluginHostError;
  }
  throw new Error("expected portable host rejection");
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected portable host rejection");
}

function requireObservedExit(
  value: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  } | null,
): {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
} {
  if (value === null) throw new Error("portable child exit was not observed");
  return value;
}

async function terminateTestChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close").then(() => undefined);
  child.kill("SIGKILL");
  await closed;
}

function exactHandler(
  callback: (
    request: PortablePluginCapabilityRequest,
  ) => PortablePluginCapabilityResult,
): PortableProviderPluginCapabilityHost {
  return {
    handle: (request) => Promise.resolve(callback(request)),
  };
}

describe("portable provider plugin child-process host", () => {
  test("executes one exact relocated package and returns bounded JSON", async () => {
    await withPackage({}, async (packageValue) => {
      const result = await runPortableProviderPluginHost(
        invocation(packageValue, "success"),
      );
      expect(result).toEqual({
        output: { ok: true },
        finalUrl: "https://www.example.com/feed",
        dispatch: { planned: 0, started: 0, verified: 0 },
      });
    });
  });

  test("keeps serial admission on stdin across child-process finalization", async () => {
    await withPackage({}, async (packageValue) => {
      const stagedDirectories: string[] = [];
      let stopObserving = (): void => {};
      try {
        stopObserving = observePortableProviderPluginHostProcessForTest({
          staged: ({ cwd }) => stagedDirectories.push(cwd),
        });
        for (let index = 0; index < 16; index += 1) {
          Bun.gc(true);
          expect(await runPortableProviderPluginHost(
            invocation(packageValue, "success"),
          )).toMatchObject({
            output: { ok: true },
            dispatch: { planned: 0, started: 0, verified: 0 },
          });
        }
      } finally {
        stopObserving();
      }
      Bun.gc(true);
      expect(stagedDirectories).toHaveLength(16);
      expect(stagedDirectories.every((path) => !existsSync(path))).toBeTrue();
    });
  });

  test("executes the verified runtime bytes after its installed path is rewritten", async () => {
    await withPackage({}, async (packageValue) => {
      let stopObserving = (): void => {};
      try {
        stopObserving = observePortableProviderPluginHostProcessForTest({
          beforeSpawn: () => {
            writeFileSync(
              join(packageValue.root, "dist", "plugin.mjs"),
              "process.exit(97);\n",
            );
          },
        });
        const result = await runPortableProviderPluginHost(
          invocation(packageValue, "success"),
        );
        expect(result.output).toEqual({ ok: true });
      } finally {
        stopObserving();
      }
    });
  });

  test("reads verified data bytes after the installed data path is rewritten", async () => {
    await withPackage(
      {
        runtime: dataReadingRuntime,
        dataFiles: [{
          path: "fixtures/value.txt",
          contents: "verified fixture\n",
        }],
      },
      async (packageValue) => {
        let stopObserving = (): void => {};
        try {
          stopObserving = observePortableProviderPluginHostProcessForTest({
            beforeSpawn: () => {
              writeFileSync(
                join(packageValue.root, "fixtures", "value.txt"),
                "rewritten fixture\n",
              );
            },
          });
          const result = await runPortableProviderPluginHost(
            invocation(packageValue, "success"),
          );
          expect(result.output).toEqual({
            fixture: "verified fixture",
          });
        } finally {
          stopObserving();
        }
      },
    );
  });

  test("starts Bun with hardened flags and ignores late package config and env files", async () => {
    await withPackage(
      { runtime: hardenedLaunchRuntime },
      async (packageValue) => {
        let observedArgs: readonly string[] = [];
        let stopObserving = (): void => {};
        try {
          stopObserving = observePortableProviderPluginHostProcessForTest({
            beforeSpawn: ({ args, cwd }) => {
              observedArgs = args;
              expect(statSync(cwd).mode & 0o777).toBe(0o500);
              expect(
                statSync(join(cwd, "dist", "plugin.mjs")).mode & 0o777,
              ).toBe(0o400);
              writeFileSync(
                join(packageValue.root, ".env"),
                "WRENCH_PORTABLE_PLUGIN_ENV_POISON=loaded\n",
              );
              writeFileSync(
                join(packageValue.root, "preload.mjs"),
                "globalThis.__wrenchPortablePluginPreloadPoison = true;\n",
              );
              writeFileSync(
                join(packageValue.root, "bunfig.toml"),
                [
                  "[run]",
                  'preload = ["./preload.mjs"]',
                  "",
                ].join("\n"),
              );
            },
          });
          const result = await runPortableProviderPluginHost(
            invocation(packageValue, "success"),
          );
          expect(result.output).toEqual({
            envLoaded: false,
            preloadLoaded: false,
          });
          expect(observedArgs.slice(0, 4)).toEqual([
            "--no-env-file",
            "--no-install",
            "--no-macros",
            "--no-addons",
          ]);
          expect(observedArgs[4]).toBe("--config=/dev/null");
          expect(observedArgs[5]).toStartWith("--preload=");
          expect(observedArgs[6]).toBe("/dev/fd/3");
        } finally {
          stopObserving();
        }
      },
    );
  });

  test("denies an undeclared capability without calling the host seam", async () => {
    await withPackage({}, async (packageValue) => {
      let calls = 0;
      const result = await runPortableProviderPluginHost({
        ...invocation(packageValue, "denied"),
        capabilityHost: exactHandler(() => {
          calls += 1;
          return { kind: "state.read", found: false };
        }),
      });
      expect(result.output).toEqual({ denied: "CAPABILITY_DENIED" });
      expect(calls).toBe(0);
    });
  });

  test("rejects a state result whose version shape disagrees with its request", async () => {
    await withPackage({ capabilities: { state: "namespaced" } }, async (packageValue) => {
      let calls = 0;
      const result = await runPortableProviderPluginHost({
        ...invocation(packageValue, "state-version"),
        capabilityHost: exactHandler((request) => {
          calls += 1;
          expect(request).toMatchObject({
            kind: "state.read",
            includeVersion: true,
          });
          return { kind: "state.read", found: false };
        }),
      });
      expect(calls).toBe(1);
      expect(result.output).toEqual({ denied: "CAPABILITY_FAILED" });
    });
  });

  test("allows only declared session material in an exact-origin read", async () => {
    await withPackage({}, async (packageValue) => {
      const requests: string[] = [];
      const result = await runPortableProviderPluginHost({
        ...invocation(packageValue, "session-http"),
        capabilityHost: exactHandler((request) => {
          requests.push(request.kind);
          if (request.kind === "session.acquire") {
            return {
              kind: "session.acquire",
              materialHandle: "sealed-cookie-jar",
            };
          }
          if (request.kind === "http.request") {
            return {
              kind: "http.request",
              status: 200,
              headers: [],
              body: { kind: "utf8", text: "{\"items\":[]}" },
              finalUrl: "https://www.example.com/api/feed",
            };
          }
          throw new Error("unexpected capability");
        }),
      });
      expect(requests).toEqual(["session.acquire", "http.request"]);
      expect(result.output).toEqual({ status: 200 });
      expect(result.dispatch).toEqual({
        planned: 0,
        started: 0,
        verified: 0,
      });
    });
  });

  test("rejects HTTP capability results outside request-relative bounds", async () => {
    await withPackage({}, async (packageValue) => {
      const invalidResults = [
        {
          kind: "http.request" as const,
          status: 200,
          headers: [],
          body: { kind: "utf8" as const, text: "é".repeat(2_049) },
          finalUrl: "https://www.example.com/api/feed",
        },
        {
          kind: "http.request" as const,
          status: 200,
          headers: [],
          body: {
            kind: "base64" as const,
            data: Buffer.alloc(4_097).toString("base64"),
          },
          finalUrl: "https://www.example.com/api/feed",
        },
        {
          kind: "http.request" as const,
          status: 200,
          headers: [],
          body: { kind: "utf8" as const, text: "{}" },
          finalUrl: "https://www.example.com/api/other",
        },
      ];
      for (const invalidResult of invalidResults) {
        const result = await runPortableProviderPluginHost({
          ...invocation(packageValue, "session-http"),
          capabilityHost: exactHandler((request) => {
            if (request.kind === "session.acquire") {
              return {
                kind: "session.acquire",
                materialHandle: "sealed-cookie-jar",
              };
            }
            if (request.kind === "http.request") return invalidResult;
            throw new Error("unexpected capability");
          }),
        });
        expect(result.output).toEqual({ denied: "CAPABILITY_FAILED" });
      }
    });
  });

  test("binds scalar and array file inputs one-to-one before file access", async () => {
    await withPackage(
      { operation: "write", fileInputs: true },
      async (packageValue) => {
        const requests: string[] = [];
        const result = await runPortableProviderPluginHost({
          ...fileInvocation(packageValue),
          capabilityHost: exactHandler((request) => {
            requests.push(request.kind);
            if (request.kind === "file.read") {
              return {
                kind: "file.read",
                data: "ZGF0YQ==",
                eof: true,
              };
            }
            if (request.kind === "dispatch.begin") {
              return {
                kind: "dispatch.begin",
                dispatchHandle: "dispatch-handle",
              };
            }
            if (request.kind === "http.request") {
              return {
                kind: "http.request",
                status: 201,
                headers: [],
                body: { kind: "utf8", text: "{\"id\":\"1\"}" },
                finalUrl: "https://www.example.com/api/messages",
              };
            }
            if (request.kind === "dispatch.verify") {
              return { kind: "dispatch.verify", verified: true };
            }
            throw new Error("unexpected capability");
          }),
        });
        expect(requests).toEqual([
          "file.read",
          "dispatch.begin",
          "http.request",
          "dispatch.verify",
        ]);
        expect(result.output).toEqual({
          eof: true,
          fileRead: "ZGF0YQ==",
        });
      },
    );
  });

  test("rejects invalid file bindings and metadata before spawn", async () => {
    await withPackage(
      { operation: "write", fileInputs: true },
      async (packageValue) => {
        const valid = fileInvocation(packageValue);
        const files = [...valid.files];
        const scalar = files[0];
        if (scalar === undefined) throw new Error("file fixture is incomplete");
        const invalidInvocations = [
          { ...valid, files: files.slice(1) },
          {
            ...valid,
            files: [
              ...files,
              {
                ...scalar,
                handle: "extra-file",
                sha256: "4".repeat(64),
              },
            ],
          },
          { ...valid, files: [...files, scalar] },
          {
            ...valid,
            input: {
              ...valid.input,
              attachments: ["array-file-1", "array-file-1"],
            },
            files: files.slice(0, 2),
          },
          {
            ...valid,
            files: [{ ...scalar, input: "attachments" }, ...files.slice(1)],
          },
          {
            ...valid,
            files: [{ ...scalar, bytes: 5 }, ...files.slice(1)],
          },
          {
            ...valid,
            files: [
              { ...scalar, mediaType: "application/octet-stream" },
              ...files.slice(1),
            ],
          },
        ];
        let spawns = 0;
        const stopObserving =
          observePortableProviderPluginHostProcessForTest({
            beforeSpawn: () => {
              spawns += 1;
            },
          });
        try {
          for (const invalid of invalidInvocations) {
            expect(await rejectionMessage(
              runPortableProviderPluginHost(invalid),
            )).toContain("portable plugin invocation");
          }
        } finally {
          stopObserving();
        }
        expect(spawns).toBe(0);
      },
    );
  });

  test("binds file-read bounds and EOF to exact descriptor bytes", async () => {
    await withPackage(
      { operation: "write", fileInputs: true },
      async (packageValue) => {
        const cases = [
          {
            read: { length: 5 },
            fileResult: {
              kind: "file.read" as const,
              data: "Zml2ZSE=",
              eof: true,
            },
            expected: { denied: "CAPABILITY_FAILED" },
          },
          {
            read: { length: 5 },
            fileResult: {
              kind: "file.read" as const,
              data: "ZGF0YQ==",
              eof: true,
            },
            expected: { eof: true, fileRead: "ZGF0YQ==" },
          },
          {
            read: { length: 5 },
            fileResult: {
              kind: "file.read" as const,
              data: "ZGF0",
              eof: false,
            },
            expected: { eof: false, fileRead: "ZGF0" },
          },
          {
            read: { length: 5 },
            fileResult: { kind: "file.read" as const, data: "", eof: false },
            expected: { denied: "CAPABILITY_FAILED" },
          },
          {
            read: { length: 5 },
            fileResult: {
              kind: "file.read" as const,
              data: "ZGF0YQ==",
              eof: false,
            },
            expected: { denied: "CAPABILITY_FAILED" },
          },
          {
            read: { length: 5, offset: 4 },
            fileResult: { kind: "file.read" as const, data: "", eof: true },
            expected: { eof: true, fileRead: "" },
          },
          {
            read: { length: 5, offset: 5 },
            fileResult: { kind: "file.read" as const, data: "", eof: true },
            expected: { eof: true, fileRead: "" },
          },
          {
            read: { length: 5, offset: 5 },
            fileResult: { kind: "file.read" as const, data: "", eof: false },
            expected: { denied: "CAPABILITY_FAILED" },
          },
        ];
        for (const testCase of cases) {
          const result = await runPortableProviderPluginHost({
            ...fileInvocation(packageValue, testCase.read),
            capabilityHost: exactHandler((request) => {
              if (request.kind === "file.read") return testCase.fileResult;
              if (request.kind === "dispatch.begin") {
                return {
                  kind: "dispatch.begin",
                  dispatchHandle: "dispatch-handle",
                };
              }
              if (request.kind === "http.request") {
                return {
                  kind: "http.request",
                  status: 201,
                  headers: [],
                  body: { kind: "utf8", text: "{}" },
                  finalUrl: "https://www.example.com/api/messages",
                };
              }
              if (request.kind === "dispatch.verify") {
                return { kind: "dispatch.verify", verified: true };
              }
              throw new Error("unexpected capability");
            }),
          });
          expect(result.output).toEqual(testCase.expected);
          expect(result.dispatch).toEqual({
            planned: 1,
            started: 1,
            verified: 1,
          });
        }
      },
    );
  });

  test("denies a globally declared foreign origin and incompatible material sink", async () => {
    await withPackage({
      capabilities: {
        networkOrigins: [
          "https://other.example.com",
          "https://www.example.com",
        ],
      },
    }, async (packageValue) => {
      for (const mode of [
        "session-wrong-origin",
        "session-wrong-sink",
      ]) {
        const requests: string[] = [];
        const result = await runPortableProviderPluginHost({
          ...invocation(packageValue, mode),
          capabilityHost: exactHandler((request) => {
            requests.push(request.kind);
            if (request.kind !== "session.acquire") {
              throw new Error("route-invalid HTTP reached the host seam");
            }
            return {
              kind: "session.acquire",
              materialHandle: `sealed-${mode}`,
            };
          }),
        });
        expect(requests).toEqual(["session.acquire"]);
        expect(result.output).toEqual({ denied: "CAPABILITY_DENIED" });
      }
    });
  });

  test("requires the exact confirmed dispatch schedule around mutations", async () => {
    await withPackage({ operation: "write" }, async (packageValue) => {
      const requests: string[] = [];
      let dispatchHandle = "";
      const result = await runPortableProviderPluginHost({
        ...invocation(packageValue, "dispatch", ["messages.send"]),
        capabilityHost: exactHandler((request) => {
          requests.push(request.kind);
          if (request.kind === "dispatch.begin") {
            dispatchHandle = "dispatch-handle";
            return { kind: "dispatch.begin", dispatchHandle };
          }
          if (request.kind === "http.request") {
            expect(request.dispatchHandle).toBe(dispatchHandle);
            return {
              kind: "http.request",
              status: 201,
              headers: [],
              body: { kind: "utf8", text: "{\"id\":\"1\"}" },
              finalUrl: "https://www.example.com/api/messages",
            };
          }
          if (request.kind === "dispatch.verify") {
            expect(request.dispatchHandle).toBe(dispatchHandle);
            return { kind: "dispatch.verify", verified: true };
          }
          throw new Error("unexpected capability");
        }),
      });
      expect(requests).toEqual([
        "dispatch.begin",
        "http.request",
        "dispatch.verify",
      ]);
      expect(result.dispatch).toEqual({
        planned: 1,
        started: 1,
        verified: 1,
      });
    });
  });

  test("reports process death after begin as indeterminate and never retries", async () => {
    await withPackage({ operation: "write" }, async (packageValue) => {
      let beginCalls = 0;
      const error = await hostError(runPortableProviderPluginHost({
        ...invocation(
          packageValue,
          "exit-after-begin",
          ["messages.send"],
        ),
        capabilityHost: exactHandler((request) => {
          if (request.kind !== "dispatch.begin") {
            throw new Error("unexpected capability");
          }
          beginCalls += 1;
          return {
            kind: "dispatch.begin",
            dispatchHandle: "dispatch-handle",
          };
        }),
      }));
      expect(beginCalls).toBe(1);
      expect(error.dispatch).toEqual({
        planned: 1,
        started: 1,
        verified: 0,
      });
    });
  });

  test("poisons a dispatch before a failed mutation capability can be retried", async () => {
    await withPackage({ operation: "write" }, async (packageValue) => {
      let mutationCalls = 0;
      const error = await hostError(runPortableProviderPluginHost({
        ...invocation(
          packageValue,
          "retry-after-write-failure",
          ["messages.send"],
        ),
        capabilityHost: exactHandler((request) => {
          if (request.kind === "dispatch.begin") {
            return {
              kind: "dispatch.begin",
              dispatchHandle: "dispatch-handle",
            };
          }
          if (request.kind === "http.request") {
            mutationCalls += 1;
            if (mutationCalls === 1) {
              throw new Error(
                "simulated reset after the provider may have accepted the write",
              );
            }
            return {
              kind: "http.request",
              status: 201,
              headers: [],
              body: { kind: "utf8", text: "{\"id\":\"duplicate\"}" },
              finalUrl: "https://www.example.com/api/messages",
            };
          }
          if (request.kind === "dispatch.verify") {
            return { kind: "dispatch.verify", verified: true };
          }
          throw new Error("unexpected capability");
        }),
      }));
      expect(error.code).toBe("dispatch-indeterminate");
      expect(error.dispatch).toEqual({
        planned: 1,
        started: 1,
        verified: 0,
      });
      expect(mutationCalls).toBe(1);
    });
  });

  test("rejects input, route, package drift, and timeout before unsafe reuse", async () => {
    await withPackage({}, async (packageValue) => {
      expect(await rejectionMessage(runPortableProviderPluginHost({
        ...invocation(packageValue, "not-a-fixture-mode"),
      }))).toContain("invocation input is invalid");

      expect(await rejectionMessage(runPortableProviderPluginHost({
        ...invocation(packageValue, "success"),
        route: {
          transport: "web-session-api",
          surfaceId: "example",
          operation: "feeds.search",
          contractVersion: 1,
        },
      }))).toContain("route is not declared");

      const drifted: VerifiedPortableProviderPluginPackage = {
        ...packageValue,
        bundleSha256: "f".repeat(64),
      };
      expect(await rejectionMessage(runPortableProviderPluginHost({
        ...invocation(drifted, "success"),
      }))).toContain("changed after its verified snapshot");

      const hangingPackage = createFixturePackage(
        packageValue.root,
        {
          runtime: "process.stdin.resume();\n",
        },
      );
      const error = await hostError(runPortableProviderPluginHost({
        ...invocation(hangingPackage, "success"),
        timeoutMs: 100,
      }));
      expect(error.code).toBe("timeout");
      expect(error.dispatch).toEqual({
        planned: 0,
        started: 0,
        verified: 0,
      });
    });
  });

  test("escalates an expired SIGTERM-ignoring child to SIGKILL before settling", async () => {
    await withPackage(
      { runtime: sigtermIgnoringRuntime },
      async (packageValue) => {
        let observedExit: {
          readonly code: number | null;
          readonly signal: NodeJS.Signals | null;
        } | null = null;
        let stagedCwd = "";
        let stopObserving = (): void => {};
        try {
          stopObserving = observePortableProviderPluginHostProcessForTest({
            beforeSpawn: ({ cwd }) => {
              stagedCwd = cwd;
            },
            exit: (result) => {
              observedExit = result;
            },
          });
          const error = await hostError(runPortableProviderPluginHost({
            ...invocation(packageValue, "success"),
            timeoutMs: 150,
          }));
          expect(error.code).toBe("timeout");
          expect(requireObservedExit(observedExit)).toEqual({
            code: null,
            signal: "SIGKILL",
          });
          expect(stagedCwd).not.toBe("");
          expect(existsSync(stagedCwd)).toBeFalse();
        } finally {
          stopObserving();
        }
      },
    );
  });

  test("never reuses the child PID as a raw process-group signal target", async () => {
    const originalKill: typeof process.kill = process.kill.bind(process);
    const rawSignals: {
      readonly pid: number;
      readonly signal: number | NodeJS.Signals | undefined;
    }[] = [];
    try {
      process.kill = (
        pid: number,
        signal?: number | NodeJS.Signals,
      ): true => {
        if (signal !== 0) rawSignals.push({ pid, signal });
        return originalKill(pid, signal);
      };
      await withPackage(
        { runtime: sigtermIgnoringRuntime },
        async (packageValue) => {
          const error = await hostError(runPortableProviderPluginHost({
            ...invocation(packageValue, "success"),
            timeoutMs: 150,
          }));
          expect(error.code).toBe("timeout");
        },
      );
    } finally {
      process.kill = originalKill;
    }
    expect(rawSignals).toEqual([]);
  });

  test("fails cleanup closed without signaling a PID reused after descendant inspection", async () => {
    if (process.platform === "win32") return;
    const sentinel = spawn(
      process.execPath,
      ["--eval", "setInterval(() => undefined, 1_000);"],
      { stdio: "ignore" },
    );
    const sentinelPid = sentinel.pid;
    if (sentinelPid === undefined) {
      await terminateTestChild(sentinel);
      throw new Error("sentinel process has no PID");
    }
    const originalKill: typeof process.kill = process.kill.bind(process);
    const rawSignals: {
      readonly pid: number;
      readonly signal: number | NodeJS.Signals | undefined;
    }[] = [];
    let stopObserving = (): void => {};
    try {
      process.kill = (
        pid: number,
        signal?: number | NodeJS.Signals,
      ): true => {
        if (signal !== 0) rawSignals.push({ pid, signal });
        return originalKill(pid, signal);
      };
      stopObserving = observePortableProviderPluginHostProcessForTest({
        descendantProcessIds: () => [sentinelPid],
      });
      await withPackage({}, async (packageValue) => {
        const message = await rejectionMessage(
          settlePortableProviderPluginCleanup(
            () => runPortableProviderPluginHost(
              invocation(packageValue, "success"),
            ),
          ),
        );
        expect(message).toContain("cleanup could not be verified");
      });
      expect(rawSignals).toEqual([]);
      expect(sentinel.exitCode).toBeNull();
      expect(sentinel.signalCode).toBeNull();
    } finally {
      stopObserving();
      process.kill = originalKill;
      await terminateTestChild(sentinel);
    }
  });

  test("proves rollback for an ordinary staging failure", async () => {
    await withPackage({}, async (packageValue) => {
      let stagedCwd = "";
      let stopObserving = (): void => {};
      try {
        stopObserving = observePortableProviderPluginHostProcessForTest({
          staged: ({ cwd }) => {
            stagedCwd = cwd;
            throw new Error("simulated ordinary staging failure");
          },
        });
        const outcome = await settlePortableProviderPluginCleanup(
          () => runPortableProviderPluginHost(
            invocation(packageValue, "success"),
          ),
        );
        expect(outcome.status).toBe("rejected");
        expect(stagedCwd).not.toBe("");
        expect(existsSync(stagedCwd)).toBeFalse();
      } finally {
        stopObserving();
      }
    });
  });

  test("terminates an admission-gated child when setup throws after spawn", async () => {
    await withPackage({}, async (packageValue) => {
      let stagedCwd = "";
      let observedExit: {
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      } | null = null;
      let stopObserving = (): void => {};
      try {
        stopObserving = observePortableProviderPluginHostProcessForTest({
          staged: ({ cwd }) => {
            stagedCwd = cwd;
          },
          beforeParentDescriptorRelease: () => {
            throw new Error("simulated parent descriptor release failure");
          },
          exit: (result) => {
            observedExit = result;
          },
        });
        const outcome = await settlePortableProviderPluginCleanup(
          () => runPortableProviderPluginHost(
            invocation(packageValue, "success"),
          ),
        );
        expect(outcome.status).toBe("rejected");
        if (outcome.status !== "rejected") {
          throw new Error("expected setup failure");
        }
        expect(outcome.reason).toBeInstanceOf(
          PortableProviderPluginHostError,
        );
        expect(
          (outcome.reason as PortableProviderPluginHostError).code,
        ).toBe("host-failed");
        expect(requireObservedExit(observedExit).signal).not.toBeNull();
        expect(stagedCwd).not.toBe("");
        expect(existsSync(stagedCwd)).toBeFalse();
      } finally {
        stopObserving();
      }
    });
  });

  test("rejects statically bound process-creation builtins before admission", async () => {
    if (process.platform === "win32") return;
    const attempts = [
      {
        label: "child_process",
        source: (marker: string) => `
import { spawn } from "node:child_process";
spawn(
  "/bin/sh",
  ["-c", ${JSON.stringify(
    `printf 'escaped\\n' > ${JSON.stringify(marker)}`,
  )}],
  { detached: true, stdio: "ignore" },
).unref();
process.stdin.resume();
`,
      },
      {
        label: "worker_threads",
        source: (marker: string) => `
import { Worker } from "node:worker_threads";
new Worker(
  ${JSON.stringify(
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(
      marker,
    )}, "escaped\\n");`,
  )},
  { eval: true },
);
process.stdin.resume();
`,
      },
      {
        label: "cluster",
        source: (marker: string) => `
import cluster from "node:cluster";
cluster.setupPrimary({
  exec: "/bin/sh",
  args: ["-c", ${JSON.stringify(
    `printf 'escaped\\n' > ${JSON.stringify(marker)}`,
  )}],
  silent: true,
});
cluster.fork();
process.stdin.resume();
`,
      },
    ] as const;
    for (const attempt of attempts) {
      const markerRoot = mkdtempSync(
        join(tmpdir(), `wrench-portable-static-${attempt.label}-`),
      );
      const marker = join(markerRoot, "escaped.txt");
      try {
        expect(await rejectionMessage(
          Promise.resolve().then(() =>
            createFixturePackage(markerRoot, {
              runtime: attempt.source(marker).trimStart(),
            })
          ),
        )).toContain("imports unsupported module");
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        expect(existsSync(marker)).toBeFalse();
      } finally {
        rmSync(markerRoot, { recursive: true, force: true });
      }
    }
  });

  test("denies ambient Bun subprocess creation before it can escape containment", async () => {
    if (process.platform === "win32") return;
    const markerRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-grandchild-marker-"),
    );
    const marker = join(markerRoot, "survived.txt");
    const runtime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({ protocolVersion: 1, kind: "plugin.ready", plugin: message.plugin });
    continue;
  }
  if (message.kind === "host.invoke") {
    let subprocessDenied = false;
    try {
      Bun.spawn([
        "/bin/sh",
        "-c",
        ${JSON.stringify(
          `trap '' TERM; sleep 0.8; printf 'survived\\n' > ${JSON.stringify(marker)}`,
        )},
      ], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      subprocessDenied = true;
    }
    send({
      protocolVersion: 1,
      kind: "plugin.result",
      invocationId: message.invocationId,
      output: { subprocessDenied },
      finalUrl: null,
    });
  }
}
`.trimStart();
    try {
      await withPackage({ runtime }, async (packageValue) => {
        const result = await runPortableProviderPluginHost(
          invocation(packageValue, "success"),
        );
        expect(result.output).toEqual({ subprocessDenied: true });
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      expect(existsSync(marker)).toBeFalse();
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  test("denies Bun FFI process creation before native code can write a marker", async () => {
    if (process.platform !== "darwin") return;
    const markerRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-ffi-marker-"),
    );
    const marker = join(markerRoot, "ffi.txt");
    const command = [
      "printf 'escaped\\n' >",
      JSON.stringify(marker),
    ].join(" ");
    const runtime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({ protocolVersion: 1, kind: "plugin.ready", plugin: message.plugin });
    continue;
  }
  if (message.kind !== "host.invoke") continue;
  let ffiDenied = false;
  try {
    const library = Bun.FFI.dlopen("/usr/lib/libSystem.B.dylib", {
      system: { args: ["cstring"], returns: "int" },
    });
    const command = Buffer.from(${JSON.stringify(`${command}\0`)});
    library.symbols.system(Bun.FFI.ptr(command));
  } catch {
    ffiDenied = true;
  }
  send({
    protocolVersion: 1,
    kind: "plugin.result",
    invocationId: message.invocationId,
    output: { ffiDenied },
    finalUrl: null,
  });
}
`.trimStart();
    try {
      await withPackage({ runtime }, async (packageValue) => {
        const result = await runPortableProviderPluginHost(
          invocation(packageValue, "success"),
        );
        expect(result.output).toEqual({ ffiDenied: true });
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(existsSync(marker)).toBeFalse();
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  test("denies the global Worker escape path before worker code can write a marker", async () => {
    if (process.platform === "win32") return;
    const markerRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-worker-marker-"),
    );
    const marker = join(markerRoot, "worker.txt");
    const workerSource = [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, "escaped\\n");`,
    ].join("\n");
    const workerUrl = `data:text/javascript,${
      encodeURIComponent(workerSource)
    }`;
    const runtime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({ protocolVersion: 1, kind: "plugin.ready", plugin: message.plugin });
    continue;
  }
  if (message.kind !== "host.invoke") continue;
  let workerDenied = false;
  try {
    new Worker(${JSON.stringify(workerUrl)});
  } catch {
    workerDenied = true;
  }
  send({
    protocolVersion: 1,
    kind: "plugin.result",
    invocationId: message.invocationId,
    output: { workerDenied },
    finalUrl: null,
  });
}
`.trimStart();
    try {
      await withPackage({ runtime }, async (packageValue) => {
        const result = await runPortableProviderPluginHost(
          invocation(packageValue, "success"),
        );
        expect(result.output).toEqual({ workerDenied: true });
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 750));
      expect(existsSync(marker)).toBeFalse();
    } finally {
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  test("denies dynamic builtin lookup that could create an ignored-stdio descendant", async () => {
    if (process.platform === "win32") return;
    const markerRoot = mkdtempSync(
      join(tmpdir(), "wrench-portable-escaped-helper-"),
    );
    const marker = join(markerRoot, "helper.pid");
    const runtime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({ protocolVersion: 1, kind: "plugin.ready", plugin: message.plugin });
    continue;
  }
  if (message.kind === "host.invoke") {
    let subprocessDenied = false;
    try {
      const childProcess = process.getBuiltinModule("node:child_process");
      childProcess.spawn(
        "/bin/sh",
        [
          "-c",
          "printf '%s\\\\n' \\"$$\\" > \\"$1\\"; exec /bin/sleep 30",
          "wrench-escaped-helper",
          ${JSON.stringify(marker)},
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      );
    } catch {
      subprocessDenied = true;
    }
    send({
      protocolVersion: 1,
      kind: "plugin.result",
      invocationId: message.invocationId,
      output: { subprocessDenied },
      finalUrl: null,
    });
  }
}
`.trimStart();
    let stagedCwd = "";
    let stopObserving = (): void => {};
    try {
      stopObserving = observePortableProviderPluginHostProcessForTest({
        beforeSpawn: ({ cwd }) => {
          stagedCwd = cwd;
        },
      });
      await withPackage({ runtime }, async (packageValue) => {
        const result = await runPortableProviderPluginHost(
          invocation(packageValue, "success"),
        );
        expect(result.output).toEqual({ subprocessDenied: true });
      });
      expect(stagedCwd).not.toBe("");
      expect(existsSync(stagedCwd)).toBeFalse();
      expect(existsSync(marker)).toBeFalse();
    } finally {
      stopObserving();
      rmSync(markerRoot, { recursive: true, force: true });
    }
  });

  test("denies the Bun shell subprocess path", async () => {
    const runtime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({ protocolVersion: 1, kind: "plugin.ready", plugin: message.plugin });
    continue;
  }
  if (message.kind !== "host.invoke") continue;
  const denied = { shell: false };
  if (typeof Bun.$ === "function") {
    try {
      await Bun.$\`/usr/bin/true\`;
    } catch {
      denied.shell = true;
    }
  } else {
    denied.shell = true;
  }
  send({
    protocolVersion: 1,
    kind: "plugin.result",
    invocationId: message.invocationId,
    output: denied,
    finalUrl: null,
  });
}
`.trimStart();
    await withPackage({ runtime }, async (packageValue) => {
      const result = await runPortableProviderPluginHost(
        invocation(packageValue, "success"),
      );
      expect(result.output).toEqual({
        shell: true,
      });
    });
  });

  test("fails closed when runtime code reaches process.execve", async () => {
    const runtime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({ protocolVersion: 1, kind: "plugin.ready", plugin: message.plugin });
    continue;
  }
  if (message.kind !== "host.invoke") continue;
  if (typeof process.execve === "function") {
    process.execve("/usr/bin/true", ["true"], {});
  }
  send({
    protocolVersion: 1,
    kind: "plugin.result",
    invocationId: message.invocationId,
    output: { unexpectedlyReplaced: true },
    finalUrl: null,
  });
}
`.trimStart();
    await withPackage({ runtime }, async (packageValue) => {
      const error = await hostError(runPortableProviderPluginHost(
        invocation(packageValue, "success"),
      ));
      expect(error.code).toBe("host-failed");
    });
  });

  test("fails closed when runtime code reaches Bun.openInEditor", async () => {
    const runtime = `
import { createInterface } from "node:readline";

const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.kind === "host.hello") {
    send({ protocolVersion: 1, kind: "plugin.ready", plugin: message.plugin });
    continue;
  }
  if (message.kind !== "host.invoke") continue;
  Bun.openInEditor("/dev/null", { editor: "code" });
  send({
    protocolVersion: 1,
    kind: "plugin.result",
    invocationId: message.invocationId,
    output: { unexpectedlyOpened: true },
    finalUrl: null,
  });
}
`.trimStart();
    await withPackage({ runtime }, async (packageValue) => {
      const error = await hostError(runPortableProviderPluginHost(
        invocation(packageValue, "success"),
      ));
      expect(error.code).toBe("host-failed");
    });
  });
});
