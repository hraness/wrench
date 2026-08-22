import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MAX_PROVIDER_PLUGIN_BINDINGS,
  MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION,
  MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES,
  MAX_PROVIDER_PLUGIN_OPERATIONS,
  MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING,
  defineProviderPlugin,
  isProviderPluginRepositorySourcePath,
  lazyProviderApiRuntime,
  lazyWebSessionRuntime,
  providerPluginRepositoryRoot,
  type ProviderApiPluginBindingDefinitionV1,
  type ProviderApiPluginOperationDefinitionV1,
  type ProviderPluginDefinitionV1,
  type WebSessionApiPluginBindingDefinitionV1,
  type WebSessionPluginOperationDefinitionV1,
} from "./provider-plugin";
import {
  MAX_PROVIDER_PLUGIN_REGISTRY_OPERATION_CONTRACTS,
  MAX_PROVIDER_PLUGIN_REGISTRY_ROUTES,
  createProviderPluginRegistry,
} from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  isProviderOperation,
  isWebSessionOperation,
  parseDiagnosticManifest,
  parseRuntimeManifest,
  type WrenchManifest,
} from "./model";

const inertExecution = Object.freeze({
  status: "failed" as const,
  output: null,
  finalUrl: null,
  dispatchStarted: false,
  dispatch: { planned: 0, started: 0, verified: 0 },
  error: "test executor is inert",
});

const registryDefinitionFixtureDirectory = mkdtempSync(
  join(import.meta.dir, "plugins", "registry-definition-fixture-"),
);
const registryDefinitionFixturePath = join(
  registryDefinitionFixtureDirectory,
  "plugin.ts",
);
writeFileSync(
  registryDefinitionFixturePath,
  "export const registryDefinitionFixture = true;\n",
);
afterAll(() => {
  rmSync(registryDefinitionFixtureDirectory, {
    recursive: true,
    force: true,
  });
});

function resolveInstalledKbDynamicModulePath(): string {
  const dist = dirname(fileURLToPath(import.meta.resolve("@hraness/kb")));
  const candidates = readdirSync(dist, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(dist, entry.name))
    .filter((path) => {
      const source = readFileSync(path, "utf8");
      return source.match(
        /createRequire\(parentUrl\)\.resolve\(`\$\{packageName\}\/package\.json`\)/gu,
      )?.length === 1
        && source.match(/resolvePackageDirectory\("agent-browser"\)/gu)?.length === 1;
    });
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(
      `installed @hraness/kb exposes ${String(candidates.length)} dynamic-resolution modules, expected exactly one`,
    );
  }
  return candidates[0];
}

function operation(
  name = "custom.read",
  options: {
    readonly contractVersion?: number;
    readonly historicalContractVersions?: readonly number[];
  } = {},
): WebSessionPluginOperationDefinitionV1 {
  return {
    name,
    contractVersion: options.contractVersion ?? 1,
    ...(options.historicalContractVersions === undefined
      ? {}
      : { historicalContractVersions: options.historicalContractVersions }),
    risk: "R1",
    input: { properties: {}, required: [] },
    sideEffect: "none",
    idempotency: "none",
    dedupeWindowMs: 0,
    state: "observed",
    dispatch: "none",
    implementation: "inert test operation",
    planDispatches: () => [],
    validateInput: () => [],
  };
}

function webBinding(
  surfaceId: string,
  operations: readonly WebSessionPluginOperationDefinitionV1[] = [operation()],
  onLoad: () => void = () => undefined,
): WebSessionApiPluginBindingDefinitionV1 {
  return {
    transport: "web-session-api",
    surfaceId,
    origin: `https://${surfaceId}.example`,
    authKinds: ["cookie-source"],
    operations,
    subject: {
      format: `${surfaceId}:<id>`,
      matches: (value) => value.startsWith(`${surfaceId}:`),
    },
    runtime: lazyWebSessionRuntime(() => {
      onLoad();
      return Promise.resolve({
        probe: () => Promise.resolve(`${surfaceId}:viewer`),
        execute: () => Promise.resolve(inertExecution),
      });
    }),
  };
}

function providerApiBinding(
  surfaceId: string,
): ProviderApiPluginBindingDefinitionV1 {
  const providerOperation: ProviderApiPluginOperationDefinitionV1 = {
    ...operation(),
    requiredScopeSets: [["test.read"]],
    coverage: ["test records"],
  };
  return {
    transport: "provider-api",
    surfaceId,
    origin: `https://${surfaceId}.example`,
    authKinds: ["oauth-token-file"],
    operations: [providerOperation],
    subject: {
      format: `${surfaceId}:<id>`,
      matches: (value) => value.startsWith(`${surfaceId}:`),
    },
    runtime: lazyProviderApiRuntime(() => Promise.resolve({
      execute: () => Promise.resolve(),
    })),
  };
}

function pluginDefinition(
  id: string,
  bindings: readonly WebSessionApiPluginBindingDefinitionV1[] = [
    webBinding(`${id}-site`),
  ],
  sourceUrl: URL = pathToFileURL(registryDefinitionFixturePath),
  sourceKind: ProviderPluginDefinitionV1["sourceKind"] = "source",
): ProviderPluginDefinitionV1 {
  return {
    apiVersion: 1,
    id,
    version: "1.0.0",
    displayName: id,
    sourceKind,
    implementationSources: [{ label: "plugin.ts", url: sourceUrl }],
    bindings,
  };
}

function rejectionMessage(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected action to reject");
}

function manifestFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function writeInstalledDependency(
  pluginDirectory: string,
  name: string,
  options: {
    readonly entry?: string;
    readonly source?: string;
    readonly version?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
    readonly peerDependenciesMeta?: Readonly<
      Record<string, Readonly<{ readonly optional: boolean }>>
    >;
  } = {},
): {
  readonly root: string;
  readonly entry: string;
  readonly manifest: string;
} {
  const root = join(pluginDirectory, "node_modules", ...name.split("/"));
  const entryName = options.entry ?? "index.js";
  const entry = join(root, entryName);
  const manifest = join(root, "package.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    manifest,
    `${JSON.stringify({
      name,
      version: options.version ?? "1.0.0",
      main: `./${entryName}`,
      ...(options.dependencies === undefined
        ? {}
        : { dependencies: options.dependencies }),
      ...(options.optionalDependencies === undefined
        ? {}
        : { optionalDependencies: options.optionalDependencies }),
      ...(options.peerDependencies === undefined
        ? {}
        : { peerDependencies: options.peerDependencies }),
      ...(options.peerDependenciesMeta === undefined
        ? {}
        : { peerDependenciesMeta: options.peerDependenciesMeta }),
    }, null, 2)}\n`,
  );
  writeFileSync(entry, options.source ?? "export const value = 1;\n");
  return { root, entry, manifest };
}

