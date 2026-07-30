import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import {
  definePortableProviderPluginProjection,
  portableProviderPluginAdapter,
  PROVIDER_PLUGIN_API_VERSION,
  type PortableProviderPluginProjectionDefinitionV1,
  type ProviderPluginBindingDefinitionV1,
  type ProviderPluginV1,
} from "./provider-plugin";
import {
  renderPortableProviderPluginManifest,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginManifestV1,
  type VerifiedPortableProviderPluginPackage,
} from "./provider-plugin-package";
import {
  projectPortableProviderPluginPackage,
} from "./provider-plugin-portable-catalog";
import {
  createAuthorizedKernelPortableProviderPluginBindingProjections,
} from "./provider-plugin-portable-authority";
import {
  resolvePortableProviderRuntimeDependencies,
} from "./provider-plugin-portable-runtime";
import {
  createProviderPluginRegistry,
  extendProviderPluginRegistryWithPortablePlugins,
  type ProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";

const fixtureRoots: string[] = [];
const inertRuntime = "process.stdin.resume();\n";

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function portablePackage(
  options: {
    readonly id?: string;
    readonly adapterId?: string;
    readonly surfaceId?: string;
    readonly implementation?: string;
  } = {},
): VerifiedPortableProviderPluginPackage {
  const id = options.id ?? "portable-example";
  const adapterId = options.adapterId ?? "portable-example-adapter";
  const surfaceId = options.surfaceId ?? "portable-example";
  const implementation =
    options.implementation ?? "Observed portable profile read";
  const runtimeBytes = Buffer.from(inertRuntime, "utf8");
  const manifest: PortableProviderPluginManifestV1 = {
    schemaVersion: 1,
    hostApiVersion: 1,
    id,
    version: "1.2.3",
    displayName: "Portable Example",
    runtime: {
      kind: "bun-js",
      entrypoint: "dist/plugin.mjs",
    },
    provenance: { kind: "local" },
    capabilities: {
      networkOrigins: ["https://www.example.com"],
      planFiles: "none",
      state: "namespaced",
      sessionMaterial: ["cookie-jar"],
    },
    bindings: [{
      adapterId,
      transport: "web-session-api",
      surfaceId,
      origin: "https://www.example.com",
      authKinds: ["cookie-source"],
      subject: {
        format: `${surfaceId}:<account-id>`,
        kind: "opaque-token",
        probe: {
          operation: "profiles.read",
          contractVersion: 1,
        },
      },
      operations: [{
        name: "profiles.read",
        contractVersion: 1,
        timeoutMs: 5_000,
        maxOutputBytes: 8_192,
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
        implementation,
      }],
    }],
    files: [{
      path: "dist/plugin.mjs",
      kind: "runtime",
      bytes: runtimeBytes.byteLength,
      sha256: createHash("sha256").update(runtimeBytes).digest("hex"),
    }],
  };
  const root = mkdtempSync(join(tmpdir(), `io-${id}-registry-test-`));
  fixtureRoots.push(root);
  mkdirSync(join(root, "dist"), { mode: 0o700 });
  writeFileSync(join(root, "dist", "plugin.mjs"), runtimeBytes, {
    mode: 0o600,
  });
  writeFileSync(
    join(root, "wrench-plugin.json"),
    renderPortableProviderPluginManifest(manifest),
    { mode: 0o600 },
  );
  return verifyPortableProviderPluginPackageDirectory(root);
}

function portableFixture(
  options: Parameters<typeof portablePackage>[0] = {},
): {
  readonly package: VerifiedPortableProviderPluginPackage;
  readonly plugin: ProviderPluginV1;
} {
  const packageValue = portablePackage(options);
  return Object.freeze({
    package: packageValue,
    plugin: projectPortableProviderPluginPackage(packageValue),
  });
}

function portableRegistry(
  plugins: readonly ProviderPluginV1[],
): ProviderPluginRegistry {
  return extendProviderPluginRegistryWithPortablePlugins(
    createProviderPluginRegistry([]),
    plugins,
  );
}

describe("portable provider plugin registry identity", () => {
  test("returns exact immutable portable identity from operation resolution", () => {
    const fixture = portableFixture();
    const registry = portableRegistry([fixture.plugin]);
    const resolution = registry.requireOperationDefinition(
      "web-session-api",
      "portable-example",
      "profiles.read",
      1,
    );

    expect(resolution.portableIdentity).toMatchObject({
      pluginId: "portable-example",
      pluginVersion: "1.2.3",
      hostApiVersion: 1,
      bundleSha256: fixture.package.bundleSha256,
      manifestSha256: fixture.package.manifestSha256,
      adapterId: "portable-example-adapter",
      transport: "web-session-api",
      surfaceId: "portable-example",
      operation: "profiles.read",
      contractVersion: 1,
    });
    expect(resolution.portableIdentity?.descriptorSha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(resolution.portableIdentity)).toBeTrue();
    expect(registry.artifactSha256(resolution.binding))
      .toBe(fixture.package.bundleSha256);
    expect(registry.implementationHash(resolution.binding).toString("hex"))
      .toBe(fixture.package.bundleSha256);
    expect(registry.contractImplementationHash(resolution.binding).toString("hex"))
      .toBe(fixture.package.bundleSha256);
    expect(registry.reviewedImplementationClosureHash(resolution.binding))
      .toBe(fixture.package.bundleSha256);
    expect(registry.legacyContractImplementationHashes(resolution.binding))
      .toEqual([]);
  });

  test("returns null identity for every source operation", () => {
    for (const plugin of providerPluginRegistry.list()) {
      for (const binding of plugin.bindings) {
        for (const operation of binding.operations) {
          for (const contractVersion of operation.contractVersions) {
            expect(providerPluginRegistry.requireOperationDefinition(
              binding.transport,
              binding.surfaceId,
              operation.name,
              contractVersion,
            ).portableIdentity).toBeNull();
          }
        }
      }
    }
  });

  test("rejects fake package evidence, raw hooks, and generic registry admission", () => {
    const fixture = portableFixture();
    expect(() => createProviderPluginRegistry([fixture.plugin])).toThrow(
      "kernel-owned catalog extension boundary",
    );

    const binding = fixture.package.manifest.bindings[0];
    const projectedBinding = fixture.plugin.bindings[0];
    if (binding === undefined || projectedBinding === undefined) {
      throw new Error("portable registry fixture is incomplete");
    }
    const adapter = portableProviderPluginAdapter(projectedBinding);
    if (adapter === null) {
      throw new Error("portable registry fixture has no virtual adapter");
    }
    const rawBinding = {
      operations: [{}],
      runtime: {
        loadRuntime: () => Promise.resolve({
          execute: () => Promise.resolve(),
        }),
      },
    } as unknown as ProviderPluginBindingDefinitionV1;
    const definition = (
      packageValue: VerifiedPortableProviderPluginPackage,
    ): PortableProviderPluginProjectionDefinitionV1 => ({
      apiVersion: PROVIDER_PLUGIN_API_VERSION,
      id: fixture.package.manifest.id,
      version: fixture.package.manifest.version,
      displayName: fixture.package.manifest.displayName,
      sourceKind: "portable",
      package: packageValue,
      bindings: [{
        adapterId: binding.adapterId,
        manifest: adapter.manifest,
        portableBinding: binding,
        binding: rawBinding,
      }],
    });

    expect(() => definePortableProviderPluginProjection(definition({
      ...fixture.package,
      bundleSha256: "f".repeat(64),
    }))).toThrow("projection identity is invalid");
    expect(() => definePortableProviderPluginProjection(
      definition(fixture.package),
    )).toThrow("kernel-owned child-host wrapper");
  });

  test("exposes no raw authorizer and freezes every authorized runtime hook", async () => {
    const packageValue = portablePackage();
    const authorityExports = await import("./provider-plugin-portable-authority");
    expect(
      "authorizeKernelPortableProviderPluginBindingProjection"
        in authorityExports,
    ).toBeFalse();

    const [projection] =
      createAuthorizedKernelPortableProviderPluginBindingProjections(
        packageValue,
        process.env,
        resolvePortableProviderRuntimeDependencies({}),
      );
    if (projection === undefined) {
      throw new Error("portable registry fixture has no binding projection");
    }
    expect(Object.isFrozen(projection)).toBeTrue();
    expect(Object.isFrozen(projection.binding)).toBeTrue();
    expect(Object.isFrozen(projection.binding.runtime)).toBeTrue();
    expect(Object.isFrozen(projection.binding.operations)).toBeTrue();
    expect(projection.binding.operations.every(Object.isFrozen)).toBeTrue();
    expect(Object.isFrozen(projection.manifest)).toBeTrue();
    expect(Object.isFrozen(projection.manifest.operations)).toBeTrue();
    expect(
      Object.values(projection.manifest.operations).every(Object.isFrozen),
    ).toBeTrue();
    expect(Reflect.set(
      projection.binding.runtime,
      "loadRuntime",
      () => Promise.reject(new Error("forged runtime")),
    )).toBeFalse();
    expect(Reflect.set(
      projection.binding,
      "runtime",
      { loadRuntime: () => Promise.reject(new Error("forged runtime")) },
    )).toBeFalse();
    expect(() => definePortableProviderPluginProjection({
      apiVersion: PROVIDER_PLUGIN_API_VERSION,
      id: packageValue.manifest.id,
      version: packageValue.manifest.version,
      displayName: packageValue.manifest.displayName,
      sourceKind: "portable",
      package: packageValue,
      bindings: [{
        ...projection,
        manifest: structuredClone(projection.manifest),
      }],
    })).toThrow("kernel-owned child-host wrapper");
  });

  test("snapshots dependency override keys once before branding them", () => {
    const forgedRunHost = () => Promise.reject(new Error("forged host"));
    let ownKeysCalls = 0;
    const stateful = new Proxy(
      {},
      {
        ownKeys: () => {
          ownKeysCalls += 1;
          return ownKeysCalls === 1 ? [] : ["runHost"];
        },
        getOwnPropertyDescriptor: (_target, key) =>
          key === "runHost"
            ? {
                value: forgedRunHost,
                enumerable: true,
                configurable: true,
                writable: true,
              }
            : undefined,
      },
    ) as Parameters<typeof resolvePortableProviderRuntimeDependencies>[0];

    const dependencies = resolvePortableProviderRuntimeDependencies(stateful);
    expect(ownKeysCalls).toBe(1);
    expect(dependencies.runHost).not.toBe(forgedRunHost);
  });

  test("snapshots each projection data property once before authority checks", () => {
    const packageValue = portablePackage();
    const [authorized] =
      createAuthorizedKernelPortableProviderPluginBindingProjections(
        packageValue,
        process.env,
        resolvePortableProviderRuntimeDependencies({}),
      );
    if (authorized === undefined) {
      throw new Error("portable registry fixture has no authorized binding");
    }
    const forgedLoadRuntime = () => Promise.reject(new Error("forged runtime"));
    const forgedBinding: ProviderPluginBindingDefinitionV1 = {
      ...authorized.binding,
      runtime: { loadRuntime: forgedLoadRuntime },
    };
    let bindingDescriptorReads = 0;
    const entry = new Proxy(
      {
        adapterId: authorized.adapterId,
        manifest: authorized.manifest,
        portableBinding: authorized.portableBinding,
        binding: authorized.binding,
      },
      {
        getOwnPropertyDescriptor: (target, key) => {
          if (key !== "binding") {
            return Reflect.getOwnPropertyDescriptor(target, key);
          }
          bindingDescriptorReads += 1;
          return {
            value: bindingDescriptorReads === 1
              ? authorized.binding
              : forgedBinding,
            enumerable: true,
            configurable: true,
            writable: true,
          };
        },
      },
    );
    const projected = definePortableProviderPluginProjection({
      apiVersion: PROVIDER_PLUGIN_API_VERSION,
      id: packageValue.manifest.id,
      version: packageValue.manifest.version,
      displayName: packageValue.manifest.displayName,
      sourceKind: "portable",
      package: packageValue,
      bindings: [entry],
    });

    expect(bindingDescriptorReads).toBe(1);
    expect(projected.bindings[0]?.loadRuntime).not.toBe(forgedLoadRuntime);
  });

  test("rejects adapter collisions independently of insertion order", () => {
    const alpha = portableFixture({
      id: "alpha-portable",
      adapterId: "shared-portable-adapter",
      surfaceId: "alpha-portable",
    }).plugin;
    const zeta = portableFixture({
      id: "zeta-portable",
      adapterId: "shared-portable-adapter",
      surfaceId: "zeta-portable",
    }).plugin;
    const message = (values: readonly ProviderPluginV1[]): string => {
      try {
        portableRegistry(values);
        return "accepted";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    expect(message([alpha, zeta])).toBe(message([zeta, alpha]));
    expect(message([alpha, zeta])).toContain(
      "duplicate portable provider plugin adapter ID",
    );
  });

  test("binds metadata drift while keeping registry order invariant", () => {
    const zetaOptions = {
      id: "zeta-portable",
      adapterId: "zeta-portable-adapter",
      surfaceId: "zeta-portable",
    };
    const first = portableRegistry([
      portableFixture(zetaOptions).plugin,
      portableFixture().plugin,
    ]);
    const reverse = portableRegistry([
      portableFixture().plugin,
      portableFixture(zetaOptions).plugin,
    ]);
    const resolve = (registry: ProviderPluginRegistry) =>
      registry.requireOperationDefinition(
        "web-session-api",
        "portable-example",
        "profiles.read",
        1,
      ).portableIdentity;

    expect(resolve(first)).toEqual(resolve(reverse));
    expect(resolve(portableRegistry([
      portableFixture({
        implementation: "Changed reviewed implementation",
      }).plugin,
    ]))?.descriptorSha256).not.toBe(resolve(first)?.descriptorSha256);
  });
});
