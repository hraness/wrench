import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  parseRuntimeManifest,
  sha256,
  type WrenchManifest,
} from "./model";
import { providerPluginRegistry } from "./provider-plugins";
import {
  adapterManifestPath,
  installBundledAdapterGeneration as installBundledAdapterGenerationWithRegistry,
  installManifest as installManifestWithRegistry,
  listInstalledManifests as listInstalledManifestsWithRegistry,
  loadInstalledManifest as loadInstalledManifestWithRegistry,
  removeInstalledManifest,
  type BundledAdapterGenerationSelection,
} from "./storage";

const installBundledAdapterGeneration = (
  selections: Parameters<typeof installBundledAdapterGenerationWithRegistry>[0],
  environment: Parameters<typeof installBundledAdapterGenerationWithRegistry>[1],
  options: Parameters<typeof installBundledAdapterGenerationWithRegistry>[2] = {},
) => installBundledAdapterGenerationWithRegistry(
  selections,
  environment,
  { ...options, registry: providerPluginRegistry },
);
const installManifest = (
  manifest: Parameters<typeof installManifestWithRegistry>[0],
  options: Parameters<typeof installManifestWithRegistry>[1],
) => installManifestWithRegistry(manifest, {
  ...options,
  registry: options.registry ?? providerPluginRegistry,
});
const loadInstalledManifest = (
  id: string,
  environment: Readonly<Record<string, string | undefined>>,
  registry = providerPluginRegistry,
) => loadInstalledManifestWithRegistry(
  id,
  environment,
  registry,
);
const listInstalledManifests = (
  environment: Readonly<Record<string, string | undefined>>,
  registry = providerPluginRegistry,
) => listInstalledManifestsWithRegistry(environment, registry);

const roots: string[] = [];
const assets = join(import.meta.dir, "assets", "adapters");

setDefaultTimeout(30_000);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): {
  readonly root: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
} {
  const root = mkdtempSync(join(tmpdir(), "wrench-adapter-generation-test-"));
  roots.push(root);
  return {
    root,
    environment: { WRENCH_STATE_HOME: join(root, "state") },
  };
}

function currentManifest(surface: "linkedin" | "x"): WrenchManifest {
  const parsed = parseRuntimeManifest(
    JSON.parse(
      readFileSync(
        join(assets, surface, "wrench-adapter.json"),
        "utf8",
      ),
    ) as unknown,
    providerPluginRegistry,
  );
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
}

function versioned(manifest: WrenchManifest, version: string): WrenchManifest {
  const candidate = { ...structuredClone(manifest), version };
  const parsed = parseRuntimeManifest(candidate, providerPluginRegistry);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
}

function selection(manifest: WrenchManifest): BundledAdapterGenerationSelection {
  return {
    id: manifest.id,
    state: "present",
    manifest,
    sourceContentSha256: sha256(`${canonicalJson(manifest)}\n`),
  };
}