describe("provider plugin definition and registry", () => {
  test("registers Gmail as a current-only durable provider identity", () => {
    const plugin = providerPluginRegistry.get("gmail-official");
    const binding = plugin?.bindings[0];
    expect(plugin?.version).toBe("1.2.0");
    expect(binding?.transport).toBe("provider-api");
    if (binding === undefined) throw new Error("Gmail provider binding is unavailable");
    expect(providerPluginRegistry.contractImplementationHash(binding).toString("hex"))
      .toBe("821e81dcd0d09756253ace93bece4b906c9fca3f1ab27adcbf0108a3fb0f6702");
    expect(providerPluginRegistry.legacyContractImplementationHashes(binding)).toEqual([]);
  });

  test("freezes complete definitions and orders plugins, bindings, and operations", () => {
    const registry = createProviderPluginRegistry([
      pluginDefinition("zeta", [
        webBinding("zeta-two", [operation("zeta.write")]),
        webBinding("zeta-one", [operation("zeta.read")]),
      ]),
      pluginDefinition("alpha"),
    ]);
    expect(registry.list().map((plugin) => plugin.id)).toEqual(["alpha", "zeta"]);
    const registered = registry.get("zeta");
    expect(Object.isFrozen(registry.list())).toBeTrue();
    expect(Object.isFrozen(registered)).toBeTrue();
    expect(registered?.bindings.map((binding) => binding.surfaceId)).toEqual([
      "zeta-one",
      "zeta-two",
    ]);
    const descriptor = registered?.bindings[0]?.operations[0];
    expect(descriptor).toMatchObject({
      name: "zeta.read",
      contractVersion: 1,
      risk: "R1",
      state: "observed",
      dispatch: "none",
    });
    expect(Object.isFrozen(descriptor?.input)).toBeTrue();
  });

  test("enforces trusted-source cardinality bounds before projection", () => {
    const sourceDefinitions = Array.from(
      { length: MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES },
      (_, index) => ({
        label: index === 0 ? "plugin.ts" : `source/${index}.ts`,
        url: pathToFileURL(registryDefinitionFixturePath),
      }),
    );
    expect(defineProviderPlugin({
      ...pluginDefinition("source-bound"),
      implementationSources: sourceDefinitions,
    }).implementationSources).toHaveLength(
      MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES,
    );
    expect(() => defineProviderPlugin({
      ...pluginDefinition("source-over-bound"),
      implementationSources: [
        ...sourceDefinitions,
        {
          label: "source/overflow.ts",
          url: pathToFileURL(registryDefinitionFixturePath),
        },
      ],
    })).toThrow(
      `may contain at most ${MAX_PROVIDER_PLUGIN_IMPLEMENTATION_SOURCES} items`,
    );

    const maximumBindings = Array.from(
      { length: MAX_PROVIDER_PLUGIN_BINDINGS },
      (_, index) => webBinding(`binding-${index}`),
    );
    expect(defineProviderPlugin(
      pluginDefinition("binding-bound", maximumBindings),
    ).bindings).toHaveLength(MAX_PROVIDER_PLUGIN_BINDINGS);
    expect(() => defineProviderPlugin(pluginDefinition(
      "binding-over-bound",
      [...maximumBindings, webBinding("binding-overflow")],
    ))).toThrow(
      `may contain at most ${MAX_PROVIDER_PLUGIN_BINDINGS} items`,
    );

    const maximumBindingOperations = Array.from(
      { length: MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING },
      (_, index) => operation(`custom.op${index}`),
    );
    expect(defineProviderPlugin(pluginDefinition(
      "operation-bound",
      [webBinding("operation-bound", maximumBindingOperations)],
    )).bindings[0]?.operations).toHaveLength(
      MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING,
    );
    expect(() => defineProviderPlugin(pluginDefinition(
      "operation-over-bound",
      [webBinding("operation-over-bound", [
        ...maximumBindingOperations,
        operation("custom.overflow"),
      ])],
    ))).toThrow(
      `may contain at most ${MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING} items`,
    );

    const fullBindings = Array.from(
      {
        length:
          MAX_PROVIDER_PLUGIN_OPERATIONS
          / MAX_PROVIDER_PLUGIN_OPERATIONS_PER_BINDING,
      },
      (_, index) =>
        webBinding(`aggregate-${index}`, maximumBindingOperations),
    );
    const aggregateBound = defineProviderPlugin(pluginDefinition(
      "aggregate-bound",
      fullBindings,
    ));
    expect(aggregateBound.bindings.reduce(
      (count, binding) => count + binding.operations.length,
      0,
    )).toBe(
      MAX_PROVIDER_PLUGIN_OPERATIONS,
    );
    expect(() => defineProviderPlugin(pluginDefinition(
      "aggregate-over-bound",
      [...fullBindings, webBinding("aggregate-overflow")],
    ))).toThrow(
      `may declare at most ${MAX_PROVIDER_PLUGIN_OPERATIONS} operations`,
    );
  });

  test("bounds historical versions before copying and exact registry contracts before routing", () => {
    const maximumHistoricalVersions = Array.from(
      {
        length:
          MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION - 1,
      },
      (_, index) => index + 1,
    );
    expect(defineProviderPlugin(pluginDefinition(
      "history-bound",
      [webBinding("history-bound", [
        operation("history.read", {
          contractVersion:
            MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION,
          historicalContractVersions: maximumHistoricalVersions,
        }),
      ])],
      undefined,
      "built-in",
    )).bindings[0]?.operations[0]?.contractVersions).toHaveLength(
      MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION,
    );
    expect(() => defineProviderPlugin(pluginDefinition(
      "history-over-bound",
      [webBinding("history-over-bound", [
        operation("history.read", {
          contractVersion:
            MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION + 1,
          historicalContractVersions: [
            ...maximumHistoricalVersions,
            MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION,
          ],
        }),
      ])],
      undefined,
      "built-in",
    ))).toThrow(
      `may declare at most ${MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION - 1} historical contract versions`,
    );

    const operationsAtRegistryBound = Array.from(
      {
        length:
          MAX_PROVIDER_PLUGIN_REGISTRY_OPERATION_CONTRACTS
          / MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION,
      },
      (_, index) =>
        operation(`registry.op${index}`, {
          contractVersion:
            MAX_PROVIDER_PLUGIN_CONTRACT_VERSIONS_PER_OPERATION,
          historicalContractVersions: maximumHistoricalVersions,
        }),
    );
    const contractBoundPlugin = defineProviderPlugin(pluginDefinition(
      "registry-contract-bound",
      [webBinding("registry-contract-bound", operationsAtRegistryBound)],
      undefined,
      "source",
    ));
    expect(() => createProviderPluginRegistry([contractBoundPlugin]))
      .not.toThrow();
    const overflowPlugin = defineProviderPlugin(pluginDefinition(
      "registry-contract-overflow",
      [webBinding("registry-contract-overflow")],
      undefined,
      "source",
    ));
    expect(() => createProviderPluginRegistry([
      contractBoundPlugin,
      overflowPlugin,
    ])).toThrow(
      "provider plugin registry exceeds its exact operation contract bound",
    );
  });

  test("bounds aggregate registry routes before route-map allocation", () => {
    const plugins = Array.from(
      {
        length:
          MAX_PROVIDER_PLUGIN_REGISTRY_ROUTES
          / MAX_PROVIDER_PLUGIN_BINDINGS,
      },
      (_, pluginIndex) =>
        defineProviderPlugin(pluginDefinition(
          `route-bound-${pluginIndex}`,
          Array.from(
            { length: MAX_PROVIDER_PLUGIN_BINDINGS },
            (_, bindingIndex) =>
              webBinding(`route-${pluginIndex}-${bindingIndex}`),
          ),
        )),
    );
    expect(() => createProviderPluginRegistry(plugins)).not.toThrow();
    expect(() => createProviderPluginRegistry([
      ...plugins,
      defineProviderPlugin(pluginDefinition(
        "route-overflow",
        [webBinding("route-overflow")],
      )),
    ])).toThrow("provider plugin registry exceeds its route bound");
  });

  test("rejects duplicate IDs, routes, and exact operation contracts deterministically", () => {
    expect(() => createProviderPluginRegistry([
      pluginDefinition("same", [webBinding("one")]),
      pluginDefinition("same", [webBinding("two")]),
    ])).toThrow("duplicate provider plugin ID: same");

    const alpha = pluginDefinition("alpha", [webBinding("shared")]);
    const zeta = pluginDefinition("zeta", [webBinding("shared")]);
    const forward = rejectionMessage(() =>
      createProviderPluginRegistry([alpha, zeta]));
    const reverse = rejectionMessage(() =>
      createProviderPluginRegistry([zeta, alpha]));
    expect(forward).toBe(reverse);
    expect(forward).toContain("duplicate provider plugin route web-session-api:shared");

    expect(() => createProviderPluginRegistry([
      pluginDefinition("history", [webBinding("history", [
        operation("custom.read", {
          contractVersion: 2,
          historicalContractVersions: [1],
        }),
        operation("custom.read", { contractVersion: 1 }),
      ])], undefined, "built-in"),
    ])).toThrow("duplicate provider plugin exact contract");
  });

  test("returns binding compatibility and owner/binding/exact descriptor resolution", () => {
    const registry = createProviderPluginRegistry([
      pluginDefinition("acme", [
        webBinding("acme", [operation("acme-timeline.posts.read")]),
      ]),
    ]);
    const binding = registry.requireOperation(
      "web-session-api",
      "acme",
      "acme-timeline.posts.read",
      1,
    );
    expect(binding.surfaceId).toBe("acme");
    const resolution = registry.requireOperationDefinition(
      "web-session-api",
      "acme",
      "acme-timeline.posts.read",
      1,
    );
    expect(resolution.plugin.id).toBe("acme");
    expect(resolution.binding).toBe(binding);
    expect(resolution.operation).toMatchObject({
      name: "acme-timeline.posts.read",
      contractVersion: 1,
      sideEffect: "none",
      implementation: "inert test operation",
    });
    expect(resolution.contractVersion).toBe(1);
  });

  test("loads runtime only on first probe or execution and memoizes it", async () => {
    let loads = 0;
    const registry = createProviderPluginRegistry([
      pluginDefinition("lazy", [webBinding("lazy", [operation()], () => {
        loads += 1;
      })]),
    ]);
    const binding = registry.requireSessionRoute("lazy");
    expect(loads).toBe(0);
    expect(binding.subject.probe).toBeFunction();
    await Reflect.apply(binding.subject.probe!, undefined, [{}]);
    expect(loads).toBe(1);
    await Reflect.apply(binding.execute, undefined, [{}, {}, {}, {}, {}]);
    expect(loads).toBe(1);
  });

  test("rejects a lazy runtime invoked before registry identity binding", async () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "runtime-preload-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    let loads = 0;
    try {
      writeFileSync(pluginPath, "export const revision = 1;\n");
      const plugin = defineProviderPlugin(pluginDefinition(
        "runtime-preload",
        [webBinding("runtime-preload", [operation()], () => {
          loads += 1;
        })],
        pathToFileURL(pluginPath),
      ));
      const binding = plugin.bindings[0];
      const probe = binding?.subject.probe;
      if (probe === undefined) {
        throw new Error("runtime preload fixture has no subject probe");
      }
      expect(await Reflect.apply(probe, undefined, [{}]))
        .toBe("runtime-preload:viewer");
      expect(loads).toBe(1);

      expect(() => createProviderPluginRegistry([plugin])).toThrow(
        "runtime loader was invoked before its implementation identity was bound",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects live source replacement before the first lazy import", async () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "runtime-identity-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const runtimePath = join(directory, "runtime.ts");
    const sentinelPath = join(directory, "replacement-executed");
    let continueIdentityCheck: (() => void) | undefined;
    const identityCheckPaused = new Promise<void>((resolve) => {
      continueIdentityCheck = resolve;
    });
    let identityCheckStarted: (() => void) | undefined;
    const identityCheckReached = new Promise<void>((resolve) => {
      identityCheckStarted = resolve;
    });
    let loaderCalls = 0;
    try {
      writeFileSync(
        pluginPath,
        'import "./runtime";\nexport const plugin = "runtime-identity";\n',
      );
      writeFileSync(
        runtimePath,
        'export const probe = () => Promise.resolve("runtime-identity:before");\n',
      );
      const runtimeUrl = pathToFileURL(runtimePath).href;
      const registry = createProviderPluginRegistry([{
        ...pluginDefinition("runtime-identity", [{
          ...webBinding("runtime-identity"),
          runtime: lazyWebSessionRuntime(async () => {
            loaderCalls += 1;
            const namespace = await import(runtimeUrl) as {
              readonly probe: () => Promise<string>;
            };
            return {
              probe: namespace.probe,
              execute: () => Promise.resolve(inertExecution),
            };
          }),
        }]),
        implementationSources: [
          { label: "plugin.ts", url: pathToFileURL(pluginPath) },
          { label: "runtime.ts", url: pathToFileURL(runtimePath) },
        ],
      }], {
        beforeRuntimeLoadIdentityCheck: async (pluginId, phase) => {
          if (pluginId !== "runtime-identity" || phase !== "before") return;
          identityCheckStarted?.();
          await identityCheckPaused;
        },
      });
      const binding = registry.requireSessionRoute("runtime-identity");
      expect(loaderCalls).toBe(0);
      const probe = binding.subject.probe;
      if (probe === undefined) {
        throw new Error("runtime identity fixture has no subject probe");
      }
      const probing = Reflect.apply(probe, undefined, [{}]) as Promise<string>;
      await identityCheckReached;

      writeFileSync(
        runtimePath,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(sentinelPath)}, "executed");`,
          'export const probe = () => Promise.resolve("runtime-identity:after");',
          "",
        ].join("\n"),
      );
      continueIdentityCheck?.();

      let rejection = "";
      try {
        await probing;
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      expect(rejection).toContain(
        "implementation changed after registry startup",
      );
      expect(loaderCalls).toBe(0);
      expect(existsSync(sentinelPath)).toBeFalse();
    } finally {
      continueIdentityCheck?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never rebinds one lazy loader to a different registry identity", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "runtime-rebind-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeFileSync(pluginPath, "export const revision = 1;\n");
      const shared = pluginDefinition(
        "runtime-rebind",
        undefined,
        pathToFileURL(pluginPath),
      );
      createProviderPluginRegistry([shared]);
      writeFileSync(pluginPath, "export const revision = 2;\n");
      expect(() => createProviderPluginRegistry([shared])).toThrow(
        "runtime loader is already bound to a different implementation identity",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects raw runtime loaders that bypass the identity-aware helper", () => {
    const definition = pluginDefinition("raw-runtime");
    const binding = definition.bindings[0];
    if (binding === undefined || binding.transport === "provider-api") {
      throw new Error("raw runtime fixture is unavailable");
    }
    expect(() => defineProviderPlugin({
      ...definition,
      bindings: [{
        ...binding,
        runtime: {
          loadRuntime: () => Promise.resolve({
            probe: () => Promise.resolve("raw-runtime-site:viewer"),
            execute: () => Promise.resolve(inertExecution),
          }),
        },
      }],
    })).toThrow("must use the branded lazy runtime helper");
  });

  test("rejects a during-import replacement before its operation body runs", async () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "runtime-during-load-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const runtimePath = join(directory, "runtime.ts");
    const topLevelSentinel = join(directory, "top-level-executed");
    const operationSentinel = join(directory, "operation-executed");
    let loaderStartedResolve: (() => void) | undefined;
    const loaderStarted = new Promise<void>((resolve) => {
      loaderStartedResolve = resolve;
    });
    let continueLoaderResolve: (() => void) | undefined;
    const continueLoader = new Promise<void>((resolve) => {
      continueLoaderResolve = resolve;
    });
    try {
      writeFileSync(
        pluginPath,
        'import "./runtime";\nexport const plugin = "runtime-during-load";\n',
      );
      writeFileSync(
        runtimePath,
        'export const probe = () => Promise.resolve("runtime-during-load:before");\n',
      );
      const runtimeUrl = pathToFileURL(runtimePath).href;
      const registry = createProviderPluginRegistry([{
        ...pluginDefinition("runtime-during-load", [{
          ...webBinding("runtime-during-load"),
          runtime: lazyWebSessionRuntime(async () => {
            loaderStartedResolve?.();
            await continueLoader;
            const namespace = await import(runtimeUrl) as {
              readonly probe: () => Promise<string>;
            };
            return {
              probe: namespace.probe,
              execute: () => Promise.resolve(inertExecution),
            };
          }),
        }]),
        implementationSources: [
          { label: "plugin.ts", url: pathToFileURL(pluginPath) },
          { label: "runtime.ts", url: pathToFileURL(runtimePath) },
        ],
      }]);
      const binding = registry.requireSessionRoute("runtime-during-load");
      const probe = binding.subject.probe;
      if (probe === undefined) {
        throw new Error("during-load fixture has no subject probe");
      }
      const probing = Reflect.apply(probe, undefined, [{}]) as Promise<string>;
      await loaderStarted;

      writeFileSync(
        runtimePath,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(topLevelSentinel)}, "executed");`,
          "export const probe = () => {",
          `  writeFileSync(${JSON.stringify(operationSentinel)}, "executed");`,
          '  return Promise.resolve("runtime-during-load:after");',
          "};",
          "",
        ].join("\n"),
      );
      continueLoaderResolve?.();

      let rejection = "";
      try {
        await probing;
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      expect(rejection).toContain(
        "implementation changed after registry startup",
      );
      expect(existsSync(topLevelSentinel)).toBeTrue();
      expect(existsSync(operationSentinel)).toBeFalse();
    } finally {
      continueLoaderResolve?.();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects incomplete metadata and invalid routes while allowing source contract evolution", () => {
    const base = pluginDefinition("valid");
    const binding = base.bindings[0]!;
    if (binding.transport !== "web-session-api") {
      throw new Error("test fixture must use a web-session binding");
    }
    expect(() => defineProviderPlugin({
      ...base,
      apiVersion: 2 as 1,
    })).toThrow("unsupported API version 2");
    expect(() => defineProviderPlugin({ ...base, id: "Not-Kebab" }))
      .toThrow("strict lowercase kebab-case");
    expect(() => defineProviderPlugin({ ...base, version: "latest" }))
      .toThrow("semantic version");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{ ...binding, origin: "https://valid-site.example/path" }],
    })).toThrow("exact credential-free HTTPS origin");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{ ...binding, authKinds: ["oauth-token-file"] }],
    })).toThrow("web-session-api auth");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [operation("raw-http")],
      }],
    })).toThrow("bounded dotted semantic name");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [operation("custom.read", { contractVersion: 0 })],
      }],
    })).toThrow("invalid contract version");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [{
          ...operation("custom.read"),
          dispatch: "single",
          planDispatches: () => [{
            id: "custom.read",
            description: "unsafe read dispatch",
          }],
        }],
      }],
    })).toThrow("R1 read semantics side-effect-free and dispatch-free");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [{
          ...operation("custom.write"),
          risk: "R2",
          sideEffect: "writes remote state",
        }],
      }],
    })).toThrow("R2/R3 write");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [{
          ...operation("custom.read"),
          input: {
            properties: {
              count: {
                type: "number",
                description: "Count",
                maxLength: 10,
              },
            },
            required: ["count"],
          },
        }],
      }],
    })).toThrow("invalid string length bounds");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [{
          ...operation("custom.read"),
          input: {
            properties: {
              items: {
                type: "array",
                description: "Items",
                minItems: 0,
                maxItems: 26,
                items: {
                  type: "string",
                  description: "Item",
                },
              },
            },
            required: [],
          },
        }],
      }],
    })).toThrow("valid bounded item counts");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [{
          ...operation("custom.read"),
          input: {
            properties: {
              target: {
                type: "string",
                description: "Target",
                format: "url",
                urlPathPrefixes: ["/safe/../escape"],
              },
            },
            required: ["target"],
          },
        }],
      }],
    })).toThrow("urlPathPrefixes is invalid");
    expect(() => defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [{
          ...operation("custom.read"),
          sideEffect: "x".repeat(501),
        }],
      }],
    })).toThrow("incomplete semantics");
    const evolved = defineProviderPlugin({
      ...base,
      bindings: [{
        ...binding,
        operations: [operation("custom.read", {
          contractVersion: 2,
          historicalContractVersions: [1],
        })],
      }],
    });
    expect(evolved.bindings[0]?.operations[0]?.contractVersions).toEqual([1, 2]);

    const {
      requiredScopeSets: ignoredRequiredScopeSets,
      coverage: ignoredCoverage,
      ...providerOperation
    } = operation("custom.read");
    void ignoredRequiredScopeSets;
    void ignoredCoverage;
    const captureRequiredProvider = defineProviderPlugin({
      ...base,
      bindings: [{
        transport: "provider-api",
        surfaceId: "custom-api",
        origin: "https://api.custom.example",
        authKinds: ["oauth-token-file"],
        operations: [{
          ...providerOperation,
          state: "capture-required",
          requiredScopeSets: [["custom.read"]],
          coverage: ["custom records"],
        }],
        subject: {
          format: "custom:<id>",
          matches: (value) => value.startsWith("custom:"),
        },
        runtime: lazyProviderApiRuntime(() => Promise.resolve({
          execute: () => Promise.resolve(),
        })),
      }],
    });
    expect(captureRequiredProvider.bindings[0]?.operations[0]?.state)
      .toBe("capture-required");

    const validated = defineProviderPlugin(base);
    expect(() => createProviderPluginRegistry([{ ...validated }]))
      .toThrow("is not a validated definition");
  });

  test("freezes exact bounded provider API runtime origins", () => {
    const define = (binding: ProviderApiPluginBindingDefinitionV1) =>
      defineProviderPlugin({
        ...pluginDefinition("runtime-origin-contract"),
        bindings: [binding],
      });
    const base = providerApiBinding("runtime-origin-contract");

    expect(define(base).bindings[0]).toMatchObject({
      origin: "https://runtime-origin-contract.example",
      runtimeOrigins: ["https://runtime-origin-contract.example"],
    });
    const withAuxiliary = define({
      ...base,
      runtimeOrigins: [
        "https://runtime-origin-contract.example",
        "https://people.example",
      ],
    });
    const binding = withAuxiliary.bindings[0];
    if (binding?.transport !== "provider-api") {
      throw new Error("provider API runtime-origin fixture is unavailable");
    }
    expect(binding.runtimeOrigins).toEqual([
      "https://people.example",
      "https://runtime-origin-contract.example",
    ]);
    expect(Object.isFrozen(binding.runtimeOrigins)).toBeTrue();
    expect(binding.protectedHostnameFamilies).toEqual([
      "people.example",
      "runtime-origin-contract.example",
    ]);

    for (const runtimeOrigin of [
      "https://people.example/contacts",
      "https://user@people.example",
      "https://people.example?token=sink",
    ] as const) {
      expect(() => define({
        ...base,
        runtimeOrigins: [base.origin, runtimeOrigin],
      })).toThrow("exact credential-free HTTPS runtime origins");
    }
    expect(() => define({
      ...base,
      runtimeOrigins: [base.origin, base.origin],
    })).toThrow("repeats a runtime origin");
    expect(() => define({
      ...base,
      runtimeOrigins: ["https://people.example"],
    })).toThrow("must include its primary origin");
    expect(() => define({
      ...base,
      runtimeOrigins: [base.origin, "https://people.example"],
      protectedHostnameFamilies: ["runtime-origin-contract.example"],
    })).toThrow("protected hostname families do not cover people.example");
    expect(() => define({
      ...base,
      runtimeOrigins: Array.from(
        { length: 21 },
        (_unused, index): `https://${string}` =>
          `https://api-${index}.example`,
      ),
    })).toThrow("runtimeOrigins");
    const invalidWebRuntimeOrigin: WebSessionApiPluginBindingDefinitionV1 & {
      readonly runtimeOrigins: readonly `https://${string}`[];
    } = {
      ...webBinding("web-runtime-origin"),
      runtimeOrigins: ["https://web-runtime-origin.example"],
    };
    expect(() => defineProviderPlugin({
      ...pluginDefinition("web-runtime-origin"),
      bindings: [invalidWebRuntimeOrigin],
    })).toThrow("unsupported keys: runtimeOrigins");
  });

  test("hashes one owning-plugin snapshot and isolates unrelated registry snapshots", () => {
    const directory = mkdtempSync(join(import.meta.dir, ".provider-plugin-test-"));
    const alphaPath = join(directory, "alpha.ts");
    const zetaPath = join(directory, "zeta.ts");
    try {
      writeFileSync(alphaPath, "export const value = 1;\n");
      writeFileSync(zetaPath, "export const value = 1;\n");
      const definitions = () => [
        pluginDefinition("alpha", undefined, pathToFileURL(alphaPath)),
        pluginDefinition("zeta", undefined, pathToFileURL(zetaPath)),
      ];
      const before = createProviderPluginRegistry(definitions());
      const alphaBefore = before.implementationHash(
        before.requireSessionRoute("alpha-site"),
      ).toString("hex");
      const zetaBefore = before.implementationHash(
        before.requireSessionRoute("zeta-site"),
      ).toString("hex");

      writeFileSync(alphaPath, "export const value = 2;\n");
      const after = createProviderPluginRegistry(definitions());
      const alphaAfter = after.implementationHash(
        after.requireSessionRoute("alpha-site"),
      ).toString("hex");
      const zetaAfter = after.implementationHash(
        after.requireSessionRoute("zeta-site"),
      ).toString("hex");
      expect(alphaAfter).not.toBe(alphaBefore);
      expect(zetaAfter).toBe(zetaBefore);

      writeFileSync(alphaPath, "export const value = 3;\n");
      const startupSnapshot = createProviderPluginRegistry(definitions());
      const startupHash = startupSnapshot.implementationHash(
        startupSnapshot.requireSessionRoute("alpha-site"),
      ).toString("hex");
      writeFileSync(alphaPath, "export const value = 4;\n");
      expect(startupSnapshot.implementationHash(
        startupSnapshot.requireSessionRoute("alpha-site"),
      ).toString("hex")).toBe(startupHash);
      const freshRegistry = createProviderPluginRegistry(definitions());
      const freshHash = freshRegistry.implementationHash(
        freshRegistry.requireSessionRoute("alpha-site"),
      ).toString("hex");
      expect(freshHash).not.toBe(alphaAfter);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("shares one coherent source snapshot and revalidates it before return", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "source-read-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeInstalledDependency(directory, "wrench-registry-shared-source");
      writeFileSync(
        pluginPath,
        'import "wrench-registry-shared-source";\nexport const value = 1;\n',
      );
      const reads = new Map<string, number>();
      const dependencyReads = new Map<string, number>();
      const registry = createProviderPluginRegistry(
        [
          pluginDefinition(
            "source-read-alpha",
            undefined,
            pathToFileURL(pluginPath),
          ),
          pluginDefinition(
            "source-read-zeta",
            undefined,
            pathToFileURL(pluginPath),
          ),
        ],
        {
          readImplementationSource: (_pluginId, source) => {
            reads.set(source.path, (reads.get(source.path) ?? 0) + 1);
            return readFileSync(source.path);
          },
          readDependencySource: (path) => {
            dependencyReads.set(path, (dependencyReads.get(path) ?? 0) + 1);
            return readFileSync(path);
          },
        },
      );
      const alphaBinding = registry.requireSessionRoute(
        "source-read-alpha-site",
      );
      const zetaBinding = registry.requireSessionRoute(
        "source-read-zeta-site",
      );

      expect(reads).toEqual(new Map([[pluginPath, 2]]));
      const alphaFirst = registry.implementationHash(alphaBinding);
      const alphaSecond = registry.implementationHash(alphaBinding);
      const zetaFirst = registry.implementationHash(zetaBinding);
      const zetaSecond = registry.implementationHash(zetaBinding);
      expect(alphaSecond).toEqual(alphaFirst);
      expect(alphaSecond).not.toBe(alphaFirst);
      expect(zetaSecond).toEqual(zetaFirst);
      expect(zetaSecond).not.toBe(zetaFirst);
      expect(reads).toEqual(new Map([[pluginPath, 2]]));
      for (const [path, count] of dependencyReads) {
        expect(count, path).toBe(
          path.includes(`${sep}node_modules${sep}`) ? 1 : 2,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects repository source drift across the complete registry build", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "registry-source-drift-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const helperPath = join(directory, "helper.ts");
    let mutated = false;
    try {
      writeFileSync(
        pluginPath,
        'import "./helper";\nexport const revision = 1;\n',
      );
      writeFileSync(helperPath, "export const helper = true;\n");
      expect(() => createProviderPluginRegistry([
        pluginDefinition(
          "registry-source-drift",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ], {
        readDependencySource: (path) => {
          const bytes = readFileSync(path);
          if (path === helperPath && !mutated) {
            mutated = true;
            writeFileSync(
              pluginPath,
              'import "./helper";\nexport const revision = 2;\n',
            );
          }
          return bytes;
        },
      })).toThrow("changed before registry startup completed");
      expect(mutated).toBeTrue();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps unrelated lockfile changes outside exact package identity", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "dependency-snapshot-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeInstalledDependency(directory, "wrench-registry-lock-independent");
      writeFileSync(
        pluginPath,
        'import "wrench-registry-lock-independent";\nexport const value = 1;\n',
      );
      let lockReads = 0;
      const definition = () => pluginDefinition(
        "dependency-snapshot",
        undefined,
        pathToFileURL(pluginPath),
      );
      const before = createProviderPluginRegistry([definition()], {
        readDependencySource: (path) => {
          if (path.endsWith("bun.lock")) lockReads += 1;
          return readFileSync(path);
        },
      });
      const beforeHash = before.implementationHash(
        before.requireSessionRoute("dependency-snapshot-site"),
      ).toString("hex");
      const fresh = createProviderPluginRegistry([definition()], {
        readDependencySource: (path) => {
          if (path.endsWith("bun.lock")) lockReads += 1;
          return readFileSync(path);
        },
      });
      const freshHash = fresh.implementationHash(
        fresh.requireSessionRoute("dependency-snapshot-site"),
      ).toString("hex");

      expect(freshHash).toBe(beforeHash);
      expect(lockReads).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds installed bytes and rejects drift before runtime load", async () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-byte-drift-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    let runtimeLoads = 0;
    try {
      const dependency = writeInstalledDependency(
        directory,
        "wrench-registry-byte-drift",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-byte-drift";\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "installed-byte-drift",
        [webBinding("installed-byte-drift", [operation()], () => {
          runtimeLoads += 1;
        })],
        pathToFileURL(pluginPath),
      );
      const before = createProviderPluginRegistry([definition()]);
      const beforeBinding = before.requireSessionRoute(
        "installed-byte-drift",
      );
      const beforeHash = before.implementationHash(beforeBinding)
        .toString("hex");

      writeFileSync(dependency.entry, "export const value = 2;\n");
      const after = createProviderPluginRegistry([definition()]);
      expect(after.implementationHash(
        after.requireSessionRoute("installed-byte-drift"),
      ).toString("hex")).not.toBe(beforeHash);

      const probe = beforeBinding.subject.probe;
      if (probe === undefined) throw new Error("byte-drift fixture has no probe");
      let rejection = "";
      try {
        await (Reflect.apply(probe, undefined, [{}]) as Promise<string>);
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      }
      expect(rejection).toContain(
        "implementation changed after registry startup",
      );
      expect(runtimeLoads).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds an npm alias install key separately from canonical package identity", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-alias-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const alias = writeInstalledDependency(
        directory,
        "wrench-registry-alias",
      );
      const manifest = JSON.parse(
        readFileSync(alias.manifest, "utf8"),
      ) as Record<string, unknown>;
      manifest.name = "wrench-registry-canonical";
      writeFileSync(alias.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileSync(
        pluginPath,
        'import "wrench-registry-alias";\nexport const plugin = true;\n',
      );

      const registry = createProviderPluginRegistry([
        pluginDefinition(
          "installed-alias",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ]);
      expect(registry.implementationHash(
        registry.requireSessionRoute("installed-alias-site"),
      ).toString("hex")).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("resolves a Bun-style canonical alias through a parent package manifest", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-canonical-alias-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const ownerStore = join(
        directory,
        "node_modules",
        ".bun",
        "wrench-registry-alias-owner@1.0.0",
      );
      const owner = writeInstalledDependency(
        ownerStore,
        "wrench-registry-alias-owner",
        {
          dependencies: {
            "wrench-registry-alias-key":
              "npm:wrench-registry-alias-canonical@1.0.0",
          },
          source:
            'import "wrench-registry-alias-key";\nexport const owner = true;\n',
        },
      );
      const canonicalStore = join(
        directory,
        "node_modules",
        ".bun",
        "wrench-registry-alias-canonical@1.0.0",
      );
      const canonical = writeInstalledDependency(
        canonicalStore,
        "wrench-registry-alias-canonical",
      );
      symlinkSync(
        canonical.root,
        join(dirname(owner.root), "wrench-registry-alias-key"),
        "dir",
      );
      symlinkSync(
        owner.root,
        join(directory, "node_modules", "wrench-registry-alias-owner"),
        "dir",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-alias-owner";\nexport const plugin = true;\n',
      );

      const registry = createProviderPluginRegistry([
        pluginDefinition(
          "installed-canonical-alias",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ]);
      expect(registry.implementationHash(
        registry.requireSessionRoute("installed-canonical-alias-site"),
      ).toString("hex")).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a package file changed after it was already read", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-tree-race-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const dependency = writeInstalledDependency(
        directory,
        "wrench-registry-tree-race",
      );
      const earlyPath = join(dependency.root, "a-early.js");
      const latePath = join(dependency.root, "z-late.js");
      writeFileSync(earlyPath, "export const early = 1;\n");
      writeFileSync(latePath, "export const late = 1;\n");
      writeFileSync(
        pluginPath,
        'import "wrench-registry-tree-race";\nexport const plugin = true;\n',
      );
      let earlyRead = false;
      let mutated = false;

      expect(() => createProviderPluginRegistry([
        pluginDefinition(
          "installed-tree-race",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ], {
        readDependencySource: (path) => {
          const bytes = readFileSync(path);
          if (path === earlyPath) earlyRead = true;
          if (path === latePath && earlyRead && !mutated) {
            mutated = true;
            writeFileSync(earlyPath, "export const early = 2;\n");
          }
          return bytes;
        },
      })).toThrow("changed while");
      expect(mutated).toBeTrue();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects shared package drift between plugin startup snapshots", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-cache-drift-test-"),
    );
    const alphaPath = join(directory, "alpha.ts");
    const zetaPath = join(directory, "zeta.ts");
    try {
      const dependency = writeInstalledDependency(
        directory,
        "wrench-registry-cache-drift",
      );
      const source =
        'import "wrench-registry-cache-drift";\nexport const plugin = true;\n';
      writeFileSync(alphaPath, source);
      writeFileSync(zetaPath, source);
      let mutated = false;

      expect(() => createProviderPluginRegistry([
        pluginDefinition(
          "cache-drift-zeta",
          undefined,
          pathToFileURL(zetaPath),
        ),
        pluginDefinition(
          "cache-drift-alpha",
          undefined,
          pathToFileURL(alphaPath),
        ),
      ], {
        readImplementationSource: (_pluginId, implementationSource) => {
          if (implementationSource.path === zetaPath && !mutated) {
            mutated = true;
            writeFileSync(dependency.entry, "export const value = 2;\n");
          }
          return readFileSync(implementationSource.path);
        },
      })).toThrow("installed package closure changed while its identity was built");
      expect(mutated).toBeTrue();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps installed package identity stable across relocation", () => {
    const parent = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-relocation-test-"),
    );
    const first = join(parent, "first");
    const second = join(parent, "second");
    try {
      mkdirSync(first);
      writeInstalledDependency(first, "wrench-registry-relocation");
      const firstPlugin = join(first, "plugin.ts");
      writeFileSync(
        firstPlugin,
        'import "wrench-registry-relocation";\nexport const plugin = true;\n',
      );
      const before = createProviderPluginRegistry([
        pluginDefinition(
          "installed-relocation",
          undefined,
          pathToFileURL(firstPlugin),
        ),
      ]);
      const beforeHash = before.implementationHash(
        before.requireSessionRoute("installed-relocation-site"),
      ).toString("hex");

      renameSync(first, second);
      const after = createProviderPluginRegistry([
        pluginDefinition(
          "installed-relocation",
          undefined,
          pathToFileURL(join(second, "plugin.ts")),
        ),
      ]);
      expect(after.implementationHash(
        after.requireSessionRoute("installed-relocation-site"),
      ).toString("hex")).toBe(beforeHash);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("canonicalizes installed package modes without erasing executable identity", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-mode-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const dependency = writeInstalledDependency(
        directory,
        "wrench-registry-mode",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-mode";\nexport const plugin = true;\n',
      );
      const identity = (): string => {
        const registry = createProviderPluginRegistry([
          pluginDefinition(
            "installed-mode",
            undefined,
            pathToFileURL(pluginPath),
          ),
        ]);
        return registry.implementationHash(
          registry.requireSessionRoute("installed-mode-site"),
        ).toString("hex");
      };

      chmodSync(dependency.root, 0o700);
      chmodSync(dependency.entry, 0o644);
      const baseline = identity();
      chmodSync(dependency.root, 0o755);
      expect(identity()).toBe(baseline);
      chmodSync(dependency.entry, 0o666);
      expect(identity()).toBe(baseline);
      chmodSync(dependency.entry, 0o766);
      expect(identity()).not.toBe(baseline);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses Bun's extensionless resolver order for repository dependencies", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "repository-resolution-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const workspaceRoot = join(directory, "workspace");
    const entryPath = join(workspaceRoot, "index.ts");
    const tsPath = join(workspaceRoot, "dep.ts");
    const jsPath = join(workspaceRoot, "dep.js");
    try {
      mkdirSync(workspaceRoot);
      writeFileSync(
        join(workspaceRoot, "package.json"),
        `${JSON.stringify({
          name: "wrench-registry-resolution",
          version: "1.0.0",
          main: "./index.ts",
        }, null, 2)}\n`,
      );
      writeFileSync(entryPath, 'import "./dep";\nexport const entry = true;\n');
      writeFileSync(tsPath, "export const selected = 'ts';\n");
      writeFileSync(jsPath, "export const selected = 'js';\n");
      mkdirSync(join(directory, "node_modules"));
      symlinkSync(
        workspaceRoot,
        join(directory, "node_modules", "wrench-registry-resolution"),
        "dir",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-resolution";\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "repository-resolution",
        undefined,
        pathToFileURL(pluginPath),
      );
      const hash = () => {
        const registry = createProviderPluginRegistry([definition()]);
        return registry.implementationHash(
          registry.requireSessionRoute("repository-resolution-site"),
        ).toString("hex");
      };
      const before = hash();

      writeFileSync(jsPath, "export const selected = 'JS';\n");
      expect(hash()).toBe(before);

      writeFileSync(tsPath, "export const selected = 'TS';\n");
      expect(hash()).not.toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("ignores type-only imports and rejects configuration-dependent JSX or TSX", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "repository-jsx-tsx-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const jsxPath = join(directory, "view.jsx");
    const tsxPath = join(directory, "panel.tsx");
    try {
      writeFileSync(jsxPath, "export const view = <section />;\n");
      writeFileSync(tsxPath, "export const panel: unknown = <aside />;\n");
      const definition = () => pluginDefinition(
        "repository-jsx-tsx",
        undefined,
        pathToFileURL(pluginPath),
      );
      writeFileSync(
        pluginPath,
        'import type { Missing } from "wrench-registry-type-only-missing";\nexport const plugin: Missing | true = true;\n',
      );
      expect(() => createProviderPluginRegistry([definition()])).not.toThrow();

      writeFileSync(pluginPath, 'import "./view.jsx";\n');
      expect(() => createProviderPluginRegistry([definition()]))
        .toThrow("configuration-dependent JSX or TSX");

      writeFileSync(pluginPath, 'import "./panel.tsx";\n');
      expect(() => createProviderPluginRegistry([definition()]))
        .toThrow("configuration-dependent JSX or TSX");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("distinguishes same-version physical package occurrences and peer contexts", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-occurrence-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const alphaOwner = writeInstalledDependency(
        directory,
        "wrench-registry-occurrence-owner-alpha",
        {
          dependencies: { "wrench-registry-shared-occurrence": "1.0.0" },
        },
      );
      const zetaOwner = writeInstalledDependency(
        directory,
        "wrench-registry-occurrence-owner-zeta",
        {
          dependencies: { "wrench-registry-shared-occurrence": "1.0.0" },
        },
      );
      const alpha = writeInstalledDependency(
        alphaOwner.root,
        "wrench-registry-shared-occurrence",
        {
          source: "export const occurrence = 'alpha';\n",
          peerDependencies: { "wrench-registry-occurrence-peer": "*" },
        },
      );
      const zeta = writeInstalledDependency(
        zetaOwner.root,
        "wrench-registry-shared-occurrence",
        {
          source: "export const occurrence = 'zeta';\n",
          peerDependencies: { "wrench-registry-occurrence-peer": "*" },
        },
      );
      writeInstalledDependency(
        alpha.root,
        "wrench-registry-occurrence-peer",
        { version: "1.0.0" },
      );
      writeInstalledDependency(
        zeta.root,
        "wrench-registry-occurrence-peer",
        { version: "2.0.0" },
      );
      writeFileSync(
        pluginPath,
        [
          'import "wrench-registry-occurrence-owner-alpha";',
          'import "wrench-registry-occurrence-owner-zeta";',
          "export const plugin = true;",
          "",
        ].join("\n"),
      );
      const definition = () => pluginDefinition(
        "installed-occurrence",
        undefined,
        pathToFileURL(pluginPath),
      );
      const first = createProviderPluginRegistry([definition()]);
      const firstHash = first.implementationHash(
        first.requireSessionRoute("installed-occurrence-site"),
      ).toString("hex");
      const repeated = createProviderPluginRegistry([definition()]);
      expect(repeated.implementationHash(
        repeated.requireSessionRoute("installed-occurrence-site"),
      ).toString("hex")).toBe(firstHash);

      writeFileSync(alpha.entry, "export const occurrence = 'ALPHA';\n");
      const changed = createProviderPluginRegistry([definition()]);
      expect(changed.implementationHash(
        changed.requireSessionRoute("installed-occurrence-site"),
      ).toString("hex")).not.toBe(firstHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds transitive package bytes and exact entry resolution", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-transitive-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const transitive = writeInstalledDependency(
        directory,
        "wrench-registry-transitive",
      );
      const direct = writeInstalledDependency(
        directory,
        "wrench-registry-direct",
        {
          dependencies: { "wrench-registry-transitive": "1.0.0" },
          source:
            'import "wrench-registry-transitive";\nexport const value = 1;\n',
        },
      );
      writeFileSync(
        join(direct.root, "alternate.js"),
        "export const value = 1;\n",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-direct";\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "installed-transitive",
        undefined,
        pathToFileURL(pluginPath),
      );
      const first = createProviderPluginRegistry([definition()]);
      const firstHash = first.implementationHash(
        first.requireSessionRoute("installed-transitive-site"),
      ).toString("hex");

      writeFileSync(transitive.entry, "export const value = 2;\n");
      const transitiveChanged = createProviderPluginRegistry([definition()]);
      const transitiveHash = transitiveChanged.implementationHash(
        transitiveChanged.requireSessionRoute("installed-transitive-site"),
      ).toString("hex");
      expect(transitiveHash).not.toBe(firstHash);

      writeFileSync(transitive.entry, "export const value = 1;\n");
      const manifestValue = JSON.parse(
        readFileSync(direct.manifest, "utf8"),
      ) as Record<string, unknown>;
      manifestValue.main = "./alternate.js";
      writeFileSync(direct.manifest, `${JSON.stringify(manifestValue, null, 2)}\n`);
      const entryChanged = createProviderPluginRegistry([definition()]);
      const entryChangedHash = entryChanged.implementationHash(
        entryChanged.requireSessionRoute("installed-transitive-site"),
      ).toString("hex");
      expect(entryChangedHash).not.toBe(firstHash);

      const alternateTarget = writeInstalledDependency(
        directory,
        "wrench-registry-alternate-target",
      );
      writeInstalledDependency(
        directory,
        "wrench-registry-entry-direct",
        {
          entry: "alternate.js",
          source:
            'import "wrench-registry-alternate-target";\nexport const value = 1;\n',
        },
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-entry-direct";\nexport const plugin = true;\n',
      );
      const traversed = createProviderPluginRegistry([definition()]);
      const traversedHash = traversed.implementationHash(
        traversed.requireSessionRoute("installed-transitive-site"),
      ).toString("hex");
      writeFileSync(alternateTarget.entry, "export const value = 2;\n");
      const targetChanged = createProviderPluginRegistry([definition()]);
      expect(targetChanged.implementationHash(
        targetChanged.requireSessionRoute("installed-transitive-site"),
      ).toString("hex")).not.toBe(traversedHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds undeclared hoisted imports from installed executable code", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-hoisted-import-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeInstalledDependency(
        directory,
        "wrench-registry-hoisted-owner",
        {
          source: [
            'import "wrench-registry-hoisted-target";',
            "export const owner = true;",
            "",
          ].join("\n"),
        },
      );
      const target = writeInstalledDependency(
        directory,
        "wrench-registry-hoisted-target",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-hoisted-owner";\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "installed-hoisted-import",
        undefined,
        pathToFileURL(pluginPath),
      );
      const before = createProviderPluginRegistry([definition()]);
      const beforeHash = before.implementationHash(
        before.requireSessionRoute("installed-hoisted-import-site"),
      ).toString("hex");

      writeFileSync(target.entry, "export const value = 2;\n");
      const after = createProviderPluginRegistry([definition()]);
      expect(after.implementationHash(
        after.requireSessionRoute("installed-hoisted-import-site"),
      ).toString("hex")).not.toBe(beforeHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses require conditions when tracing an installed executable closure", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-require-condition-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const owner = writeInstalledDependency(
        directory,
        "wrench-registry-require-owner",
        {
          entry: "require.js",
          source:
            'require("wrench-registry-require-target");\nexports.owner = true;\n',
        },
      );
      writeFileSync(
        join(owner.root, "import.js"),
        "export const owner = true;\n",
      );
      writeFileSync(
        owner.manifest,
        `${JSON.stringify({
          name: "wrench-registry-require-owner",
          version: "1.0.0",
          exports: {
            ".": {
              import: "./import.js",
              require: "./require.js",
            },
          },
        }, null, 2)}\n`,
      );
      const target = writeInstalledDependency(
        directory,
        "wrench-registry-require-target",
      );
      writeFileSync(
        pluginPath,
        'require("wrench-registry-require-owner");\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "installed-require-condition",
        undefined,
        pathToFileURL(pluginPath),
      );
      const before = createProviderPluginRegistry([definition()]);
      const beforeHash = before.implementationHash(
        before.requireSessionRoute("installed-require-condition-site"),
      ).toString("hex");

      writeFileSync(target.entry, "export const value = 2;\n");
      const after = createProviderPluginRegistry([definition()]);
      expect(after.implementationHash(
        after.requireSessionRoute("installed-require-condition-site"),
      ).toString("hex")).not.toBe(beforeHash);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps import and require resolution edges distinct", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-dual-condition-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const dual = writeInstalledDependency(
        directory,
        "wrench-registry-dual-condition",
        { entry: "require.js" },
      );
      writeFileSync(
        join(dual.root, "import.js"),
        "export const condition = 'import';\n",
      );
      writeFileSync(
        dual.entry,
        "exports.condition = 'require';\n",
      );
      writeFileSync(
        dual.manifest,
        `${JSON.stringify({
          name: "wrench-registry-dual-condition",
          version: "1.0.0",
          exports: {
            ".": {
              import: "./import.js",
              require: "./require.js",
            },
          },
        }, null, 2)}\n`,
      );
      writeFileSync(
        pluginPath,
        [
          'import "wrench-registry-dual-condition";',
          'require("wrench-registry-dual-condition");',
          "export const plugin = true;",
          "",
        ].join("\n"),
      );

      const registry = createProviderPluginRegistry([
        pluginDefinition(
          "installed-dual-condition",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ]);
      expect(registry.implementationHash(
        registry.requireSessionRoute("installed-dual-condition-site"),
      ).toString("hex")).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-literal module load in installed executable code", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-nonliteral-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeFileSync(
        pluginPath,
        'import "wrench-registry-nonliteral";\nexport const plugin = true;\n',
      );
      for (const source of [
        [
            'const dependency = "wrench-registry-hidden";',
            "require(dependency);",
            "export const owner = true;",
            "",
        ].join("\n"),
        [
          'const dependency = "wrench-registry-hidden";',
          "const load = require;",
          "load(dependency);",
          "",
        ].join("\n"),
        'module.require("wrench-registry-hidden");\n',
        [
          'const dependency = "wrench-registry-hidden";',
          'module["require"](dependency);',
          "",
        ].join("\n"),
        [
          'const marker = /"/;',
          'const dependency = "wrench-registry-hidden";',
          "require(dependency);",
          "export { marker };",
          "",
        ].join("\n"),
        [
          'const dependency = "wrench-registry-hidden";',
          "globalThis.require(dependency);",
          "",
        ].join("\n"),
        [
          'import { createRequire } from "node:module";',
          "const load = createRequire(import.meta.url);",
          'load("wrench-registry-hidden");',
          "",
        ].join("\n"),
      ]) {
        writeInstalledDependency(
          directory,
          "wrench-registry-nonliteral",
          { source },
        );
        expect(() => createProviderPluginRegistry([
          pluginDefinition(
            "installed-nonliteral",
            undefined,
            pathToFileURL(pluginPath),
          ),
        ])).toThrow("non-literal module load");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects unresolved static imports in installed executable code", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-static-missing-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeInstalledDependency(
        directory,
        "wrench-registry-static-missing",
        {
          source:
            'import "wrench-registry-never-installed";\nexport const owner = true;\n',
        },
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-static-missing";\nexport const plugin = true;\n',
      );
      expect(() => createProviderPluginRegistry([
        pluginDefinition(
          "installed-static-missing",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ])).toThrow("unresolved static dependency");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds reviewed built-in dynamic-load exceptions to exact module bytes", () => {
    const repositoryPackageRootPath = join(
      providerPluginRepositoryRoot,
      "packages/kb/src/clip/package-root.ts",
    );
    const repositoryAcquisitionPath = join(
      providerPluginRepositoryRoot,
      "packages/kb/src/clip/acquire.ts",
    );
    const repositoryLayout = existsSync(repositoryPackageRootPath);
    const installedKbDynamicModulePath = repositoryLayout
      ? undefined
      : resolveInstalledKbDynamicModulePath();
    const packageRootPath = repositoryLayout
      ? repositoryPackageRootPath
      : installedKbDynamicModulePath as string;
    const acquisitionPath = repositoryLayout
      ? repositoryAcquisitionPath
      : installedKbDynamicModulePath as string;
    const packageRootSource = readFileSync(packageRootPath, "utf8");
    const acquisitionSource = readFileSync(acquisitionPath, "utf8");
    expect(packageRootSource.match(
      /createRequire\(parentUrl\)\.resolve\(`\$\{packageName\}\/package\.json`\)/gu,
    )).toHaveLength(1);
    expect(acquisitionSource.match(
      /resolvePackageDirectory\("agent-browser"\)/gu,
    )).toHaveLength(1);
    expect(acquisitionSource.match(
      /resolvePackageDirectory\([^)]*\)/gu,
    )).toHaveLength(repositoryLayout ? 1 : 2);

    const metaPlugin = providerPluginRegistry.get("meta-web");
    if (metaPlugin === undefined) {
      throw new Error("meta-web built-in fixture is unavailable");
    }
    let kbResolutionMutated = false;
    expect(() => createProviderPluginRegistry([metaPlugin], {
      readDependencySource: (path) => {
        const bytes = readFileSync(path);
        if (path !== packageRootPath) {
          return bytes;
        }
        const source = bytes.toString("utf8");
        const changed = source.replace(
          "$" + "{packageName}/package.json",
          "$" + "{packageNamE}/package.json",
        );
        if (changed === source || changed.length !== source.length) {
          throw new Error("KB dynamic-resolution fixture did not match");
        }
        kbResolutionMutated = true;
        return Buffer.from(changed, "utf8");
      },
    })).toThrow("dynamic-resolution module");
    expect(kbResolutionMutated).toBeTrue();

    let kbCallSiteMutated = false;
    expect(() => createProviderPluginRegistry([metaPlugin], {
      readDependencySource: (path) => {
        const bytes = readFileSync(path);
        if (path !== acquisitionPath) return bytes;
        const source = bytes.toString("utf8");
        const changed = source.replace(
          'resolvePackageDirectory("agent-browser")',
          'resolvePackageDirectory("other-browser")',
        );
        if (changed === source) {
          throw new Error("KB dynamic-resolution call-site fixture did not match");
        }
        kbCallSiteMutated = true;
        return Buffer.from(changed, "utf8");
      },
    })).toThrow();
    expect(kbCallSiteMutated).toBeTrue();

    let mutated = false;
    expect(() => createProviderPluginRegistry([metaPlugin], {
      readDependencySource: (path) => {
        const bytes = readFileSync(path);
        if (!path.endsWith("/typescript/lib/typescript.js")) return bytes;
        const source = bytes.toString("utf8");
        const changed = source.replace(
          "require(modulePath)",
          "require(modulePatH)",
        );
        if (changed === source || changed.length !== source.length) {
          throw new Error("TypeScript dynamic-load fixture did not match");
        }
        mutated = true;
        return Buffer.from(changed, "utf8");
      },
    })).toThrow();
    expect(mutated).toBeTrue();

    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "dynamic-exception-scope-test-"),
    );
    try {
      const pluginPath = join(directory, "plugin.ts");
      writeFileSync(
        pluginPath,
        'import "typescript";\nexport const plugin = true;\n',
      );
      expect(() => createProviderPluginRegistry([
        pluginDefinition(
          "unreviewed-dynamic-built-in",
          undefined,
          pathToFileURL(pluginPath),
          "built-in",
        ),
      ])).toThrow("non-literal module load");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds only statically reached installed dependencies and skips runtime builtins", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-reachable-only-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const owner = writeInstalledDependency(
        directory,
        "wrench-registry-reachable-owner",
        {
          dependencies: {
            buffer: "5.7.1",
            "wrench-registry-reachable": "1.0.0",
            "wrench-registry-unused": "1.0.0",
          },
          source: [
            'import "buffer";',
            'import "node:fs";',
            'import "wrench-registry-reachable";',
            "export const owner = true;",
            "",
          ].join("\n"),
        },
      );
      const builtinShadow = writeInstalledDependency(directory, "buffer");
      const reachable = writeInstalledDependency(
        directory,
        "wrench-registry-reachable",
      );
      const unused = writeInstalledDependency(
        directory,
        "wrench-registry-unused",
        {
          dependencies: {
            "wrench-registry-unused-missing": "1.0.0",
          },
        },
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-reachable-owner";\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "installed-reachable-only",
        undefined,
        pathToFileURL(pluginPath),
      );
      const identity = (): string => {
        const registry = createProviderPluginRegistry([definition()]);
        return registry.implementationHash(
          registry.requireSessionRoute("installed-reachable-only-site"),
        ).toString("hex");
      };

      const baseline = identity();
      writeFileSync(builtinShadow.entry, "export const value = 2;\n");
      writeFileSync(unused.entry, "export const value = 2;\n");
      expect(identity()).toBe(baseline);

      writeFileSync(reachable.entry, "export const value = 2;\n");
      expect(identity()).not.toBe(baseline);
      expect(readFileSync(owner.entry, "utf8")).toContain('import "buffer";');
      expect(readFileSync(unused.manifest, "utf8"))
        .toContain("wrench-registry-unused-missing");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a relative workspace dependency that escapes the repository", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "workspace-escape-test-"),
    );
    const outside = mkdtempSync(
      join(tmpdir(), "wrench-registry-workspace-escape-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const workspaceRoot = join(directory, "workspace-source");
    const workspaceEntry = join(workspaceRoot, "index.js");
    try {
      const outsidePath = join(outside, "outside.js");
      writeFileSync(outsidePath, "export const outside = true;\n");
      mkdirSync(workspaceRoot);
      writeFileSync(
        join(workspaceRoot, "package.json"),
        `${JSON.stringify({
          name: "wrench-registry-workspace-escape",
          version: "1.0.0",
          main: "./index.js",
        }, null, 2)}\n`,
      );
      const escapeSpecifier = relative(dirname(workspaceEntry), outsidePath)
        .split(sep).join("/");
      writeFileSync(
        workspaceEntry,
        `import ${JSON.stringify(escapeSpecifier)};\nexport const workspace = true;\n`,
      );
      mkdirSync(join(directory, "node_modules"));
      symlinkSync(
        workspaceRoot,
        join(directory, "node_modules", "wrench-registry-workspace-escape"),
        "dir",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-workspace-escape";\nexport const plugin = true;\n',
      );

      expect(() => createProviderPluginRegistry([
        pluginDefinition(
          "workspace-escape",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ])).toThrow("outside the repository");
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("terminates installed dependency cycles", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-cycle-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeInstalledDependency(
        directory,
        "wrench-registry-cycle-alpha",
        {
          dependencies: { "wrench-registry-cycle-zeta": "1.0.0" },
          source:
            'import "wrench-registry-cycle-zeta";\nexport const alpha = true;\n',
        },
      );
      writeInstalledDependency(
        directory,
        "wrench-registry-cycle-zeta",
        {
          dependencies: { "wrench-registry-cycle-alpha": "1.0.0" },
          source:
            'import "wrench-registry-cycle-alpha";\nexport const zeta = true;\n',
        },
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-cycle-alpha";\nexport const plugin = true;\n',
      );
      const registry = createProviderPluginRegistry([
        pluginDefinition(
          "installed-cycle",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ]);
      expect(registry.implementationHash(
        registry.requireSessionRoute("installed-cycle-site"),
      ).toString("hex")).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects an installed dependency graph over its depth bound", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-graph-depth-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const packageNames = Array.from(
        { length: 40 },
        (_, index) => `wrench-registry-depth-${index.toString().padStart(2, "0")}`,
      );
      for (const [index, name] of packageNames.entries()) {
        const child = packageNames[index + 1];
        writeInstalledDependency(
          directory,
          name,
          child === undefined
            ? {}
            : {
              dependencies: { [child]: "1.0.0" },
              source: `import ${JSON.stringify(child)};\nexport const value = true;\n`,
            },
        );
      }
      writeFileSync(
        pluginPath,
        `import ${JSON.stringify(packageNames[0])};\nexport const plugin = true;\n`,
      );

      expect(() => createProviderPluginRegistry([
        pluginDefinition(
          "installed-graph-depth",
          undefined,
          pathToFileURL(pluginPath),
        ),
      ])).toThrow("depth");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects malformed package versions and unresolved static peer imports", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-manifest-laws-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeInstalledDependency(
        directory,
        "wrench-registry-manifest-laws",
        { version: "latest" },
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-manifest-laws";\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "installed-manifest-laws",
        undefined,
        pathToFileURL(pluginPath),
      );
      expect(() => createProviderPluginRegistry([definition()]))
        .toThrow(/invalid identity|semantic version/u);

      writeInstalledDependency(
        directory,
        "wrench-registry-manifest-laws",
        {
          peerDependencies: {
            "wrench-registry-required-peer": "1.0.0",
          },
          source:
            'import "wrench-registry-required-peer";\nexport const value = true;\n',
        },
      );
      expect(() => createProviderPluginRegistry([definition()]))
        .toThrow("unresolved static dependency");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects links and unresolved static dependencies in installed trees", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "installed-invalid-tree-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const dependency = writeInstalledDependency(
        directory,
        "wrench-registry-invalid-tree",
        {
          dependencies: { "wrench-registry-missing": "1.0.0" },
          source:
            'import "wrench-registry-missing";\nexport const value = true;\n',
        },
      );
      writeFileSync(
        pluginPath,
        'import "wrench-registry-invalid-tree";\nexport const plugin = true;\n',
      );
      const definition = () => pluginDefinition(
        "installed-invalid-tree",
        undefined,
        pathToFileURL(pluginPath),
      );
      expect(() => createProviderPluginRegistry([definition()]))
        .toThrow("unresolved static dependency wrench-registry-missing");

      writeFileSync(
        dependency.manifest,
        `${JSON.stringify({
          name: "wrench-registry-invalid-tree",
          version: "1.0.0",
          main: "./index.js",
        }, null, 2)}\n`,
      );
      symlinkSync("index.js", join(dependency.root, "alias.js"));
      expect(() => createProviderPluginRegistry([definition()]))
        .toThrow("contains symlink alias.js");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("isolates semantic source changes to the owning provider composition", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "semantic-isolation-test-"),
    );
    const xSemanticPath = join(directory, "x-input.ts");
    const xPluginPath = join(directory, "plugin.ts");
    const xPlugin = providerPluginRegistry.get("x-official");
    const linkedinPlugin = providerPluginRegistry.get("linkedin-official");
    if (xPlugin === undefined || linkedinPlugin === undefined) {
      throw new Error("official built-in plugins must be installed");
    }
    const xSemanticSource = xPlugin.implementationSources.find(
      (source) => source.label === "contracts/x-input.ts",
    );
    if (xSemanticSource === undefined) {
      throw new Error("X official plugin must declare its provider-local input laws");
    }
    const sourceDefinitions = (
      plugin: typeof xPlugin,
      replacements: Readonly<Record<string, string>> = {},
    ) => plugin.implementationSources.map((source) => ({
      label: source.label,
      url: pathToFileURL(
        replacements[source.label] ?? source.path,
      ),
    }));
    try {
      writeFileSync(
        xSemanticPath,
        readFileSync(xSemanticSource.path),
      );
      const xPluginSource = xPlugin.implementationSources.find(
        (source) => source.label === "plugin.ts",
      );
      if (xPluginSource === undefined) {
        throw new Error("X official plugin must declare its plugin entrypoint");
      }
      writeFileSync(
        xPluginPath,
        readFileSync(xPluginSource.path, "utf8").replace(
          "../../provider-contract-input-x",
          "./x-input",
        ),
      );
      const definitions = () => [
        {
          ...pluginDefinition("x-official"),
          sourceKind: "source",
          implementationSources: sourceDefinitions(xPlugin, {
            "plugin.ts": xPluginPath,
            [xSemanticSource.label]: xSemanticPath,
          }),
        },
        {
          ...pluginDefinition("linkedin-official"),
          sourceKind: "source",
          implementationSources: sourceDefinitions(linkedinPlugin),
        },
      ] satisfies readonly ProviderPluginDefinitionV1[];
      const before = createProviderPluginRegistry(definitions());
      const xBefore = before.implementationHash(
        before.requireSessionRoute("x-official-site"),
      ).toString("hex");
      const linkedinBefore = before.implementationHash(
        before.requireSessionRoute("linkedin-official-site"),
      ).toString("hex");

      writeFileSync(
        xSemanticPath,
        `${readFileSync(xSemanticSource.path, "utf8")}\n// provider-local semantic revision\n`,
      );
      const after = createProviderPluginRegistry(definitions());
      expect(after.implementationHash(
        after.requireSessionRoute("x-official-site"),
      ).toString("hex")).not.toBe(xBefore);
      expect(after.implementationHash(
        after.requireSessionRoute("linkedin-official-site"),
      ).toString("hex")).toBe(linkedinBefore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("snapshots canonical source paths instead of retaining mutable URL objects", () => {
    const sourceUrl = new URL(import.meta.url);
    const plugin = defineProviderPlugin(
      pluginDefinition("immutable-source", undefined, sourceUrl),
    );
    const source = plugin.implementationSources[0];
    if (source === undefined) throw new Error("test plugin source is missing");
    const canonicalPath = source.path;
    sourceUrl.pathname = "/etc/hosts";
    expect(plugin.implementationSources[0]).toEqual({
      label: "plugin.ts",
      path: canonicalPath,
    });
    expect("url" in plugin.implementationSources[0]!).toBeFalse();

    expect(() => defineProviderPlugin(
      pluginDefinition("outside-source", undefined, pathToFileURL("/etc/hosts")),
    )).toThrow("regular file under the Wrench source root");
  });

  test("classifies installed Wrench sources relative to their package root", () => {
    const installedRoot = join(
      tmpdir(),
      "consumer",
      "node_modules",
      ".bun",
      "wrench-instance",
      "node_modules",
      "@hraness",
      "wrench",
    );
    expect(isProviderPluginRepositorySourcePath(
      installedRoot,
      join(installedRoot, "src", "plugins", "example", "plugin.ts"),
    )).toBeTrue();
    expect(isProviderPluginRepositorySourcePath(
      installedRoot,
      join(installedRoot, "node_modules", "dependency", "index.js"),
    )).toBeFalse();
    expect(isProviderPluginRepositorySourcePath(
      installedRoot,
      join(dirname(installedRoot), "other-package", "index.js"),
    )).toBeFalse();
  });

  test("rejects source drift between plugin evaluation and registry snapshot", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "evaluation-source-drift-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      writeFileSync(pluginPath, "export const revision = 1;\n");
      const evaluated = defineProviderPlugin(pluginDefinition(
        "evaluation-source-drift",
        undefined,
        pathToFileURL(pluginPath),
      ));
      writeFileSync(pluginPath, "export const revision = 2;\n");
      expect(() => createProviderPluginRegistry([evaluated]))
        .toThrow("implementation changed after its definition was evaluated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects stale helper functions after recursive repository drift", async () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "evaluation-helper-drift-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const helperPath = join(directory, "helper.ts");
    try {
      writeFileSync(
        pluginPath,
        'import { validateInput } from "./helper";\nexport const plugin = validateInput;\n',
      );
      writeFileSync(
        helperPath,
        'export const validateInput = () => ["old-helper"];\n',
      );
      const helperUrl =
        `${pathToFileURL(helperPath).href}?evaluation-helper-drift`;
      const helper = await import(helperUrl) as {
        readonly validateInput: () => readonly string[];
      };
      const evaluated = defineProviderPlugin(pluginDefinition(
        "evaluation-helper-drift",
        [webBinding("evaluation-helper-drift", [{
          ...operation(),
          validateInput: helper.validateInput,
        }])],
        pathToFileURL(pluginPath),
      ));
      expect(evaluated.bindings[0]?.operations[0]?.validateInput({}))
        .toEqual(["old-helper"]);
      writeFileSync(
        helperPath,
        'export const validateInput = () => ["new-helper"];\n',
      );
      expect(evaluated.bindings[0]?.operations[0]?.validateInput({}))
        .toEqual(["old-helper"]);
      expect(() => createProviderPluginRegistry([evaluated]))
        .toThrow("implementation changed after its definition was evaluated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects stale helper functions from a top-level dynamic import", async () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "evaluation-dynamic-helper-drift-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const helperPath = join(directory, "helper.ts");
    try {
      writeFileSync(
        pluginPath,
        'export const helper = await import("./helper.ts");\n',
      );
      writeFileSync(
        helperPath,
        'export const validateInput = () => ["old-dynamic-helper"];\n',
      );
      const pluginModule = await import(
        `${pathToFileURL(pluginPath).href}?evaluation-dynamic-helper-drift`
      ) as {
        readonly helper: {
          readonly validateInput: () => readonly string[];
        };
      };
      const evaluated = defineProviderPlugin(pluginDefinition(
        "evaluation-dynamic-helper-drift",
        [webBinding("evaluation-dynamic-helper-drift", [{
          ...operation(),
          validateInput: pluginModule.helper.validateInput,
        }])],
        pathToFileURL(pluginPath),
      ));
      expect(evaluated.bindings[0]?.operations[0]?.validateInput({}))
        .toEqual(["old-dynamic-helper"]);
      writeFileSync(
        helperPath,
        'export const validateInput = () => ["new-dynamic-helper"];\n',
      );
      expect(evaluated.bindings[0]?.operations[0]?.validateInput({}))
        .toEqual(["old-dynamic-helper"]);
      expect(() => createProviderPluginRegistry([evaluated]))
        .toThrow("implementation changed after its definition was evaluated");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps evaluation and registry package-tree hashes in parity and rejects later drift", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "evaluation-package-drift-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const dependency = writeInstalledDependency(
        directory,
        "wrench-evaluation-package-drift",
      );
      writeFileSync(
        pluginPath,
        'import "wrench-evaluation-package-drift";\nexport const plugin = true;\n',
      );
      const evaluated = defineProviderPlugin(pluginDefinition(
        "evaluation-package-drift",
        undefined,
        pathToFileURL(pluginPath),
      ));
      expect(() => createProviderPluginRegistry([evaluated])).not.toThrow();
      writeFileSync(dependency.entry, "export const value = 2;\n");
      expect(() => createProviderPluginRegistry([evaluated]))
        .toThrow(
          "installed dependency changed after its definition was evaluated",
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds evaluated plugin metadata into source implementation identity", () => {
    const baseline = createProviderPluginRegistry([
      pluginDefinition("semantic-metadata"),
    ]);
    const changed = createProviderPluginRegistry([{
      ...pluginDefinition("semantic-metadata"),
      displayName: "semantic metadata revision",
    }]);
    expect(changed.implementationHash(
      changed.requireSessionRoute("semantic-metadata-site"),
    ).toString("hex")).not.toBe(baseline.implementationHash(
      baseline.requireSessionRoute("semantic-metadata-site"),
    ).toString("hex"));
  });

  test("automatically binds recursive local value dependencies in provider sources", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "dependency-closure-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const providerPath = join(directory, "provider.ts");
    const helperPath = join(directory, "helper.ts");
    try {
      writeFileSync(pluginPath, "export const plugin = true;\n");
      writeFileSync(
        providerPath,
        'import { helper } from "./helper"; export const provider = helper;\n',
      );
      writeFileSync(helperPath, "export const helper = true;\n");
      const definition = (
        includeHelper: boolean,
      ): ProviderPluginDefinitionV1 => ({
        ...pluginDefinition(
          "dependency-closure",
          undefined,
          pathToFileURL(pluginPath),
        ),
        implementationSources: [
          { label: "plugin.ts", url: pathToFileURL(pluginPath) },
          { label: "providers/provider.ts", url: pathToFileURL(providerPath) },
          ...(includeHelper
            ? [{
                label: "providers/helper.ts",
                url: pathToFileURL(helperPath),
              }]
            : []),
        ],
      });
      const automatic = createProviderPluginRegistry([definition(false)]);
      const automaticBefore = automatic.implementationHash(
        automatic.requireSessionRoute("dependency-closure-site"),
      ).toString("hex");
      writeFileSync(helperPath, "export const helper = false;\n");
      const automaticChanged = createProviderPluginRegistry([
        definition(false),
      ]);
      expect(automaticChanged.implementationHash(
        automaticChanged.requireSessionRoute("dependency-closure-site"),
      ).toString("hex")).not.toBe(automaticBefore);
      writeFileSync(helperPath, "export const helper = true;\n");
      expect(() => createProviderPluginRegistry([definition(true)]))
        .not.toThrow();
      writeFileSync(
        pluginPath,
        'import "../../model"; export const plugin = true;\n',
      );
      expect(() => createProviderPluginRegistry([definition(true)]))
        .not.toThrow();
      writeFileSync(
        pluginPath,
        `import ${JSON.stringify(pathToFileURL(helperPath).href)}; export const plugin = true;\n`,
      );
      expect(() => createProviderPluginRegistry([definition(true)]))
        .toThrow("imports unsupported absolute or URL dependency");
      writeFileSync(
        pluginPath,
        'const moduleName = "./helper"; void import(moduleName);\n',
      );
      expect(() => createProviderPluginRegistry([definition(true)]))
        .toThrow("contains a non-literal module load");
      for (const nonLiteralLoad of [
        'const name = "helper"; void import("./" + name);\n',
        'const name = "helper"; void import(`./$' + '{name}`);\n',
        'const name = "helper"; require("./" + name);\n',
        'const name = "helper"; const message = `$' + '{import(name)}`;\n',
      ]) {
        writeFileSync(pluginPath, nonLiteralLoad);
        expect(() => createProviderPluginRegistry([definition(true)]))
          .toThrow("contains a non-literal module load");
      }
      writeFileSync(
        pluginPath,
        'const note = "import(moduleName)"; // require(moduleName)\nexport const plugin = note;\n',
      );
      expect(() => createProviderPluginRegistry([definition(true)]))
        .not.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds recursive host semantics while keeping the global catalog private", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "api-boundary-identity-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    try {
      const definition = () => pluginDefinition(
        "api-boundary-identity",
        undefined,
        pathToFileURL(pluginPath),
      );
      const identity = (
        changedSuffix: string | undefined,
      ): { readonly hash: string; readonly changed: boolean } => {
        let changed = false;
        const registry = createProviderPluginRegistry([definition()], {
          readDependencySource: (path) => {
            const bytes = readFileSync(path);
            if (
              changedSuffix !== undefined
              && path.endsWith(changedSuffix)
            ) {
              changed = true;
              return Buffer.concat([
                bytes,
                Buffer.from("\n// boundary identity revision\n", "utf8"),
              ]);
            }
            return bytes;
          },
        });
        return {
          hash: registry.implementationHash(
            registry.requireSessionRoute("api-boundary-identity-site"),
          ).toString("hex"),
          changed,
        };
      };

      writeFileSync(
        pluginPath,
        'import "../../model";\nexport const plugin = true;\n',
      );
      const modelBaseline = identity(undefined).hash;
      const catalogChanged = identity("/src/platform-catalog.ts");
      expect(catalogChanged.changed).toBeTrue();
      expect(catalogChanged.hash).not.toBe(modelBaseline);

      writeFileSync(
        pluginPath,
        'import "../../web-session-contract-definitions";\nexport const plugin = true;\n',
      );
      const contractsBaseline = identity(undefined).hash;
      const contractAssetChanged = identity(
        "/src/assets/adapters/x/wrench-web-adapter.json",
      );
      expect(contractAssetChanged.changed).toBeTrue();
      expect(contractAssetChanged.hash).not.toBe(contractsBaseline);

      writeFileSync(
        pluginPath,
        'import "../../provider-plugins";\nexport const plugin = true;\n',
      );
      expect(() => identity(undefined)).toThrow(
        "imports the private process-wide provider catalog",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("binds the Bun, TypeScript, and JavaScript package execution context", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "execution-config-identity-test-"),
    );
    const pluginPath = join(directory, "plugin.ts");
    const javascriptPath = join(directory, "payload.js");
    const packagePath = join(directory, "package.json");
    try {
      writeFileSync(
        pluginPath,
        'import "./payload.js";\nexport const plugin = true;\n',
      );
      writeFileSync(javascriptPath, "export const payload = true;\n");
      writeFileSync(
        packagePath,
        `${JSON.stringify({ type: "module" }, null, 2)}\n`,
      );
      const definition = () => pluginDefinition(
        "execution-config-identity",
        undefined,
        pathToFileURL(pluginPath),
      );
      const identity = (
        mutate: (path: string, bytes: Buffer) => Buffer,
      ): string => {
        const registry = createProviderPluginRegistry([definition()], {
          readDependencySource: (path) =>
            mutate(path, readFileSync(path)),
        });
        return registry.implementationHash(
          registry.requireSessionRoute("execution-config-identity-site"),
        ).toString("hex");
      };
      const baseline = identity((_path, bytes) => bytes);
      const packageTypeChanged = identity((path, bytes) =>
        path === packagePath
          ? Buffer.from('{"type":"commonjs"}\n', "utf8")
          : bytes);
      expect(packageTypeChanged).not.toBe(baseline);
      const extendedTsconfigChanged = identity((path, bytes) =>
        path === join(providerPluginRepositoryRoot, "tsconfig.json")
          ? Buffer.concat([bytes, Buffer.from("\n", "utf8")])
          : bytes);
      expect(extendedTsconfigChanged).not.toBe(baseline);
      expect(() => identity((path, bytes) =>
        path.endsWith("/bunfig.toml")
          ? Buffer.concat([
              bytes,
              Buffer.from('\n[define]\nREVIEW_BUILD_VALUE = "\\"changed\\""\n', "utf8"),
            ])
          : bytes)).toThrow("unsupported runtime configuration");

      const originalConfigFile = process.env.BUN_CONFIG_FILE;
      process.env.BUN_CONFIG_FILE = "/tmp/wrench-unowned-bunfig.toml";
      try {
        expect(() => identity((_path, bytes) => bytes))
          .toThrow("refuses ambient Bun configuration overrides");
      } finally {
        if (originalConfigFile === undefined) {
          delete process.env.BUN_CONFIG_FILE;
        } else {
          process.env.BUN_CONFIG_FILE = originalConfigFile;
        }
      }

      writeFileSync(
        pluginPath,
        'import "./payload.foo";\nexport const plugin = true;\n',
      );
      writeFileSync(join(directory, "payload.foo"), "export default true;\n");
      expect(() => identity((_path, bytes) => bytes))
        .toThrow("unsupported module extension .foo");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses Bun's XDG global bunfig path and precedence", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "wrench-registry-xdg-bunfig-test-"),
    );
    const nestedDirectory = join(directory, "bun");
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      mkdirSync(nestedDirectory);
      writeFileSync(
        join(nestedDirectory, "bunfig.toml"),
        'preload = ["./wrong-nested-location.ts"]\n',
      );
      process.env.XDG_CONFIG_HOME = directory;
      expect(() => createProviderPluginRegistry([
        pluginDefinition("xdg-bunfig-nested"),
      ])).not.toThrow();

      writeFileSync(
        join(directory, ".bunfig.toml"),
        'preload = ["./ambient-preload.ts"]\n',
      );
      expect(() => createProviderPluginRegistry([
        pluginDefinition("xdg-bunfig-global"),
      ])).toThrow("global bunfig.toml contains unsupported runtime configuration");
    } finally {
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects semantic Bun CLI aliases and transform overrides", () => {
    const originalExecArgv = [...process.execArgv];
    try {
      for (const override of [
        "--import=./ambient-preload.ts",
        "-d=WRENCH_REVIEW_VALUE:true",
        "--ignore-dce-annotations",
        "--jsx-side-effects",
        "--preserve-symlinks",
      ]) {
        Reflect.set(process, "execArgv", [...originalExecArgv, override]);
        expect(() => createProviderPluginRegistry([
          pluginDefinition("ambient-cli-override"),
        ]), override).toThrow(
          "refuses Bun loader, define, preload, condition, or tsconfig CLI overrides",
        );
      }
    } finally {
      Reflect.set(process, "execArgv", originalExecArgv);
    }
  });

  test("revalidates installed tsconfig extensions before registry startup completes", () => {
    const repositoryRoot = providerPluginRepositoryRoot;
    const rootTsconfig = join(repositoryRoot, "tsconfig.json");
    let installedConfigReads = 0;

    expect(() => createProviderPluginRegistry([
      pluginDefinition("installed-tsconfig-revalidation"),
    ], {
      readDependencySource: (path) => {
        if (path === rootTsconfig) {
          return Buffer.from('{"extends":"typescript/package.json"}\n');
        }
        if (
          path.includes(`${sep}node_modules${sep}`)
          && path.endsWith(`${sep}typescript${sep}package.json`)
        ) {
          installedConfigReads += 1;
          return Buffer.from(
            installedConfigReads === 1
              ? "{}\n"
              : '{"compilerOptions":{}}\n',
          );
        }
        return readFileSync(path);
      },
    })).toThrow("changed before registry startup completed");
    expect(installedConfigReads).toBe(2);
  });

  test("resolves extensionless tsconfig extends to a regular JSON file", () => {
    const directory = mkdtempSync(
      join(import.meta.dir, "plugins", "tsconfig-json-resolution-test-"),
    );
    const repositoryRoot = providerPluginRepositoryRoot;
    const rootTsconfig = join(repositoryRoot, "tsconfig.json");
    const extensionBase = join(directory, "config");
    const extensionPath = `${extensionBase}.json`;
    try {
      mkdirSync(extensionBase);
      writeFileSync(extensionPath, "{}\n");
      const specifier =
        `./${relative(repositoryRoot, extensionBase).split(sep).join("/")}`;
      const identity = (extendedBytes: Buffer): string => {
        const registry = createProviderPluginRegistry([
          pluginDefinition("tsconfig-json-resolution"),
        ], {
          readDependencySource: (path) => {
            if (path === rootTsconfig) {
              return Buffer.from(
                `${JSON.stringify({ extends: specifier })}\n`,
              );
            }
            if (path === extensionPath) return extendedBytes;
            return readFileSync(path);
          },
        });
        return registry.implementationHash(
          registry.requireSessionRoute("tsconfig-json-resolution-site"),
        ).toString("hex");
      };

      const baseline = identity(Buffer.from("{}\n"));
      expect(identity(Buffer.from('{"compilerOptions":{}}\n')))
        .not.toBe(baseline);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("catalog metadata is complete and plugin sources have no eager runtime imports", () => {
    for (const plugin of providerPluginRegistry.list()) {
      const labels = plugin.implementationSources.map((source) => source.label);
      expect(labels).not.toContain("kernel/provider-contract-definitions.ts");
      expect(labels).not.toContain("kernel/web-session-contract-definitions.ts");
      expect(labels).toContain("kernel/provider-contract-semantic-identity.ts");
      for (const binding of plugin.bindings) {
        expect(binding.operations.length).toBeGreaterThan(0);
        for (const descriptor of binding.operations) {
          expect(descriptor.input).toBeDefined();
          expect(descriptor.sideEffect.length).toBeGreaterThan(0);
          expect(descriptor.implementation.length).toBeGreaterThan(0);
          expect(descriptor.planDispatches).toBeFunction();
          expect(descriptor.validateInput).toBeFunction();
        }
      }
      const pluginSource = plugin.implementationSources.find(
        (source) => source.label === "plugin.ts",
      );
      expect(pluginSource).toBeDefined();
      const source = readFileSync(pluginSource!.path, "utf8");
      expect(source).not.toMatch(
        /from\s+["'][^"']*(?:-runtime|providers\/(?:linkedin|x))["']/u,
      );
    }
    const definitions = readFileSync(
      new URL("./web-session-contract-definitions.ts", import.meta.url),
      "utf8",
    );
    expect(definitions).not.toMatch(/from\s+["']\.\/providers\//u);
    expect(definitions).not.toContain("canonicalJson");
  });

  test("binds the shared contact projection into every observed contact provider", () => {
    const plugins = providerPluginRegistry.list();
    const observedContactProviderIds = plugins
      .filter((plugin) => plugin.bindings.some((binding) =>
        binding.operations.some((operation) =>
          operation.name === "contacts.list" && operation.state === "observed"
        )
      ))
      .map((plugin) => plugin.id)
      .sort((left, right) => left.localeCompare(right));
    const sharedProjectionProviderIds = plugins
      .filter((plugin) => plugin.implementationSources.some((source) =>
        source.label === "providers/contact-projection.ts"
      ))
      .map((plugin) => plugin.id)
      .sort((left, right) => left.localeCompare(right));

    expect(observedContactProviderIds).toEqual([
      "beeper-linked-device",
      "gmail-official",
      "linkedin-official",
      "meta-web",
      "whatsapp-linked-device",
    ]);
    expect(sharedProjectionProviderIds).toEqual(observedContactProviderIds);

    const whatsapp = providerPluginRegistry.get("whatsapp-linked-device");
    expect(whatsapp).toBeDefined();
    const whatsappSourceLabels = new Set(
      whatsapp?.implementationSources.map((source) => source.label) ?? [],
    );
    for (const expected of [
      "kernel/state-helper.bunfig.toml",
      "providers/whatsapp-contact-projection-helper.ts",
      "providers/whatsapp-contact-projection-protocol.ts",
      "providers/whatsapp-interaction-projection-helper.ts",
      "providers/whatsapp-interaction-projection-protocol.ts",
    ]) {
      expect(whatsappSourceLabels.has(expected)).toBeTrue();
    }
  });

  test("resolves every installed bundled schema-v3/v4 operation at its durable route version", () => {
    const root = join(import.meta.dir, "assets", "adapters");
    const retiredDiagnosticOnlyManifests = new Map<string, readonly string[]>([
      [
        join(root, "bluesky", "wrench-web-adapter.v1.0.0.json"),
        [
          "authenticated web contract bluesky/posts.publish@1 is not installed",
        ],
      ],
      ...["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map((version) => [
        join(root, "linkedin", `wrench-web-adapter.v${version}.json`),
        [
          "manifest.origins must exactly match provider plugin surface linkedin: https://static.licdn.com, https://www.linkedin.com",
          "manifest.browserDomains must exactly match provider plugin surface linkedin: static.licdn.com, www.linkedin.com",
          "authenticated web contract linkedin/posts.publish@1 is not installed",
        ],
      ] as const),
      [
        join(root, "linkedin", "wrench-web-adapter.v1.4.0.json"),
        [
          "manifest.origins must exactly match provider plugin surface linkedin: https://static.licdn.com, https://www.linkedin.com",
          "manifest.browserDomains must exactly match provider plugin surface linkedin: static.licdn.com, www.linkedin.com",
          "authenticated web contract linkedin/posts.publish@1 is not installed",
          "authenticated web contract linkedin/articles.draft.save@1 is not installed",
        ],
      ],
      [
        join(root, "linkedin", "wrench-web-adapter.v1.5.0.json"),
        [
          "manifest.origins must exactly match provider plugin surface linkedin: https://static.licdn.com, https://www.linkedin.com",
          "manifest.browserDomains must exactly match provider plugin surface linkedin: static.licdn.com, www.linkedin.com",
          "authenticated web contract linkedin/posts.publish@1 is not installed",
          "authenticated web contract linkedin/articles.draft.save@1 is not installed",
        ],
      ],
      [
        join(root, "linkedin", "wrench-web-adapter.v1.6.0.json"),
        [
          "manifest.origins must exactly match provider plugin surface linkedin: https://static.licdn.com, https://www.linkedin.com",
          "manifest.browserDomains must exactly match provider plugin surface linkedin: static.licdn.com, www.linkedin.com",
          "authenticated web contract linkedin/posts.publish@1 is not installed",
        ],
      ],
      [
        join(root, "linkedin", "wrench-web-adapter.v1.7.0.json"),
        [
          "manifest.origins must exactly match provider plugin surface linkedin: https://static.licdn.com, https://www.linkedin.com",
          "manifest.browserDomains must exactly match provider plugin surface linkedin: static.licdn.com, www.linkedin.com",
          "authenticated web contract linkedin/articles.draft.save@3 is not installed",
          "authenticated web contract linkedin/posts.publish@1 is not installed",
        ],
      ],
      ...["1.9.0", "1.10.0"].map((version) => [
        join(root, "linkedin", `wrench-web-adapter.v${version}.json`),
        [
          "authenticated web contract linkedin/articles.draft.save@3 is not installed",
        ],
      ] as const),
      [
        join(root, "linkedin", "wrench-web-adapter.v1.11.0.json"),
        [
          "authenticated web contract linkedin/articles.draft.save@4 is not installed",
        ],
      ],
      [
        join(root, "linkedin", "wrench-web-adapter.v1.12.0.json"),
        [
          "authenticated web contract linkedin/articles.draft.save@5 is not installed",
        ],
      ],
      [
        join(root, "linkedin", "wrench-web-adapter.v1.13.0.json"),
        [
          "authenticated web contract linkedin/articles.draft.save@6 is not installed",
        ],
      ],
      [
        join(root, "substack", "wrench-web-adapter.v1.0.0.json"),
        [
          "authenticated web contract substack/posts.publish@1 is not installed",
        ],
      ],
      [
        join(root, "threads", "wrench-web-adapter.v1.0.0.json"),
        [
          "manifest.operations.feeds.read.input must exactly match authenticated web contract threads/feeds.read@1",
          "manifest.operations.posts.publish.input must exactly match authenticated web contract threads/posts.publish@1",
          "manifest.operations.posts.publish.sideEffect must exactly match authenticated web contract threads/posts.publish@1",
        ],
      ],
      [
        join(root, "threads", "wrench-web-adapter.v1.1.0.json"),
        [
          "manifest.operations.posts.publish.input must exactly match authenticated web contract threads/posts.publish@1",
          "manifest.operations.posts.publish.sideEffect must exactly match authenticated web contract threads/posts.publish@1",
        ],
      ],
      [
        join(root, "x", "wrench-web-adapter.v1.1.0.json"),
        [
          "authenticated web contract x/posts.publish@1 is not installed",
          "authenticated web contract x/articles.publish@1 is not installed",
        ],
      ],
      [
        join(root, "x", "wrench-web-adapter.v1.2.0.json"),
        [
          "authenticated web contract x/posts.publish@1 is not installed",
          "authenticated web contract x/articles.publish@2 is not installed",
        ],
      ],
      [
        join(root, "x", "wrench-web-adapter.v1.3.0.json"),
        [
          "authenticated web contract x/posts.publish@1 is not installed",
          "authenticated web contract x/articles.publish@3 is not installed",
        ],
      ],
      [
        join(root, "x", "wrench-web-adapter.v1.4.0.json"),
        [
          "authenticated web contract x/posts.publish@1 is not installed",
        ],
      ],
      [
        join(root, "x", "wrench-web-adapter.v1.5.0.json"),
        [
          "authenticated web contract x/posts.publish@1 is not installed",
        ],
      ],
    ] as const);
    const checkedRetiredManifests = new Set<string>();
    let checked = 0;
    for (const path of manifestFiles(root)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (
        typeof raw !== "object"
        || raw === null
        || Array.isArray(raw)
        || !("schemaVersion" in raw)
        || (raw.schemaVersion !== 3 && raw.schemaVersion !== 4)
      ) continue;
      const parsed = parseDiagnosticManifest(raw, providerPluginRegistry);
      expect(parsed.ok, path).toBeTrue();
      if (!parsed.ok) throw new Error(`${path}: ${parsed.issues.join("; ")}`);
      const manifest: WrenchManifest = parsed.value;
      const retiredIssue = retiredDiagnosticOnlyManifests.get(path);
      if (retiredIssue !== undefined) {
        expect(parseRuntimeManifest(raw, providerPluginRegistry), path).toEqual({
          ok: false,
          issues: retiredIssue,
        });
        checkedRetiredManifests.add(path);
        continue;
      }
      for (const candidate of Object.values(manifest.operations)) {
        if (isProviderOperation(candidate)) {
          expect(providerPluginRegistry.resolveOperationDefinition(
            "provider-api",
            candidate.provider.provider,
            candidate.provider.action,
            candidate.provider.contractVersion,
          ), path).toBeDefined();
          checked += 1;
        } else if (isWebSessionOperation(candidate)) {
          const binding = providerPluginRegistry.requireSessionRoute(
            candidate.webSession.site,
          );
          expect(providerPluginRegistry.resolveOperationDefinition(
            binding.transport,
            candidate.webSession.site,
            candidate.webSession.action,
            candidate.webSession.contractVersion,
          ), path).toBeDefined();
          checked += 1;
        }
      }
    }
    expect(checkedRetiredManifests).toEqual(
      new Set(retiredDiagnosticOnlyManifests.keys()),
    );
    expect(checked).toBeGreaterThan(100);
  });
});
