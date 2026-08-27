import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

import {
  derivePortableProviderPluginMinimumRisk,
  isPortableProviderPluginVersion,
  observePortableProviderPluginPathHelperSpawnsForTest,
  parsePortableProviderPluginManifest,
  renderPortableProviderPluginManifest,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginManifestV1,
} from "./provider-plugin-package";

const runtimeBytes = Buffer.from(
  "export default Object.freeze({ apiVersion: 1 });\n",
  "utf8",
);
const fixtureBytes = Buffer.from('{"items":[]}\n', "utf8");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifest(
  overrides: Partial<PortableProviderPluginManifestV1> = {},
): PortableProviderPluginManifestV1 {
  return {
    schemaVersion: 1,
    hostApiVersion: 1,
    id: "example-web",
    version: "1.0.0",
    displayName: "Example web",
    runtime: {
      kind: "bun-js",
      entrypoint: "dist/plugin.mjs",
    },
    provenance: {
      kind: "git",
      repository: "https://github.com/example/wrench-plugin.git",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
    capabilities: {
      networkOrigins: ["https://www.example.com"],
      planFiles: "read",
      state: "namespaced",
      sessionMaterial: ["cookie-jar"],
    },
    bindings: [
      {
        transport: "web-session-api",
        adapterId: "example-web",
        surfaceId: "example",
        origin: "https://www.example.com",
        authKinds: ["browser-profile", "cookie-source", "cookies-file"],
        subject: {
          format: "bounded example account identifier",
          kind: "opaque-token",
          probe: {
            operation: "feeds.read",
            contractVersion: 1,
          },
        },
        operations: [
          {
            name: "feeds.read",
            contractVersion: 1,
            timeoutMs: 30_000,
            maxOutputBytes: 256 * 1024,
            state: "observed",
            risk: "R1",
            dispatch: "none",
            sideEffect: "none",
            idempotency: "none",
            dedupeWindowMs: 0,
            input: {
              properties: {},
              required: [],
            },
            implementation: "Reads one bounded feed page.",
          },
        ],
      },
    ],
    files: [
      {
        path: "dist/plugin.mjs",
        kind: "runtime",
        bytes: runtimeBytes.byteLength,
        sha256: digest(runtimeBytes),
      },
      {
        path: "fixtures/example.json",
        kind: "data",
        bytes: fixtureBytes.byteLength,
        sha256: digest(fixtureBytes),
      },
    ],
    ...overrides,
  };
}

function withPackage(
  callback: (directory: string, value: PortableProviderPluginManifestV1) => void,
  value = manifest(),
  runtime = runtimeBytes,
): void {
  const directory = mkdtempSync(join(tmpdir(), "wrench-portable-plugin-package-"));
  try {
    mkdirSync(join(directory, "dist"), { mode: 0o700 });
    mkdirSync(join(directory, "fixtures"), { mode: 0o700 });
    writeFileSync(join(directory, "dist", "plugin.mjs"), runtime);
    writeFileSync(join(directory, "fixtures", "example.json"), fixtureBytes);
    writeFileSync(
      join(directory, "wrench-plugin.json"),
      renderPortableProviderPluginManifest(value),
    );
    callback(directory, value);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function withRuntimePackage(
  source: string,
  callback: (directory: string) => void,
): void {
  const bytes = Buffer.from(source, "utf8");
  const base = manifest();
  const value = manifest({
    files: [
      {
        ...base.files[0]!,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
      },
      base.files[1]!,
    ],
  });
  withPackage((directory) => callback(directory), value, bytes);
}

describe("portable provider plugin manifest", () => {
  test("round-trips one strict, sorted provider package description", () => {
    const expected = manifest();
    const parsed = parsePortableProviderPluginManifest(
      JSON.parse(renderPortableProviderPluginManifest(expected)) as unknown,
    );
    expect(parsed).toEqual({ ok: true, value: expected });
    expect(isPortableProviderPluginVersion("1.0.0-alpha.1+build.7")).toBeTrue();
    expect(isPortableProviderPluginVersion("1.0.0-01")).toBeFalse();
    expect(parsePortableProviderPluginManifest({
      ...expected,
      version: "1.0.0-01",
    })).toEqual({
      ok: false,
      issues: ["plugin version must be strict semantic version text"],
    });
  });

  test("rejects extra fields, unsafe transport auth, and missing origin grants", () => {
    expect(parsePortableProviderPluginManifest({
      ...manifest(),
      surprise: true,
    })).toEqual({
      ok: false,
      issues: [
        "portable provider plugin manifest must contain exactly: bindings, capabilities, displayName, files, hostApiVersion, id, provenance, runtime, schemaVersion, version",
      ],
    });

    const validManifest = manifest();
    const unsafeAuth = {
      ...validManifest,
      bindings: [{
        ...validManifest.bindings[0]!,
        transport: "provider-api",
      }],
    };
    expect(parsePortableProviderPluginManifest(unsafeAuth)).toEqual({
      ok: false,
      issues: [
        "plugin binding example provider-api requires only oauth-token-file auth",
      ],
    });

    const missingOrigin = manifest({
      capabilities: {
        ...manifest().capabilities,
        networkOrigins: [],
      },
    });
    expect(parsePortableProviderPluginManifest(missingOrigin)).toEqual({
      ok: false,
      issues: [
        "plugin capability network origins omit binding origin https://www.example.com",
      ],
    });

    const rootedLocalhost = manifest({
      capabilities: {
        ...manifest().capabilities,
        networkOrigins: ["https://localhost."],
      },
      bindings: [{
        ...manifest().bindings[0]!,
        origin: "https://localhost.",
      }],
    });
    expect(parsePortableProviderPluginManifest(rootedLocalhost)).toEqual({
      ok: false,
      issues: [
        "plugin binding example origin must be an exact public HTTPS origin",
      ],
    });

    let getterCalls = 0;
    const accessorManifest = manifest() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorManifest, "version", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "1.0.0";
      },
    });
    expect(parsePortableProviderPluginManifest(accessorManifest)).toEqual({
      ok: false,
      issues: ["portable provider plugin manifest must be an object"],
    });
    expect(getterCalls).toBe(0);
  });

  test("rejects local CLI bindings from the portable v1 package grammar", () => {
    const candidate = structuredClone(manifest()) as unknown as {
      bindings: Array<Record<string, unknown>>;
    };
    const binding = candidate.bindings[0];
    if (binding === undefined) throw new Error("missing portable binding fixture");
    binding.transport = "local-cli";

    const parsed = parsePortableProviderPluginManifest(candidate);
    expect(parsed.ok).toBeFalse();
    if (!parsed.ok) {
      expect(parsed.issues).toContain(
        "plugin binding transport is unsupported",
      );
    }
  });

  test("admits only host-api-v1 session materials executable by a binding", () => {
    const base = manifest();
    expect(parsePortableProviderPluginManifest(base).ok).toBeTrue();

    expect(parsePortableProviderPluginManifest({
      ...base,
      capabilities: {
        ...base.capabilities,
        sessionMaterial: ["csrf-token"],
      },
    })).toEqual({
      ok: false,
      issues: [
        "plugin session material csrf-token is unsupported by host API v1",
      ],
    });

    expect(parsePortableProviderPluginManifest({
      ...base,
      capabilities: {
        ...base.capabilities,
        sessionMaterial: ["oauth-access-token"],
      },
    })).toEqual({
      ok: false,
      issues: [
        "plugin session material oauth-access-token is not executable by any declared binding",
      ],
    });
  });

  test("rejects ambiguous paths, package-manager files, and unsorted records", () => {
    const base = manifest();
    expect(parsePortableProviderPluginManifest({
      ...base,
      files: [
        {
          ...base.files[0]!,
          path: "../plugin.mjs",
        },
      ],
    }).ok).toBeFalse();

    expect(parsePortableProviderPluginManifest({
      ...base,
      files: [
        {
          ...base.files[0]!,
          path: "package.json",
        },
      ],
    })).toEqual({
      ok: false,
      issues: [
        "plugin file path names a forbidden package-manager or environment file",
      ],
    });

    for (const path of ["CON.txt", "dist/plugin."]) {
      expect(parsePortableProviderPluginManifest({
        ...base,
        files: [{
          ...base.files[0]!,
          path,
        }],
      }).ok).toBeFalse();
    }

    expect(parsePortableProviderPluginManifest({
      ...base,
      files: [...base.files].reverse(),
    })).toEqual({
      ok: false,
      issues: ["plugin files must be sorted by path"],
    });

    const operation = base.bindings[0]!.operations[0]!;
    expect(parsePortableProviderPluginManifest({
      ...base,
      bindings: [{
        ...base.bindings[0]!,
        operations: [
          { ...operation, contractVersion: 2 },
          operation,
        ],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin binding example v1 permits only one current contract version per operation name",
      ],
    });

    expect(parsePortableProviderPluginManifest({
      ...base,
      files: [
        base.files[0]!,
        {
          ...base.files[0]!,
          path: "DIST/PLUGIN.MJS",
        },
      ],
    })).toEqual({
      ok: false,
      issues: ["portable provider plugin repeats a file path"],
    });

    expect(parsePortableProviderPluginManifest({
      ...base,
      files: [
        base.files[0]!,
        {
          ...base.files[0]!,
          path: "dist/second.mjs",
        },
        base.files[1]!,
      ],
    })).toEqual({
      ok: false,
      issues: [
        "plugin package must declare exactly one runtime file, its entrypoint",
      ],
    });

    expect(parsePortableProviderPluginManifest({
      ...base,
      provenance: {
        kind: "git",
        repository: "https://example.com/github.com/owner/repository",
        revision: "0123456789abcdef0123456789abcdef01234567",
      },
    })).toEqual({
      ok: false,
      issues: [
        "plugin git provenance repository must identify an HTTPS repository",
      ],
    });
  });

  test("derives conservative semantic risk and rejects lower authority", () => {
    expect(derivePortableProviderPluginMinimumRisk("feeds.read")).toBe("R1");
    expect(derivePortableProviderPluginMinimumRisk("profiles.update")).toBe("R2");
    expect(derivePortableProviderPluginMinimumRisk("posts.send")).toBe("R3");
    expect(derivePortableProviderPluginMinimumRisk("posts.delete")).toBe("R4");
    expect(derivePortableProviderPluginMinimumRisk("payments.status")).toBe("R4");
    expect(derivePortableProviderPluginMinimumRisk("widgets.rotate")).toBe("R4");

    const base = manifest();
    const operation = base.bindings[0]!.operations[0]!;
    expect(parsePortableProviderPluginManifest({
      ...base,
      bindings: [{
        ...base.bindings[0]!,
        operations: [{
          ...operation,
          name: "posts.send",
          risk: "R2",
          dispatch: "single",
          sideEffect: "sends one post",
          idempotency: "local-at-most-once",
          dedupeWindowMs: 60_000,
        }],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin operation posts.send requires at least R3 authority, not R2",
      ],
    });

    expect(parsePortableProviderPluginManifest({
      ...base,
      bindings: [{
        ...base.bindings[0]!,
        operations: [{
          ...operation,
          name: "payments.status",
          risk: "R3",
          dispatch: "single",
          sideEffect: "requests a financial status",
          idempotency: "local-at-most-once",
          dedupeWindowMs: 60_000,
        }],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin operation payments.status requires at least R4 authority, not R3",
      ],
    });
  });

  test("enforces risk laws and keeps R4 authority capture-required", () => {
    const base = manifest();
    const operation = base.bindings[0]!.operations[0]!;
    expect(parsePortableProviderPluginManifest({
      ...base,
      bindings: [{
        ...base.bindings[0]!,
        operations: [{
          ...operation,
          dispatch: "single",
        }],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin operation feeds.read must keep R1 semantics side-effect-free, file-free, and dispatch-free",
      ],
    });

    expect(parsePortableProviderPluginManifest({
      ...base,
      bindings: [{
        ...base.bindings[0]!,
        operations: [{
          ...operation,
          name: "posts.publish",
          risk: "R3",
          dispatch: "none",
          sideEffect: "publishes one post",
          idempotency: "local-at-most-once",
          dedupeWindowMs: 60_000,
        }],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin operation posts.publish must bind R2/R3 authority to one at-most-once dispatch and a 60-second minimum dedupe window",
      ],
    });

    expect(parsePortableProviderPluginManifest({
      ...base,
      bindings: [{
        ...base.bindings[0]!,
        operations: [{
          ...operation,
          name: "posts.delete",
          risk: "R4",
          state: "observed",
        }],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin operation posts.delete must keep R4 authority capture-required",
      ],
    });
  });

  test("keeps linked-device operations capture-required at manifest check", () => {
    const base = manifest();
    const binding = base.bindings[0]!;
    const operation = binding.operations[0]!;
    const linkedDevice = {
      ...base,
      capabilities: {
        ...base.capabilities,
        sessionMaterial: [],
      },
      bindings: [{
        ...binding,
        transport: "linked-device",
        authKinds: ["linked-device-store"],
        subject: {
          ...binding.subject,
          probe: null,
        },
        operations: [{
          ...operation,
          state: "capture-required",
        }],
      }],
    };
    expect(parsePortableProviderPluginManifest(linkedDevice).ok).toBeTrue();
    expect(parsePortableProviderPluginManifest({
      ...linkedDevice,
      bindings: [{
        ...linkedDevice.bindings[0]!,
        operations: [{
          ...linkedDevice.bindings[0]!.operations[0]!,
          state: "observed",
        }],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin binding example linked-device operations must remain capture-required until a portable lifecycle protocol is available",
      ],
    });
  });

  test("parses strict Wrench input schemas and provider-api metadata", () => {
    const base = manifest();
    const providerManifest = manifest({
      capabilities: {
        networkOrigins: ["https://api.example.com"],
        planFiles: "none",
        state: "none",
        sessionMaterial: ["oauth-access-token"],
      },
      bindings: [{
        transport: "provider-api",
        adapterId: "example-api",
        surfaceId: "example",
        origin: "https://api.example.com",
        authKinds: ["oauth-token-file"],
        subject: {
          format: "bounded example account identifier",
          kind: "opaque-token",
          probe: null,
        },
        operations: [{
          name: "records.search",
          contractVersion: 2,
          timeoutMs: 30_000,
          maxOutputBytes: 256 * 1024,
          state: "observed",
          risk: "R1",
          dispatch: "none",
          sideEffect: "none",
          idempotency: "none",
          dedupeWindowMs: 0,
          input: {
            properties: {
              limit: {
                type: "number",
                description: "Maximum records",
                minimum: 1,
                maximum: 100,
              },
              query: {
                type: "string",
                description: "Bounded query",
                minLength: 1,
                maxLength: 200,
              },
            },
            required: ["query"],
          },
          implementation: "Searches one bounded official API page.",
          requiredScopeSets: [["records.read"], ["records.read", "users.read"]],
          coverage: ["recent-records", "records"],
        }],
      }],
    });
    expect(parsePortableProviderPluginManifest(providerManifest)).toEqual({
      ok: true,
      value: providerManifest,
    });

    const operation = base.bindings[0]!.operations[0]!;
    expect(parsePortableProviderPluginManifest({
      ...base,
      bindings: [{
        ...base.bindings[0]!,
        operations: [{
          ...operation,
          input: {
            properties: {
              query: {
                type: "string",
                description: "Query",
                surprise: true,
              },
            },
            required: ["query"],
          },
        }],
      }],
    })).toEqual({
      ok: false,
      issues: [
        "plugin operation feeds.read input.properties.query contains unsupported keys: surprise",
      ],
    });
  });
});

describe("portable provider plugin package verification", () => {
  test("binds canonical metadata and exact file bytes into a relocation-stable digest", () => {
    let firstDigest = "";
    withPackage((directory, expected) => {
      const verified = verifyPortableProviderPluginPackageDirectory(directory);
      expect(verified.manifest).toEqual(expected);
      expect(verified.payloadBytes).toBe(
        runtimeBytes.byteLength + fixtureBytes.byteLength,
      );
      expect(verified.files.map((file) => file.path)).toEqual([
        "dist/plugin.mjs",
        "fixtures/example.json",
      ]);
      expect(verified.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(verified.manifestSha256).toBe(
        digest(Buffer.from(renderPortableProviderPluginManifest(expected))),
      );
      firstDigest = verified.bundleSha256;
    });
    withPackage((directory) => {
      expect(
        verifyPortableProviderPluginPackageDirectory(directory).bundleSha256,
      ).toBe(firstDigest);
    });
  });

  test("reads the predecessor manifest name without changing package identity", () => {
    withPackage((directory) => {
      const current = verifyPortableProviderPluginPackageDirectory(directory);
      renameSync(
        join(directory, "wrench-plugin.json"),
        join(directory, "oh-plugin.json"),
      );
      const legacy = verifyPortableProviderPluginPackageDirectory(directory);
      expect(legacy.manifest).toEqual(current.manifest);
      expect(legacy.manifestSha256).toBe(current.manifestSha256);
      expect(legacy.bundleSha256).toBe(current.bundleSha256);

      writeFileSync(
        join(directory, "wrench-plugin.json"),
        legacy.manifestBytes,
      );
      expect(() => verifyPortableProviderPluginPackageDirectory(directory))
        .toThrow("must contain exactly one");
    });
  });

  test("rejects noncanonical manifests, undeclared files, empty directories, and symlinks", () => {
    withPackage((directory, value) => {
      writeFileSync(
        join(directory, "wrench-plugin.json"),
        JSON.stringify(value),
      );
      expect(() =>
        verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
        "manifest must use canonical rendered JSON",
      );
    });

    withPackage((directory) => {
      writeFileSync(join(directory, "extra.txt"), "extra");
      expect(() =>
        verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
        "package files differ from its exact manifest",
      );
    });

    withPackage((directory) => {
      mkdirSync(join(directory, "empty"));
      expect(() =>
        verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
        "undeclared or empty directory",
      );
    });

    withPackage((directory) => {
      symlinkSync(
        join(directory, "dist", "plugin.mjs"),
        join(directory, "linked.mjs"),
      );
      expect(() =>
        verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
        "contains symlink linked.mjs",
      );
    });

    withPackage((directory) => {
      for (let index = 0; index < 257; index += 1) {
        writeFileSync(join(directory, `extra-${index}.txt`), "x");
      }
      expect(() =>
        verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
        "exceeds 256 declared files",
      );
    });
  });

  test("rejects byte-length and content-digest drift", () => {
    withPackage((directory) => {
      writeFileSync(join(directory, "dist", "plugin.mjs"), "short");
      expect(() =>
        verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
        "byte length does not match its manifest",
      );
    });

    withPackage((directory) => {
      const changed = Buffer.from(runtimeBytes);
      changed[0] = changed[0] === 0x65 ? 0x45 : 0x65;
      writeFileSync(join(directory, "dist", "plugin.mjs"), changed);
      expect(() =>
        verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
        "digest does not match its manifest",
      );
    });
  });

  test("accepts only one self-contained runtime with reviewed static imports", () => {
    withRuntimePackage(
      [
        'import { createInterface } from "node:readline";',
        'const inert = "import(value) require(value)";',
        "const pattern = /require\\(value\\)/;",
        "void createInterface;",
        "void inert;",
        "void pattern;",
        "",
      ].join("\n"),
      (directory) => {
        expect(
          verifyPortableProviderPluginPackageDirectory(directory)
            .manifest.runtime.entrypoint,
        ).toBe("dist/plugin.mjs");
      },
    );

    const rejected: readonly {
      readonly source: string;
      readonly message: string;
    }[] = [
      {
        source: 'import "./helper.mjs";\n',
        message: "imports unsupported module ./helper.mjs",
      },
      {
        source: 'export * from "left-pad";\n',
        message: "imports unsupported module left-pad",
      },
      {
        source: 'import { readFile } from "node:fs"; void readFile;\n',
        message: "imports unsupported module node:fs",
      },
      {
        source: 'import { sqlite } from "bun:sqlite"; void sqlite;\n',
        message: "imports unsupported module bun:sqlite",
      },
      {
        source: 'await import("node:readline");\n',
        message: "must not use dynamic import",
      },
      {
        source: "const name = \"node:readline\"; await import(name);\n",
        message: "must not use dynamic import",
      },
      {
        source: 'require("node:readline");\n',
        message: "must not use require",
      },
      {
        source: "const name = \"node:readline\"; require(name);\n",
        message: "must not use require",
      },
      {
        source: "const loader = require; loader(\"node:readline\");\n",
        message: "must not use require",
      },
      {
        source: "module.require(\"node:readline\");\n",
        message: "must not use require",
      },
      {
        source: "globalThis[\"require\"](\"node:readline\");\n",
        message: "must not use require",
      },
    ];
    for (const example of rejected) {
      withRuntimePackage(example.source, (directory) => {
        expect(() =>
          verifyPortableProviderPluginPackageDirectory(directory)).toThrow(
          example.message,
        );
      });
    }
  });

  test("verifies the maximum legal tree with a constant helper-process budget", () => {
    const directory = mkdtempSync(join(tmpdir(), "wrench-portable-plugin-maximum-"));
    const fileBytes = new Map<string, Buffer>();
    const files: PortableProviderPluginManifestV1["files"] = Array.from(
      { length: 256 },
      (_, index) => {
        const prefix = `d${index.toString().padStart(3, "0")}`;
        const path = [
          prefix,
          ...Array.from(
            { length: 14 },
            (__, depth) => `n${(depth + 1).toString().padStart(2, "0")}`,
          ),
          "plugin.mjs",
        ].join("/");
        const bytes = Buffer.from(`export default ${index};\n`, "utf8");
        fileBytes.set(path, bytes);
        return {
          path,
          kind: index === 0 ? "runtime" as const : "data" as const,
          bytes: bytes.byteLength,
          sha256: digest(bytes),
        };
      },
    );
    const value = manifest({
      runtime: {
        kind: "bun-js",
        entrypoint: files[0]!.path,
      },
      files,
    });
    let helperProcesses = 0;
    let stopObserving = (): void => {};
    try {
      for (const file of files) {
        const target = join(directory, ...file.path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, fileBytes.get(file.path)!);
      }
      writeFileSync(
        join(directory, "wrench-plugin.json"),
        renderPortableProviderPluginManifest(value),
      );
      stopObserving = observePortableProviderPluginPathHelperSpawnsForTest(
        () => {
          helperProcesses += 1;
        },
      );
      const startedAt = performance.now();
      const verified = verifyPortableProviderPluginPackageDirectory(directory);
      const elapsedMs = performance.now() - startedAt;
      expect(verified.files).toHaveLength(256);
      expect(helperProcesses).toBe(4);
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      stopObserving();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