describe("content-addressed adapter generations", () => {
  test("publishes a complete generation and retains the flat layout as a mirror", () => {
    const state = fixture();
    const linkedin = currentManifest("linkedin");
    const x = currentManifest("x");

    const result = installBundledAdapterGeneration(
      [selection(linkedin), selection(x)],
      state.environment,
    );

    expect(result.installed).toBe(2);
    expect(loadInstalledManifest(
      "linkedin",
      state.environment,
      providerPluginRegistry,
    )).toEqual({ ok: true, value: linkedin });
    expect(loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    )).toEqual({ ok: true, value: x });
    expect(listInstalledManifests(
      state.environment,
      providerPluginRegistry,
    ).map((entry) => entry.id)).toEqual(["linkedin", "x"]);
    expect(readFileSync(
      adapterManifestPath("x", state.environment),
      "utf8",
    )).toBe(`${canonicalJson(x)}\n`);

    const index = JSON.parse(readFileSync(
      join(state.environment.WRENCH_STATE_HOME!, "adapter-generations", "current.json"),
      "utf8",
    )) as {
      readonly commitId: string;
      readonly entries: readonly {
        readonly objectContentSha256: string;
      }[];
    };
    expect(index.commitId).toBe(result.commitId);
    expect(index.entries).toHaveLength(2);
    for (const entry of index.entries) {
      const objectPath = join(
        state.environment.WRENCH_STATE_HOME!,
        "adapter-generations",
        "objects",
        `${entry.objectContentSha256}.json`,
      );
      expect(sha256(readFileSync(objectPath, "utf8"))).toBe(
        entry.objectContentSha256,
      );
    }
  });

  test("an interruption before the pointer keeps the old generation visible", () => {
    const state = fixture();
    const original = versioned(currentManifest("x"), "7.0.0");
    const successor = versioned(original, "7.1.0");
    installBundledAdapterGeneration([selection(original)], state.environment);

    expect(() => installBundledAdapterGeneration(
      [selection(successor)],
      state.environment,
      {
        afterObjectForTest: () => {
          throw new Error("synthetic pre-commit interruption");
        },
      },
    )).toThrow("synthetic pre-commit interruption");

    const loaded = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(loaded.ok && loaded.value.version).toBe("7.0.0");
  });

  test("an interruption after the pointer exposes the complete new generation", () => {
    const state = fixture();
    const originalX = versioned(currentManifest("x"), "8.0.0");
    const originalLinkedIn = versioned(currentManifest("linkedin"), "8.0.0");
    installBundledAdapterGeneration(
      [selection(originalLinkedIn), selection(originalX)],
      state.environment,
    );
    const successorX = versioned(originalX, "8.1.0");
    const successorLinkedIn = versioned(originalLinkedIn, "8.1.0");

    expect(() => installBundledAdapterGeneration(
      [selection(successorLinkedIn), selection(successorX)],
      state.environment,
      {
        afterCommitForTest: () => {
          throw new Error("synthetic post-commit interruption");
        },
      },
    )).toThrow("synthetic post-commit interruption");

    for (const id of ["linkedin", "x"] as const) {
      const loaded = loadInstalledManifest(
        id,
        state.environment,
        providerPluginRegistry,
      );
      expect(loaded.ok && loaded.value.version).toBe("8.1.0");
    }
  });

  test("recovers a dead post-commit writer without rolling back its pointer", async () => {
    const state = fixture();
    const original = versioned(currentManifest("x"), "9.0.0");
    installBundledAdapterGeneration([selection(original)], state.environment);
    const storageUrl = pathToFileURL(join(import.meta.dir, "storage.ts")).href;
    const modelUrl = pathToFileURL(join(import.meta.dir, "model.ts")).href;
    const pluginUrl = pathToFileURL(
      join(import.meta.dir, "provider-plugins.ts"),
    ).href;
    const manifestPath = join(state.root, "successor.json");
    const successor = versioned(original, "9.1.0");
    writeFileSync(manifestPath, `${canonicalJson(successor)}\n`, { mode: 0o600 });
    chmodSync(manifestPath, 0o600);
    const script = `
      import { readFileSync } from "node:fs";
      import { installBundledAdapterGeneration } from ${JSON.stringify(storageUrl)};
      import { canonicalJson, parseRuntimeManifest, sha256 } from ${JSON.stringify(modelUrl)};
      import { providerPluginRegistry } from ${JSON.stringify(pluginUrl)};
      const value = parseRuntimeManifest(JSON.parse(readFileSync(process.env.WRENCH_TEST_MANIFEST, "utf8")), providerPluginRegistry);
      if (!value.ok) throw new Error(value.issues.join("; "));
      installBundledAdapterGeneration([{
        id: value.value.id,
        state: "present",
        manifest: value.value,
        sourceContentSha256: sha256(canonicalJson(value.value) + "\\n"),
      }], process.env, {
        registry: providerPluginRegistry,
        afterCommitForTest: () => process.exit(91),
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        WRENCH_STATE_HOME: state.environment.WRENCH_STATE_HOME,
        WRENCH_TEST_MANIFEST: manifestPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(status).toBe(91);
    expect(stderr).toBe("");
    const committed = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(committed.ok && committed.value.version).toBe("9.1.0");

    const final = versioned(successor, "9.2.0");
    installBundledAdapterGeneration([selection(final)], state.environment);
    const loaded = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(loaded.ok && loaded.value.version).toBe("9.2.0");
  });

  test("indexed lifecycle updates and tombstones switch one atomic pointer", () => {
    const state = fixture();
    const original = versioned(currentManifest("x"), "10.0.0");
    installBundledAdapterGeneration([selection(original)], state.environment);
    const replacement = versioned(original, "10.1.0");

    installManifest(replacement, {
      force: true,
      environment: state.environment,
      registry: providerPluginRegistry,
    });
    let loaded = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(loaded.ok && loaded.value.version).toBe("10.1.0");

    expect(removeInstalledManifest("x", state.environment)).toBeTrue();
    loaded = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(loaded.ok).toBeFalse();
    expect(listInstalledManifests(
      state.environment,
      providerPluginRegistry,
    )).toEqual([]);
  });

  test("preserves a nested edit that races an indexed replacement", () => {
    const state = fixture();
    const original = versioned(currentManifest("x"), "11.0.0");
    const concurrentEdit = versioned(original, "11.1.0");
    const attemptedReplacement = versioned(original, "12.0.0");
    installBundledAdapterGeneration([selection(original)], state.environment);

    expect(() => installManifest(attemptedReplacement, {
      force: true,
      environment: state.environment,
      registry: providerPluginRegistry,
      beforeReplace: () => installManifest(concurrentEdit, {
        force: true,
        environment: state.environment,
        registry: providerPluginRegistry,
      }),
    })).toThrow("adapter generation changed before manifest replacement");

    const loaded = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(loaded.ok && loaded.value.version).toBe("11.1.0");
  });

  test("fails closed when an immutable object no longer matches its address", () => {
    const state = fixture();
    const manifest = currentManifest("x");
    installBundledAdapterGeneration([selection(manifest)], state.environment);
    const index = JSON.parse(readFileSync(
      join(state.environment.WRENCH_STATE_HOME!, "adapter-generations", "current.json"),
      "utf8",
    )) as {
      readonly entries: readonly {
        readonly objectContentSha256: string;
      }[];
    };
    const objectPath = join(
      state.environment.WRENCH_STATE_HOME!,
      "adapter-generations",
      "objects",
      `${index.entries[0]!.objectContentSha256}.json`,
    );
    writeFileSync(objectPath, '{"tampered":true}\n', { mode: 0o600 });

    const loaded = loadInstalledManifest(
      "x",
      state.environment,
      providerPluginRegistry,
    );
    expect(loaded.ok).toBeFalse();
    if (loaded.ok) throw new Error("tampered object unexpectedly loaded");
    expect(loaded.issues.join(" ")).toContain("hash-mismatched");
  });
});
