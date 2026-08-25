import {
  afterEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  manifestHash,
  parseRuntimeManifest,
  type WrenchManifest,
} from "../model";
import {
  initPortableProviderPlugin,
  installPortableProviderPlugin,
  packPortableProviderPlugin,
} from "../provider-plugin-lifecycle";
import type { ProviderPluginRegistry } from "../provider-plugin-registry";
import { providerPluginRegistry } from "../provider-plugins";
import {
  adapterManifestPath,
  installBundledAdapterGeneration,
  installManifest,
  loadInstalledManifest,
  type BundledAdapterGenerationSelection,
} from "../storage";
import {
  discoverBundledAdapters,
  syncBundledAdapters,
} from "./sync-bundled-adapters";

type SyncOptions = NonNullable<
  Parameters<typeof syncBundledAdapters>[0]
>;
type WrenchMain = NonNullable<SyncOptions["wrenchMain"]>;
type GenerationInstaller = NonNullable<SyncOptions["installGeneration"]>;

const roots: string[] = [];
const assetsDirectory = join(import.meta.dir, "..", "assets", "adapters");

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryState(): {
  readonly root: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-sync-generation-test-"));
  roots.push(root);
  return { root, environment: { WRENCH_STATE_HOME: join(root, "state") } };
}

function copiedAssets(): {
  readonly root: string;
  readonly assets: string;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-sync-assets-test-"));
  roots.push(root);
  const assets = join(root, "adapters");
  cpSync(assetsDirectory, assets, { recursive: true });
  return { root, assets };
}

function outputCapture(): {
  readonly output: {
    readonly stdout: (value: string) => void;
    readonly stderr: (value: string) => void;
  };
  readonly stdout: () => string;
  readonly stderr: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    output: {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function writeSuccessfulValidation(
  arguments_: readonly string[],
  output: Parameters<WrenchMain>[2],
  registry: ProviderPluginRegistry = providerPluginRegistry,
): WrenchManifest {
  const path = arguments_[2]!;
  const parsed = parseRuntimeManifest(
    JSON.parse(readFileSync(path, "utf8")) as unknown,
    registry,
  );
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  output.stdout(`${JSON.stringify({
    ok: true,
    id: parsed.value.id,
    manifestHash: manifestHash(parsed.value),
  })}\n`);
  return parsed.value;
}

function capturingInstaller(
  calls: {
    selections: readonly BundledAdapterGenerationSelection[] | null;
    validationsAtInstall: number;
  },
  validationCount: () => number,
): GenerationInstaller {
  return (selections) => {
    calls.selections = selections;
    calls.validationsAtInstall = validationCount();
    return {
      commitId: "00000000-0000-4000-8000-000000000001",
      installed: selections.filter((selection) =>
        selection.state === "present"
      ).length,
      preservedLegacy: selections.filter((selection) =>
        selection.state === "legacy"
      ).length,
    };
  };
}

describe("single-process bundled adapter generation sync", () => {
  test("derives all current and archived inventory from assets with registry parity", () => {
    const discovered = discoverBundledAdapters();
    expect(discovered).toHaveLength(20);
    expect(discovered.flatMap((adapter) =>
      adapter.upgradeFrom.map((baseline) =>
        `${adapter.id}@${baseline.manifest.version}`
      )
    )).toEqual([
      "beeper-local@1.0.0",
      "bluesky-web@1.0.0",
      "bluesky-web@1.1.0",
      "bluesky-web@1.2.0",
      "bluesky-web@1.3.0",
      "bluesky-web@1.4.0",
      "bluesky-web@1.5.0",
      "facebook-group-web@1.0.0",
      "facebook-marketplace-web@1.0.0",
      "facebook-marketplace-web@1.1.0",
      "facebook-page-web@1.0.0",
      "facebook-web@1.0.0",
      "facebook-web@1.1.0",
      "github-web@1.0.0",
      "gmail@1.2.0",
      "instagram-web@1.0.0",
      "instagram-web@1.1.0",
      "instagram-web@1.2.0",
      "instagram-web@1.3.0",
      "instagram-web@1.4.0",
      "instagram-web@1.5.0",
      "linkedin@0.4.0",
      "linkedin@1.0.0",
      "linkedin-web@1.0.0",
      "linkedin-web@1.1.0",
      "linkedin-web@1.10.0",
      "linkedin-web@1.11.0",
      "linkedin-web@1.12.0",
      "linkedin-web@1.13.0",
      "linkedin-web@1.14.0",
      "linkedin-web@1.15.0",
      "linkedin-web@1.16.0",
      "linkedin-web@1.17.0",
      "linkedin-web@1.2.0",
      "linkedin-web@1.3.0",
      "linkedin-web@1.4.0",
      "linkedin-web@1.5.0",
      "linkedin-web@1.6.0",
      "linkedin-web@1.7.0",
      "linkedin-web@1.8.0",
      "linkedin-web@1.9.0",
      "reddit-web@1.0.0",
      "reddit-web@1.1.0",
      "reddit-web@1.2.0",
      "reddit-web@1.3.0",
      "reddit-web@1.4.0",
      "reddit-web@1.5.0",
      "reddit-web@1.6.0",
      "reddit-web@1.7.0",
      "reddit-web@1.8.0",
      "reddit-web@1.9.0",
      "substack-web@1.0.0",
      "substack-web@1.1.0",
      "substack-web@1.2.0",
      "substack-web@1.3.0",
      "substack-web@1.4.0",
      "substack-web@1.5.0",
      "threads-web@1.0.0",
      "threads-web@1.1.0",
      "threads-web@1.2.0",
      "threads-web@1.3.0",
      "threads-web@1.4.0",
      "threads-web@1.5.0",
      "threads-web@1.6.0",
      "tiktok-web@1.0.0",
      "tiktok-web@1.1.0",
      "tiktok-web@1.2.0",
      "whatsapp-web@1.0.0",
      "whatsapp-web@1.1.0",
      "whatsapp-web@1.2.0",
      "x@1.0.0",
      "x@1.1.0",
      "x-web@1.1.0",
      "x-web@1.10.0",
      "x-web@1.2.0",
      "x-web@1.3.0",
      "x-web@1.4.0",
      "x-web@1.5.0",
      "x-web@1.6.0",
      "x-web@1.7.0",
      "x-web@1.8.0",
      "x-web@1.9.0",
      "youtube-web@1.0.0",
      "youtube-web@1.1.0",
      "youtube-web@1.2.0",
    ]);
    expect(Object.fromEntries(discovered.flatMap((adapter) =>
      adapter.upgradeFrom.map((baseline) => [
        `${adapter.id}@${baseline.manifest.version}`,
        baseline.sourceContentSha256,
      ]),
    ))).toMatchObject({
      "gmail@1.2.0": "5568ac835a649f58d584867cf31ecb69baf16b16f8ac2ecd0c02363636aac3cb",
      "instagram-web@1.0.0": "bc3e17911739cc496105aac3bec522ef64b5e3b55183a2a0541850bb0f0ad18b",
      "threads-web@1.0.0": "750a6db23ea6e3e3c96f3a9086ce17d73c3c5c90066e576525e848fe4583ec41",
      "threads-web@1.3.0": "125936943ac8f0ed00e85367ee01dc953d5115c55f4849a85d8f8b68e4e286f5",
    });
    const gmailV12 = discovered.find((adapter) => adapter.id === "gmail")
      ?.upgradeFrom.find((baseline) => baseline.manifest.version === "1.2.0");
    expect(gmailV12).toBeDefined();
    expect(gmailV12 === undefined ? null : manifestHash(gmailV12.manifest)).toBe(
      "f864c55cdeaab6293be02b58607e9dced349e45225b17652e8838047957a1273",
    );
    const gmailV12Bytes = readFileSync(join(
      assetsDirectory,
      "gmail",
      "wrench-adapter.v1.2.0.json",
    ));
    expect(createHash("sha1")
      .update(Buffer.from(`blob ${gmailV12Bytes.byteLength}\0`))
      .update(gmailV12Bytes)
      .digest("hex")).toBe(
      "0b0dd8e3c1a9d0de31609abb867c3c5315702e58",
    );
    expect(discovered.map((adapter) => adapter.id)).toEqual([
      "beeper-local",
      "bluesky-web",
      "facebook-group-web",
      "facebook-marketplace-web",
      "facebook-page-web",
      "facebook-web",
      "github-web",
      "gmail",
      "hacker-news-web",
      "instagram-web",
      "linkedin",
      "linkedin-web",
      "reddit-web",
      "substack-web",
      "threads-web",
      "tiktok-web",
      "whatsapp-web",
      "x",
      "x-web",
      "youtube-web",
    ]);
    expect(new Set(discovered.map((adapter) => adapter.routeKey)).size).toBe(20);
  });

  test("validates every immutable source snapshot before one generation commit", async () => {
    const state = temporaryState();
    let validations = 0;
    const validationRegistries = new Set<ProviderPluginRegistry>();
    const committed = {
      selections: null as readonly BundledAdapterGenerationSelection[] | null,
      validationsAtInstall: 0,
    };
    const wrenchMain: WrenchMain = (
      arguments_,
      _environment,
      output,
      dependencyOverrides,
    ) => {
      expect(arguments_.slice(0, 2)).toEqual(["adapter", "validate"]);
      expect(arguments_.at(-1)).toBe("--json");
      const activeRegistry =
        dependencyOverrides?.providerPluginRegistry;
      expect(activeRegistry).toBeDefined();
      if (activeRegistry === undefined) {
        throw new Error("sync validation omitted its active registry");
      }
      validationRegistries.add(activeRegistry);
      validations += 1;
      writeSuccessfulValidation(arguments_, output, activeRegistry);
      return Promise.resolve(0);
    };

    const result = await syncBundledAdapters({
      environment: state.environment,
      output: { stdout: () => undefined, stderr: () => undefined },
      wrenchMain,
      installGeneration: capturingInstaller(
        committed,
        () => validations,
      ),
    });

    expect(validations).toBe(20);
    expect(validationRegistries.size).toBe(1);
    expect([...validationRegistries][0]).not.toBe(providerPluginRegistry);
    expect(committed.validationsAtInstall).toBe(20);
    expect(committed.selections).toHaveLength(20);
    expect(result).toEqual({
      installed: 20,
      preserved: 0,
      commitId: "00000000-0000-4000-8000-000000000001",
    });
  });

  test("fails before publication when the portable catalog changes during validation", async () => {
    const state = temporaryState();
    const source = join(state.root, "catalog-race-source");
    const packagePath = join(state.root, "catalog-race.wrenchplugin");
    initPortableProviderPlugin({
      id: "catalog-race-plugin",
      displayName: "Catalog race plugin",
      surfaceId: "catalog-race",
      origin: "https://catalog-race.example",
      operation: "records.read",
      output: source,
    });
    packPortableProviderPlugin(source, packagePath);
    let validations = 0;
    let publicationCalls = 0;
    let failure = "";
    try {
      await syncBundledAdapters({
        environment: state.environment,
        output: { stdout: () => undefined, stderr: () => undefined },
        wrenchMain: (
          arguments_,
          environment,
          output,
          dependencyOverrides,
        ) => {
          const activeRegistry =
            dependencyOverrides?.providerPluginRegistry;
          if (activeRegistry === undefined) {
            throw new Error("sync validation omitted its active registry");
          }
          validations += 1;
          writeSuccessfulValidation(
            arguments_,
            output,
            activeRegistry,
          );
          if (validations === 20) {
            installPortableProviderPlugin(packagePath, {
              trustExecutableCode: true,
              expectedCurrentBundleSha256: null,
              assertActivatable: () => undefined,
              assertCurrentQuiescent: () => undefined,
              environment,
            });
          }
          return Promise.resolve(0);
        },
        installGeneration: () => {
          publicationCalls += 1;
          throw new Error("must not publish");
        },
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(validations).toBe(20);
    expect(publicationCalls).toBe(0);
    expect(failure).toContain(
      "portable provider plugin catalog changed during bundled adapter validation",
    );
  });

  test("fails before generation publication on validation or identity drift", async () => {
    const state = temporaryState();
    for (const mode of ["status", "identity", "hash"] as const) {
      let publicationCalls = 0;
      let validations = 0;
      const wrenchMain: WrenchMain = (arguments_, _environment, output) => {
        validations += 1;
        if (validations === 2 && mode !== "status") {
          const parsed = parseRuntimeManifest(
            JSON.parse(readFileSync(arguments_[2]!, "utf8")) as unknown,
            providerPluginRegistry,
          );
          if (!parsed.ok) throw new Error(parsed.issues.join("; "));
          output.stdout(`${JSON.stringify({
            ok: true,
            id: mode === "identity" ? "spoofed-web" : parsed.value.id,
            manifestHash: mode === "hash"
              ? "0".repeat(64)
              : manifestHash(parsed.value),
          })}\n`);
          return Promise.resolve(0);
        }
        writeSuccessfulValidation(arguments_, output);
        if (validations === 2 && mode === "status") {
          output.stderr("synthetic invalid bundle\n");
          return Promise.resolve(2);
        }
        return Promise.resolve(0);
      };
      let message = "";
      try {
        await syncBundledAdapters({
          environment: state.environment,
          output: { stdout: () => undefined, stderr: () => undefined },
          wrenchMain,
          installGeneration: () => {
            publicationCalls += 1;
            throw new Error("must not publish");
          },
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(mode === "status"
        ? "failed validation"
        : "wrong identity");
      expect(publicationCalls).toBe(0);
    }
  });

  test("commits the bytes snapshotted before repository source replacement", async () => {
    const state = temporaryState();
    const copied = copiedAssets();
    let replacedSources = false;
    let committed: readonly BundledAdapterGenerationSelection[] = [];
    const wrenchMain: WrenchMain = (arguments_, _environment, output) => {
      const staged = writeSuccessfulValidation(arguments_, output);
      if (!replacedSources) {
        replacedSources = true;
        for (const adapter of discoverBundledAdapters(copied.assets)) {
          writeFileSync(
            adapter.current.path,
            '{"replaced":"after-snapshot"}\n',
          );
        }
      }
      expect(staged.id).not.toBe("");
      return Promise.resolve(0);
    };

    const result = await syncBundledAdapters({
      environment: state.environment,
      assetsDirectory: copied.assets,
      output: { stdout: () => undefined, stderr: () => undefined },
      wrenchMain,
      installGeneration: (selections) => {
        committed = selections;
        return {
          commitId: "00000000-0000-4000-8000-000000000002",
          installed: selections.length,
          preservedLegacy: 0,
        };
      },
    });

    expect(result.installed).toBe(20);
    expect(committed).toHaveLength(20);
    expect(committed.every((selection) =>
      selection.state === "present"
      && selection.manifest.id === selection.id
    )).toBeTrue();
  });

  test("refuses to overwrite an installed adapter changed after classification", async () => {
    const state = temporaryState();
    const x = discoverBundledAdapters().find((adapter) =>
      adapter.id === "x"
    )!;
    installManifest(x.current.manifest, {
      force: false,
      environment: state.environment,
      registry: providerPluginRegistry,
    });
    const concurrentCandidate = {
      ...structuredClone(x.current.manifest),
      version: "99.0.0",
    };
    const concurrent = parseRuntimeManifest(
      concurrentCandidate,
      providerPluginRegistry,
    );
    if (!concurrent.ok) throw new Error(concurrent.issues.join("; "));

    let failure = "";
    try {
      await syncBundledAdapters({
        environment: state.environment,
        output: { stdout: () => undefined, stderr: () => undefined },
        wrenchMain: (arguments_, _environment, output) => {
          writeSuccessfulValidation(arguments_, output);
          return Promise.resolve(0);
        },
        installGeneration: (selections, environment) => {
          installManifest(concurrent.value, {
            force: true,
            environment,
            registry: providerPluginRegistry,
          });
          return installBundledAdapterGeneration(
            selections,
            environment,
            { registry: providerPluginRegistry },
          );
        },
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain(
      "installed adapter x changed after it was classified",
    );

    const loaded = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(loaded.ok).toBeTrue();
    if (!loaded.ok) throw new Error(loaded.issues.join("; "));
    expect(loaded.value.version).toBe("99.0.0");
  });

  test("rejects symlinked inventory and asset/registry drift", () => {
    const symlinked = copiedAssets();
    symlinkSync(
      join(symlinked.assets, "x", "wrench-adapter.json"),
      join(symlinked.assets, "x", "lookalike.json"),
    );
    expect(() => discoverBundledAdapters(symlinked.assets)).toThrow(
      "symbolic link",
    );

    const drifted = copiedAssets();
    const extra = join(drifted.assets, "extra");
    mkdirSync(extra);
    writeFileSync(
      join(extra, "wrench-adapter.json"),
      readFileSync(
        join(drifted.assets, "x", "wrench-adapter.json"),
      ),
    );
    expect(() => discoverBundledAdapters(drifted.assets)).toThrow(
      "duplicate IDs",
    );
  });

  test("reports preserved logical installs without trusting CLI status text", async () => {
    const state = temporaryState();
    const captured = outputCapture();
    const discovered = discoverBundledAdapters();
    const x = discovered.find((adapter) => adapter.id === "x")!;
    const userManifest = {
      ...structuredClone(x.current.manifest),
      version: "9.9.9",
    };
    mkdirSync(state.environment.WRENCH_STATE_HOME!, {
      recursive: true,
      mode: 0o700,
    });
    const legacyPath = adapterManifestPath("x", state.environment);
    expect(basename(legacyPath)).toBe("io-adapter.json");
    mkdirSync(dirname(legacyPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      legacyPath,
      `${JSON.stringify(userManifest)}\n`,
      { mode: 0o600 },
    );
    let selections: readonly BundledAdapterGenerationSelection[] = [];

    const result = await syncBundledAdapters({
      environment: state.environment,
      output: captured.output,
      wrenchMain: (arguments_, _environment, output) => {
        writeSuccessfulValidation(arguments_, output);
        return Promise.resolve(0);
      },
      installGeneration: (value) => {
        selections = value;
        return {
          commitId: "00000000-0000-4000-8000-000000000003",
          installed: value.length,
          preservedLegacy: 0,
        };
      },
    });

    expect(result.preserved).toBe(1);
    expect(captured.stderr()).toContain("preserved the installed x adapter");
    const selectedX = selections.find((selection) => selection.id === "x");
    expect(selectedX?.state).toBe("present");
    if (selectedX?.state !== "present") throw new Error("x selection missing");
    expect(selectedX.manifest.version).toBe("9.9.9");
  });
});
