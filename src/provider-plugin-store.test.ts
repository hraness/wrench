import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";

import { canonicalJson } from "./model";
import { currentProcessStartIdentity } from "./process-identity";
import {
  renderPortableProviderPluginManifest,
  verifyPortableProviderPluginPackageDirectory,
  type PortableProviderPluginManifestV1,
} from "./provider-plugin-package";
import {
  disablePortableProviderPluginPackage,
  installPortableProviderPluginPackage,
  listInstalledPortableProviderPlugins,
  listPortableProviderPluginInstallations,
  loadInstalledPortableProviderPlugin,
  loadPortableProviderPluginInstallation,
  parsePortableProviderPluginTrustApproval,
  portableProviderPluginStorePaths,
  removePortableProviderPluginPackage,
  withPortableProviderPluginCatalogLock,
} from "./provider-plugin-store";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const allowActivation = (): void => {};
const assertQuiescent = (): void => {};
const TEST_CHILD_SIGNAL_TIMEOUT_MS = 45_000;

function createPackage(
  parent: string,
  name: string,
  version: string,
  runtime: string,
  options: {
    readonly id?: string;
    readonly adapterId?: string;
    readonly surfaceId?: string;
  } = {},
): string {
  const root = join(parent, name);
  const runtimeBytes = Buffer.from(runtime, "utf8");
  const id = options.id ?? "example-web";
  mkdirSync(join(root, "dist"), { recursive: true, mode: 0o700 });
  const manifest: PortableProviderPluginManifestV1 = {
    schemaVersion: 1,
    hostApiVersion: 1,
    id,
    version,
    displayName: `${id} plugin`,
    runtime: {
      kind: "bun-js",
      entrypoint: "dist/plugin.mjs",
    },
    provenance: {
      kind: "local",
    },
    capabilities: {
      networkOrigins: ["https://www.example.com"],
      planFiles: "none",
      state: "namespaced",
      sessionMaterial: [],
    },
    bindings: [
      {
        transport: "web-session-api",
        adapterId: options.adapterId ?? id,
        surfaceId: options.surfaceId ?? "example",
        origin: "https://www.example.com",
        authKinds: ["cookies-file"],
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
        sha256: sha256(runtimeBytes),
      },
    ],
  };
  writeFileSync(join(root, "dist", "plugin.mjs"), runtimeBytes);
  writeFileSync(
    join(root, "wrench-plugin.json"),
    renderPortableProviderPluginManifest(manifest),
  );
  return root;
}

function approval(path: string): {
  readonly decision: "trust-executable-code";
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly bundleSha256: string;
} {
  const verified = verifyPortableProviderPluginPackageDirectory(path);
  return {
    decision: "trust-executable-code",
    pluginId: verified.manifest.id,
    pluginVersion: verified.manifest.version,
    bundleSha256: verified.bundleSha256,
  };
}

function withRoot(callback: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "wrench-plugin-store-"));
  chmodSync(root, 0o700);
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withAsyncRoot(
  callback: (root: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "wrench-plugin-store-"));
  chmodSync(root, 0o700);
  try {
    await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) {
      throw new Error(`timed out waiting for child signal: ${path}`);
    }
    await Bun.sleep(10);
  }
}

async function waitForDirectoryEntryCount(
  path: string,
  count: number,
): Promise<readonly string[]> {
  const deadline = performance.now() + TEST_CHILD_SIGNAL_TIMEOUT_MS;
  for (;;) {
    const entries = readdirSync(path).sort();
    if (entries.length >= count) return entries;
    if (performance.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${count} child signals in ${path}`,
      );
    }
    await Bun.sleep(10);
  }
}

describe("portable provider plugin trust approval", () => {
  test("requires one exact, content-bound executable-code decision", () => {
    expect(parsePortableProviderPluginTrustApproval({
      decision: "trust-executable-code",
      pluginId: "example-web",
      pluginVersion: "1.0.0",
      bundleSha256: "a".repeat(64),
    })).toEqual({
      decision: "trust-executable-code",
      pluginId: "example-web",
      pluginVersion: "1.0.0",
      bundleSha256: "a".repeat(64),
    });
    expect(() =>
      parsePortableProviderPluginTrustApproval({
        decision: "trust-code",
        pluginId: "example-web",
        pluginVersion: "1.0.0",
        bundleSha256: "a".repeat(64),
      })).toThrow("explicitly trust executable code");
    expect(() =>
      parsePortableProviderPluginTrustApproval({
        decision: "trust-executable-code",
        pluginId: "example-web",
        pluginVersion: "1.0.0",
        bundleSha256: "a".repeat(64),
        force: true,
      })).toThrow("must contain exactly");
    expect(() =>
      parsePortableProviderPluginTrustApproval({
        decision: "trust-executable-code",
        pluginId: "example-web",
        pluginVersion: "1.0.0-01",
        bundleSha256: "a".repeat(64),
      })).toThrow("strict semantic version");

    let getterCalls = 0;
    const accessorApproval: Record<string, unknown> = {
      decision: "trust-executable-code",
      pluginId: "example-web",
      pluginVersion: "1.0.0",
      bundleSha256: "a".repeat(64),
    };
    Object.defineProperty(accessorApproval, "pluginVersion", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return "1.0.0";
      },
    });
    expect(() =>
      parsePortableProviderPluginTrustApproval(accessorApproval)).toThrow(
      "portable plugin trust approval must be an object",
    );
    expect(getterCalls).toBe(0);
  });
});

describe("portable provider plugin store", () => {
  test("reads an absent store without creating it", () => {
    withRoot((root) => {
      const storeRoot = join(root, "missing-store");
      expect(
        loadInstalledPortableProviderPlugin(storeRoot, "example-web"),
      ).toBeNull();
      expect(listInstalledPortableProviderPlugins(storeRoot)).toEqual([]);
      expect(existsSync(storeRoot)).toBeFalse();
    });
  });

  test("canonicalizes an absent store through its physical ancestor", () => {
    withRoot((root) => {
      const physicalParent = join(root, "physical");
      const aliasParent = join(root, "alias");
      mkdirSync(physicalParent, { mode: 0o700 });
      symlinkSync(physicalParent, aliasParent, "dir");
      const physicalStore = join(physicalParent, "missing", "store");
      const aliasedStore = join(aliasParent, "missing", "store");

      expect(portableProviderPluginStorePaths(aliasedStore)).toEqual(
        portableProviderPluginStorePaths(physicalStore),
      );
      expect(
        portableProviderPluginStorePaths(aliasedStore).root,
      ).toBe(join(realpathSync(physicalParent), "missing", "store"));
      expect(existsSync(physicalStore)).toBeFalse();
    });
  });

  test("copies verified bytes into a private immutable artifact and activates it", () => {
    withRoot((root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const storeRoot = join(root, "store");
      const expected = verifyPortableProviderPluginPackageDirectory(source);
      const installed = installPortableProviderPluginPackage(source, {
        storeRoot,
        approval: approval(source),
        expectedCurrentBundleSha256: null,
        assertActivatable: allowActivation,
        assertCurrentQuiescent: assertQuiescent,
        now: new Date("2026-07-24T12:34:56.000Z"),
      });
      expect(installed.package.bundleSha256).toBe(expected.bundleSha256);
      expect(installed.active).toEqual({
        schemaVersion: 1,
        pluginId: "example-web",
        pluginVersion: "1.0.0",
        bundleSha256: expected.bundleSha256,
        activatedAt: "2026-07-24T12:34:56.000Z",
        status: "enabled",
      });
      expect(installed.trust.decision).toBe("trust-executable-code");
      expect(installed.trust.trustedAt).toBe("2026-07-24T12:34:56.000Z");

      const paths = portableProviderPluginStorePaths(storeRoot);
      for (const directory of Object.values(paths)) {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      }
      expect(
        statSync(join(paths.active, "example-web.json")).mode & 0o777,
      ).toBe(0o600);
      expect(
        statSync(join(paths.trust, `${expected.bundleSha256}.json`)).mode
          & 0o777,
      ).toBe(0o600);

      writeFileSync(
        join(source, "dist", "plugin.mjs"),
        "export default { changed: true };\n",
      );
      const loaded = loadInstalledPortableProviderPlugin(
        storeRoot,
        "example-web",
      );
      expect(loaded?.package.bundleSha256).toBe(expected.bundleSha256);
      expect(
        readFileSync(join(installed.artifactPath, "dist", "plugin.mjs"), "utf8"),
      ).toBe("export default { version: 1 };\n");
      expect(
        listInstalledPortableProviderPlugins(storeRoot).map(
          (plugin) => plugin.active.pluginId,
        ),
      ).toEqual(["example-web"]);
    });
  });

  test("requires exact compare-and-swap state for an upgrade", () => {
    withRoot((root) => {
      const firstSource = createPackage(
        root,
        "source-v1",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const secondSource = createPackage(
        root,
        "source-v2",
        "1.1.0",
        "export default { version: 2 };\n",
      );
      const storeRoot = join(root, "store");
      const first = installPortableProviderPluginPackage(firstSource, {
        storeRoot,
        approval: approval(firstSource),
        expectedCurrentBundleSha256: null,
        assertActivatable: allowActivation,
        assertCurrentQuiescent: assertQuiescent,
        now: new Date("2026-07-24T12:00:00.000Z"),
      });
      const secondApproval = approval(secondSource);

      expect(() =>
        installPortableProviderPluginPackage(secondSource, {
          storeRoot,
          approval: secondApproval,
          expectedCurrentBundleSha256: null,
          assertActivatable: allowActivation,
          assertCurrentQuiescent: assertQuiescent,
        })).toThrow("already exists");
      expect(() =>
        installPortableProviderPluginPackage(secondSource, {
          storeRoot,
          approval: secondApproval,
          expectedCurrentBundleSha256: "f".repeat(64),
          assertActivatable: allowActivation,
          assertCurrentQuiescent: assertQuiescent,
        })).toThrow("changed from its expected");
      expect(() =>
        installPortableProviderPluginPackage(secondSource, {
          storeRoot,
          approval: {
            ...secondApproval,
            bundleSha256: "f".repeat(64),
          },
          expectedCurrentBundleSha256: first.active.bundleSha256,
          assertActivatable: allowActivation,
          assertCurrentQuiescent: assertQuiescent,
        })).toThrow("does not match the verified package");

      expect(() =>
        installPortableProviderPluginPackage(secondSource, {
          storeRoot,
          approval: secondApproval,
          expectedCurrentBundleSha256: first.active.bundleSha256,
          assertActivatable: allowActivation,
          assertCurrentQuiescent: () => {
            throw new Error("current bundle owns an unsettled plan");
          },
        })).toThrow("current bundle owns an unsettled plan");
      expect(
        loadInstalledPortableProviderPlugin(storeRoot, "example-web")
          ?.active.bundleSha256,
      ).toBe(first.active.bundleSha256);
      const secondPackage =
        verifyPortableProviderPluginPackageDirectory(secondSource);
      expect(existsSync(join(
        portableProviderPluginStorePaths(storeRoot).artifacts,
        secondPackage.bundleSha256,
      ))).toBeTrue();

      const hookOrder: string[] = [];
      const second = installPortableProviderPluginPackage(secondSource, {
        storeRoot,
        approval: secondApproval,
        expectedCurrentBundleSha256: first.active.bundleSha256,
        assertActivatable: (candidate) => {
          hookOrder.push(`activate:${candidate.bundleSha256}`);
        },
        assertCurrentQuiescent: (bundleSha256, artifactPath) => {
          hookOrder.push(`quiescent:${bundleSha256}`);
          expect(bundleSha256).toBe(first.package.bundleSha256);
          expect(artifactPath).toBe(first.artifactPath);
        },
        now: new Date("2026-07-24T13:00:00.000Z"),
      });
      expect(hookOrder).toEqual([
        `activate:${second.package.bundleSha256}`,
        `quiescent:${first.package.bundleSha256}`,
      ]);
      expect(second.active.pluginVersion).toBe("1.1.0");
      expect(
        loadInstalledPortableProviderPlugin(storeRoot, "example-web")
          ?.active.bundleSha256,
      ).toBe(second.active.bundleSha256);
      expect(existsSync(first.artifactPath)).toBeTrue();
    });
  });

  test("disables and removes only an exact installed digest while retaining audit bytes", () => {
    withRoot((root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const storeRoot = join(root, "store");
      const installed = installPortableProviderPluginPackage(source, {
        storeRoot,
        approval: approval(source),
        expectedCurrentBundleSha256: null,
        assertActivatable: allowActivation,
        assertCurrentQuiescent: assertQuiescent,
        now: new Date("2026-07-24T12:00:00.000Z"),
      });
      expect(() =>
        disablePortableProviderPluginPackage(
          storeRoot,
          "example-web",
          {
            expectedBundleSha256: "f".repeat(64),
            assertQuiescent,
          },
        )).toThrow("changed from its expected");

      expect(() =>
        disablePortableProviderPluginPackage(
          storeRoot,
          "example-web",
          {
            expectedBundleSha256: installed.active.bundleSha256,
            assertQuiescent: () => {
              throw new Error("bundle has one active invocation");
            },
          },
        )).toThrow("bundle has one active invocation");
      expect(
        loadInstalledPortableProviderPlugin(storeRoot, "example-web")
          ?.active.status,
      ).toBe("enabled");

      const disabled = disablePortableProviderPluginPackage(
        storeRoot,
        "example-web",
        {
          expectedBundleSha256: installed.active.bundleSha256,
          assertQuiescent: (bundleSha256, artifactPath) => {
            expect(bundleSha256).toBe(installed.package.bundleSha256);
            expect(artifactPath).toBe(installed.artifactPath);
          },
          now: new Date("2026-07-24T13:00:00.000Z"),
        },
      );
      expect(disabled.active).toMatchObject({
        status: "disabled",
        disabledAt: "2026-07-24T13:00:00.000Z",
      });
      expect(
        loadInstalledPortableProviderPlugin(storeRoot, "example-web"),
      ).toBeNull();
      expect(listInstalledPortableProviderPlugins(storeRoot)).toEqual([]);
      expect(
        loadPortableProviderPluginInstallation(storeRoot, "example-web")
          ?.active.status,
      ).toBe("disabled");
      expect(
        listPortableProviderPluginInstallations(storeRoot)
          .map((value) => value.active.status),
      ).toEqual(["disabled"]);

      const reenabled = installPortableProviderPluginPackage(source, {
        storeRoot,
        approval: approval(source),
        expectedCurrentBundleSha256: installed.active.bundleSha256,
        assertActivatable: allowActivation,
        assertCurrentQuiescent: assertQuiescent,
        now: new Date("2026-07-24T14:00:00.000Z"),
      });
      expect(reenabled.active.status).toBe("enabled");
      expect(() =>
        removePortableProviderPluginPackage(storeRoot, "example-web", {
          expectedBundleSha256: reenabled.active.bundleSha256,
          assertQuiescent: () => {
            throw new Error("bundle owns an unsettled journal");
          },
        })).toThrow("unsettled journal");
      expect(
        loadInstalledPortableProviderPlugin(storeRoot, "example-web"),
      ).not.toBeNull();

      const removed = removePortableProviderPluginPackage(
        storeRoot,
        "example-web",
        {
          expectedBundleSha256: reenabled.active.bundleSha256,
          assertQuiescent: (bundleSha256, artifactPath) => {
            expect(bundleSha256).toBe(reenabled.package.bundleSha256);
            expect(artifactPath).toBe(reenabled.artifactPath);
          },
        },
      );
      expect(removed.package.bundleSha256)
        .toBe(reenabled.package.bundleSha256);
      expect(
        loadPortableProviderPluginInstallation(storeRoot, "example-web"),
      ).toBeNull();
      expect(existsSync(removed.artifactPath)).toBeTrue();
      expect(
        existsSync(
          join(
            portableProviderPluginStorePaths(storeRoot).trust,
            `${removed.package.bundleSha256}.json`,
          ),
        ),
      ).toBeTrue();
    });
  });

  test("shares the catalog lock with a synchronous outer kernel transition but rejects nested mutations", () => {
    withRoot((root) => {
      const firstSource = createPackage(
        root,
        "first-source",
        "1.0.0",
        "export default { plugin: 'first' };\n",
        { id: "first-web" },
      );
      const nestedSource = createPackage(
        root,
        "nested-source",
        "1.0.0",
        "export default { plugin: 'nested' };\n",
        { id: "nested-web" },
      );
      const storeRoot = join(root, "store");
      let nestedCatalogTransitionRan = false;
      const installed = withPortableProviderPluginCatalogLock(
        storeRoot,
        new Date("2026-07-24T12:00:00.000Z"),
        () => installPortableProviderPluginPackage(firstSource, {
          storeRoot,
          approval: approval(firstSource),
          expectedCurrentBundleSha256: null,
          assertCurrentQuiescent: assertQuiescent,
          assertActivatable: () => {
            withPortableProviderPluginCatalogLock(
              storeRoot,
              new Date("2026-07-24T12:00:00.000Z"),
              () => {
                nestedCatalogTransitionRan = true;
              },
            );
            expect(() =>
              installPortableProviderPluginPackage(nestedSource, {
                storeRoot,
                approval: approval(nestedSource),
                expectedCurrentBundleSha256: null,
                assertActivatable: allowActivation,
                assertCurrentQuiescent: assertQuiescent,
              })).toThrow("catalog mutation cannot be nested");
          },
        }),
      );

      expect(nestedCatalogTransitionRan).toBeTrue();
      expect(installed.active.pluginId).toBe("first-web");
      expect(
        loadPortableProviderPluginInstallation(storeRoot, "nested-web"),
      ).toBeNull();
      expect(() =>
        withPortableProviderPluginCatalogLock(
          storeRoot,
          new Date("2026-07-24T12:00:00.000Z"),
          () => Promise.resolve(),
        )).toThrow("must complete synchronously");
    });
  });

  test("serializes distinct IDs cross-process so one hook can reject a shared route", async () => {
    await withAsyncRoot(async (root) => {
      const firstSource = createPackage(
        root,
        "first-source",
        "1.0.0",
        "export default { plugin: 'first' };\n",
        {
          id: "first-web",
          adapterId: "shared-web",
          surfaceId: "shared",
        },
      );
      const secondSource = createPackage(
        root,
        "second-source",
        "1.0.0",
        "export default { plugin: 'second' };\n",
        {
          id: "second-web",
          adapterId: "shared-web",
          surfaceId: "shared",
        },
      );
      const storeRoot = join(root, "store");
      const readyPath = join(root, "child-ready");
      const releasePath = join(root, "release-child");
      const storeUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-store.ts"),
      ).href;
      const packageUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-package.ts"),
      ).href;
      const childScript = `
        import { existsSync, writeFileSync } from "node:fs";
        import { installPortableProviderPluginPackage } from ${JSON.stringify(storeUrl)};
        import { verifyPortableProviderPluginPackageDirectory } from ${JSON.stringify(packageUrl)};
        const source = process.env.WRENCH_TEST_PLUGIN_SOURCE;
        const storeRoot = process.env.WRENCH_TEST_PLUGIN_STORE;
        const verified = verifyPortableProviderPluginPackageDirectory(source);
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        installPortableProviderPluginPackage(source, {
          storeRoot,
          approval: {
            decision: "trust-executable-code",
            pluginId: verified.manifest.id,
            pluginVersion: verified.manifest.version,
            bundleSha256: verified.bundleSha256,
          },
          expectedCurrentBundleSha256: null,
          assertCurrentQuiescent: () => undefined,
          assertActivatable: () => {
            writeFileSync(process.env.WRENCH_TEST_PLUGIN_READY, "ready\\n", { flag: "wx" });
            while (!existsSync(process.env.WRENCH_TEST_PLUGIN_RELEASE)) {
              Atomics.wait(sleeper, 0, 0, 10);
            }
          },
        });
      `;
      const child = Bun.spawn([process.execPath, "-e", childScript], {
        env: {
          ...process.env,
          WRENCH_TEST_PLUGIN_SOURCE: firstSource,
          WRENCH_TEST_PLUGIN_STORE: storeRoot,
          WRENCH_TEST_PLUGIN_READY: readyPath,
          WRENCH_TEST_PLUGIN_RELEASE: releasePath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      let secondHookCalls = 0;
      try {
        await waitForFile(readyPath);
        expect(() =>
          installPortableProviderPluginPackage(secondSource, {
            storeRoot,
            approval: approval(secondSource),
            expectedCurrentBundleSha256: null,
            assertCurrentQuiescent: assertQuiescent,
            assertActivatable: () => {
              secondHookCalls += 1;
            },
          })).toThrow("catalog mutation is already locked");
        expect(secondHookCalls).toBe(0);
      } finally {
        writeFileSync(releasePath, "release\n", { flag: "w" });
      }
      const [status, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(status).toBe(0);
      expect(stderr).toBe("");

      expect(() =>
        installPortableProviderPluginPackage(secondSource, {
          storeRoot,
          approval: approval(secondSource),
          expectedCurrentBundleSha256: null,
          assertCurrentQuiescent: assertQuiescent,
          assertActivatable: (candidate) => {
            const claimedAdapters = new Set(
              listPortableProviderPluginInstallations(storeRoot)
                .filter((installation) =>
                  installation.active.status === "enabled"
                )
                .flatMap((installation) =>
                  installation.package.manifest.bindings.map((binding) =>
                    binding.adapterId
                  )
                ),
            );
            if (
              candidate.manifest.bindings.some((binding) =>
                claimedAdapters.has(binding.adapterId)
              )
            ) {
              throw new Error("portable plugin route collision");
            }
          },
        })).toThrow("portable plugin route collision");
      expect(
        listInstalledPortableProviderPlugins(storeRoot)
          .map((installation) => installation.active.pluginId),
      ).toEqual(["first-web"]);
    });
  });

  test("serializes simultaneous stale-lock reclaimers without removing a successor", async () => {
    await withAsyncRoot(async (root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const physicalParent = join(root, "physical-store-parent");
      const aliasParent = join(root, "aliased-store-parent");
      mkdirSync(physicalParent, { mode: 0o700 });
      symlinkSync(physicalParent, aliasParent, "dir");
      const storeRoot = join(physicalParent, "store");
      const aliasedStoreRoot = join(aliasParent, "store");
      expect(portableProviderPluginStorePaths(aliasedStoreRoot)).toEqual(
        portableProviderPluginStorePaths(storeRoot),
      );
      const paths = portableProviderPluginStorePaths(storeRoot);
      for (const directory of Object.values(paths)) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      writeFileSync(
        join(paths.locks, ".catalog-mutation.lock"),
        `${canonicalJson({
          schemaVersion: 1,
          scope: "catalog-mutation",
          acquiredAt: "2026-07-24T12:00:00.000Z",
          pid: 999_999_999,
          bootId: "0".repeat(64),
          processStartId: "0".repeat(64),
        })}\n`,
        { mode: 0o600 },
      );

      const barrierReady = join(root, "barrier-ready");
      const hookReady = join(root, "hook-ready");
      const results = join(root, "results");
      for (const directory of [barrierReady, hookReady, results]) {
        mkdirSync(directory, { mode: 0o700 });
      }
      const barrierRelease = join(root, "release-barrier");
      const hookRelease = join(root, "release-hook");
      const storeUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-store.ts"),
      ).href;
      const packageUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-package.ts"),
      ).href;
      const childScript = `
        import { existsSync, writeFileSync } from "node:fs";
        import { installPortableProviderPluginPackage } from ${JSON.stringify(storeUrl)};
        import { verifyPortableProviderPluginPackageDirectory } from ${JSON.stringify(packageUrl)};
        const source = process.env.WRENCH_TEST_PLUGIN_SOURCE;
        const storeRoot = process.env.WRENCH_TEST_PLUGIN_STORE;
        const verified = verifyPortableProviderPluginPackageDirectory(source);
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        let result;
        try {
          installPortableProviderPluginPackage(source, {
            storeRoot,
            approval: {
              decision: "trust-executable-code",
              pluginId: verified.manifest.id,
              pluginVersion: verified.manifest.version,
              bundleSha256: verified.bundleSha256,
            },
            expectedCurrentBundleSha256: null,
            assertCurrentQuiescent: () => undefined,
            assertActivatable: () => {
              writeFileSync(
                process.env.WRENCH_TEST_PLUGIN_HOOK_READY,
                "entered\\n",
                { flag: "wx", mode: 0o600 },
              );
              while (!existsSync(process.env.WRENCH_TEST_PLUGIN_HOOK_RELEASE)) {
                Atomics.wait(sleeper, 0, 0, 10);
              }
            },
          });
          result = { status: "installed" };
        } catch (error) {
          result = {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        writeFileSync(
          process.env.WRENCH_TEST_PLUGIN_RESULT,
          JSON.stringify(result) + "\\n",
          { flag: "wx", mode: 0o600 },
        );
      `;
      const childCount = 4;
      const children = Array.from(
        { length: childCount },
        (_value, index) => Bun.spawn(
          [process.execPath, "-e", childScript],
          {
            env: {
              ...process.env,
              WRENCH_TEST_PLUGIN_SOURCE: source,
              WRENCH_TEST_PLUGIN_STORE:
                index % 2 === 0 ? storeRoot : aliasedStoreRoot,
              WRENCH_TEST_PLUGIN_LOCK_WAITING_READY:
                join(barrierReady, `${index}`),
              WRENCH_TEST_PLUGIN_LOCK_WAITING_RELEASE: barrierRelease,
              WRENCH_TEST_PLUGIN_LOCK_WAITING_TARGET:
                ".catalog-mutation.lock",
              WRENCH_TEST_PLUGIN_HOOK_READY: join(hookReady, `${index}`),
              WRENCH_TEST_PLUGIN_HOOK_RELEASE: hookRelease,
              WRENCH_TEST_PLUGIN_RESULT: join(results, `${index}.json`),
            },
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          },
        ),
      );
      try {
        await waitForDirectoryEntryCount(barrierReady, childCount);
        const waitingClaimNames = readdirSync(paths.locks).filter((name) =>
          name.startsWith(".lock-claim-")
        );
        expect(waitingClaimNames).toHaveLength(childCount);
        expect(new Set(waitingClaimNames.map((name) =>
          name.slice(".lock-claim-".length, ".lock-claim-".length + 64)
        )).size).toBe(1);
        writeFileSync(barrierRelease, "release\n", {
          flag: "wx",
          mode: 0o600,
        });
        const enteredHooks = await waitForDirectoryEntryCount(hookReady, 1);
        expect(enteredHooks).toHaveLength(1);

        const loserResultNames = await waitForDirectoryEntryCount(
          results,
          childCount - 1,
        );
        expect(readdirSync(hookReady)).toHaveLength(1);
        const loserResults = loserResultNames.map((name) =>
          JSON.parse(readFileSync(join(results, name), "utf8")) as {
            readonly status: string;
            readonly message?: string;
          }
        );
        expect(loserResults.map((result) => result.status)).toEqual(
          Array.from({ length: childCount - 1 }, () => "failed"),
        );
        for (const result of loserResults) {
          expect(result.message).toContain(
            "catalog mutation is already locked",
          );
        }

        writeFileSync(hookRelease, "release\n", {
          flag: "wx",
          mode: 0o600,
        });
        const statuses = await Promise.all(
          children.map((child) => child.exited),
        );
        const stderrs = await Promise.all(
          children.map((child) => new Response(child.stderr).text()),
        );
        expect(statuses).toEqual(Array.from({ length: childCount }, () => 0));
        expect(stderrs).toEqual(Array.from({ length: childCount }, () => ""));

        const finalResults = readdirSync(results).map((name) =>
          JSON.parse(readFileSync(join(results, name), "utf8")) as {
            readonly status: string;
          }
        );
        expect(finalResults.filter(
          (result) => result.status === "installed",
        )).toHaveLength(1);
        expect(finalResults.filter(
          (result) => result.status === "failed",
        )).toHaveLength(childCount - 1);
        expect(readdirSync(paths.locks)).toEqual([]);
        expect(
          listInstalledPortableProviderPlugins(storeRoot).map(
            (installation) => installation.active.pluginId,
          ),
        ).toEqual(["example-web"]);
      } finally {
        if (!existsSync(barrierRelease)) {
          writeFileSync(barrierRelease, "release\n", { mode: 0o600 });
        }
        if (!existsSync(hookRelease)) {
          writeFileSync(hookRelease, "release\n", { mode: 0o600 });
        }
        for (const child of children) {
          if (child.exitCode === null) child.kill("SIGKILL");
        }
        await Promise.all(children.map((child) => child.exited));
      }
    });
  });

  test("retries a claim renamed during its read and reports the live lock", async () => {
    await withAsyncRoot(async (root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const storeRoot = join(root, "store");
      const paths = portableProviderPluginStorePaths(storeRoot);
      for (const directory of Object.values(paths)) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      }

      const lockPath = join(paths.locks, ".catalog-mutation.lock");
      const targetSha256 = createHash("sha256")
        .update("portable-provider-plugin-lock", "utf8")
        .update("\0", "utf8")
        .update(lockPath, "utf8")
        .digest("hex");
      const claimId = "00000000-0000-4000-8000-000000000000";
      const waitingName =
        `.lock-claim-${targetSha256}-waiting-${claimId}.json`;
      const waitingPath = join(paths.locks, waitingName);
      const candidatePath = join(
        paths.locks,
        `.lock-claim-${targetSha256}-candidate-${claimId}.json`,
      );
      const processIdentity = currentProcessStartIdentity();
      writeFileSync(
        waitingPath,
        `${canonicalJson({
          schemaVersion: 1,
          kind: "portable-provider-plugin-lock-claim",
          targetSha256,
          claimId,
          pid: process.pid,
          ...processIdentity,
        })}\n`,
        { mode: 0o600 },
      );

      const readReady = join(root, "claim-read-ready");
      const readRelease = join(root, "claim-read-release");
      const storeUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-store.ts"),
      ).href;
      const packageUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-package.ts"),
      ).href;
      const childScript = `
        import { installPortableProviderPluginPackage } from ${JSON.stringify(storeUrl)};
        import { verifyPortableProviderPluginPackageDirectory } from ${JSON.stringify(packageUrl)};
        const source = process.env.WRENCH_TEST_PLUGIN_SOURCE;
        const verified = verifyPortableProviderPluginPackageDirectory(source);
        let result;
        try {
          installPortableProviderPluginPackage(source, {
            storeRoot: process.env.WRENCH_TEST_PLUGIN_STORE,
            approval: {
              decision: "trust-executable-code",
              pluginId: verified.manifest.id,
              pluginVersion: verified.manifest.version,
              bundleSha256: verified.bundleSha256,
            },
            expectedCurrentBundleSha256: null,
            assertCurrentQuiescent: () => undefined,
            assertActivatable: () => undefined,
          });
          result = { status: "installed" };
        } catch (error) {
          result = {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        console.log(JSON.stringify(result));
      `;
      const child = Bun.spawn([process.execPath, "-e", childScript], {
        env: {
          ...process.env,
          WRENCH_TEST_PLUGIN_SOURCE: source,
          WRENCH_TEST_PLUGIN_STORE: storeRoot,
          WRENCH_TEST_PLUGIN_LOCK_CLAIM_READ_READY: readReady,
          WRENCH_TEST_PLUGIN_LOCK_CLAIM_READ_RELEASE: readRelease,
          WRENCH_TEST_PLUGIN_LOCK_CLAIM_READ_TARGET: waitingName,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        await waitForFile(readReady);
        renameSync(waitingPath, candidatePath);
        rmSync(candidatePath);
        writeFileSync(
          lockPath,
          `${canonicalJson({
            schemaVersion: 1,
            scope: "catalog-mutation",
            acquiredAt: "2026-07-24T12:00:00.000Z",
            pid: process.pid,
            ...processIdentity,
          })}\n`,
          { mode: 0o600 },
        );
        writeFileSync(readRelease, "release\n", {
          flag: "wx",
          mode: 0o600,
        });

        const [status, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(status).toBe(0);
        expect(stderr).toBe("");
        expect(JSON.parse(stdout)).toEqual({
          status: "failed",
          message: "portable plugin catalog mutation is already locked",
        });
        expect(
          readdirSync(paths.locks).filter((name) =>
            name.startsWith(".lock-claim-")
          ),
        ).toEqual([]);
      } finally {
        if (!existsSync(readRelease)) {
          writeFileSync(readRelease, "release\n", { mode: 0o600 });
        }
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
        rmSync(lockPath, { force: true });
      }
    });
  });

  test("publishes lock and claim records atomically across a process exit", async () => {
    await withAsyncRoot(async (root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const storeUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-store.ts"),
      ).href;
      const packageUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-package.ts"),
      ).href;
      const childScript = `
        import { installPortableProviderPluginPackage } from ${JSON.stringify(storeUrl)};
        import { verifyPortableProviderPluginPackageDirectory } from ${JSON.stringify(packageUrl)};
        const source = process.env.WRENCH_TEST_PLUGIN_SOURCE;
        const storeRoot = process.env.WRENCH_TEST_PLUGIN_STORE;
        const verified = verifyPortableProviderPluginPackageDirectory(source);
        installPortableProviderPluginPackage(source, {
          storeRoot,
          approval: {
            decision: "trust-executable-code",
            pluginId: verified.manifest.id,
            pluginVersion: verified.manifest.version,
            bundleSha256: verified.bundleSha256,
          },
          expectedCurrentBundleSha256: null,
          assertCurrentQuiescent: () => undefined,
          assertActivatable: () => undefined,
        });
      `;
      const faults = [
        {
          name: "claim-empty-stage",
          expectedStage: "empty",
          expectedClaimCount: 0,
        },
        {
          name: "lock-partial-stage",
          expectedStage: "partial",
          expectedClaimCount: 1,
        },
      ] as const;

      for (const fault of faults) {
        const storeRoot = join(root, fault.name);
        const child = Bun.spawn([process.execPath, "-e", childScript], {
          env: {
            ...process.env,
            WRENCH_TEST_PLUGIN_SOURCE: source,
            WRENCH_TEST_PLUGIN_STORE: storeRoot,
            WRENCH_TEST_PLUGIN_LOCK_PUBLICATION_CRASH: fault.name,
            WRENCH_TEST_PLUGIN_LOCK_PUBLICATION_TARGET:
              ".catalog-mutation.lock",
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
        });
        const [status, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(status).toBe(92);
        expect(stderr).toBe("");

        const paths = portableProviderPluginStorePaths(storeRoot);
        expect(existsSync(
          join(paths.locks, ".catalog-mutation.lock"),
        )).toBeFalse();
        const entries = readdirSync(paths.locks);
        const publicationNames = entries.filter((name) =>
          name.startsWith(".lock-publication-")
        );
        expect(publicationNames).toHaveLength(1);
        const publicationSize = statSync(
          join(paths.locks, publicationNames[0]!),
        ).size;
        if (fault.expectedStage === "empty") {
          expect(publicationSize).toBe(0);
        } else {
          expect(publicationSize).toBeGreaterThan(0);
        }
        expect(entries.filter((name) =>
          name.startsWith(".lock-claim-")
        )).toHaveLength(fault.expectedClaimCount);

        const installed = installPortableProviderPluginPackage(source, {
          storeRoot,
          approval: approval(source),
          expectedCurrentBundleSha256: null,
          assertActivatable: allowActivation,
          assertCurrentQuiescent: assertQuiescent,
        });
        expect(installed.active.pluginId).toBe("example-web");
        expect(readdirSync(paths.locks)).toEqual([]);
      }
    });
  });

  test("recovers catalog and plugin locks left by an exited activation hook", async () => {
    await withAsyncRoot(async (root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const storeRoot = join(root, "store");
      const storeUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-store.ts"),
      ).href;
      const packageUrl = pathToFileURL(
        join(import.meta.dir, "provider-plugin-package.ts"),
      ).href;
      const childScript = `
        import { installPortableProviderPluginPackage } from ${JSON.stringify(storeUrl)};
        import { verifyPortableProviderPluginPackageDirectory } from ${JSON.stringify(packageUrl)};
        const source = process.env.WRENCH_TEST_PLUGIN_SOURCE;
        const storeRoot = process.env.WRENCH_TEST_PLUGIN_STORE;
        const verified = verifyPortableProviderPluginPackageDirectory(source);
        installPortableProviderPluginPackage(source, {
          storeRoot,
          approval: {
            decision: "trust-executable-code",
            pluginId: verified.manifest.id,
            pluginVersion: verified.manifest.version,
            bundleSha256: verified.bundleSha256,
          },
          expectedCurrentBundleSha256: null,
          assertCurrentQuiescent: () => undefined,
          assertActivatable: () => process.exit(91),
        });
      `;
      const child = Bun.spawn([process.execPath, "-e", childScript], {
        env: {
          ...process.env,
          WRENCH_TEST_PLUGIN_SOURCE: source,
          WRENCH_TEST_PLUGIN_STORE: storeRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [status, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect({ status, stderr }).toEqual({ status: 91, stderr: "" });

      const paths = portableProviderPluginStorePaths(storeRoot);
      expect(existsSync(join(paths.locks, ".catalog-mutation.lock"))).toBeTrue();
      expect(existsSync(join(paths.locks, "example-web.lock"))).toBeTrue();
      expect(
        loadPortableProviderPluginInstallation(storeRoot, "example-web"),
      ).toBeNull();
      const verified = verifyPortableProviderPluginPackageDirectory(source);
      const artifactPath = join(paths.artifacts, verified.bundleSha256);
      expect(
        readFileSync(join(artifactPath, "dist", "plugin.mjs"), "utf8"),
      ).toBe("export default { version: 1 };\n");

      const installed = installPortableProviderPluginPackage(source, {
        storeRoot,
        approval: approval(source),
        expectedCurrentBundleSha256: null,
        assertActivatable: allowActivation,
        assertCurrentQuiescent: assertQuiescent,
      });
      expect(installed.active.status).toBe("enabled");
      expect(existsSync(join(paths.locks, ".catalog-mutation.lock"))).toBeFalse();
      expect(existsSync(join(paths.locks, "example-web.lock"))).toBeFalse();
      expect(
        readFileSync(join(installed.artifactPath, "dist", "plugin.mjs"), "utf8"),
      ).toBe("export default { version: 1 };\n");
    });
  });

  test("fails closed on active-record tampering and live or malformed locks", () => {
    withRoot((root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const storeRoot = join(root, "store");
      const installed = installPortableProviderPluginPackage(source, {
        storeRoot,
        approval: approval(source),
        expectedCurrentBundleSha256: null,
        assertActivatable: allowActivation,
        assertCurrentQuiescent: assertQuiescent,
      });
      const paths = portableProviderPluginStorePaths(storeRoot);
      writeFileSync(
        join(paths.active, "example-web.json"),
        JSON.stringify(installed.active),
        { mode: 0o600 },
      );
      expect(() =>
        loadInstalledPortableProviderPlugin(
          storeRoot,
          "example-web",
        )).toThrow("canonical JSON encoding");

      writeFileSync(
        join(paths.active, "example-web.json"),
        `${JSON.stringify(installed.active)}\n`,
        { mode: 0o600 },
      );
      writeFileSync(
        join(paths.locks, "example-web.lock"),
        '{"pid":123,"schemaVersion":1}\n',
        { mode: 0o600 },
      );
      expect(() =>
        installPortableProviderPluginPackage(source, {
          storeRoot,
          approval: approval(source),
          expectedCurrentBundleSha256: installed.active.bundleSha256,
          assertActivatable: allowActivation,
          assertCurrentQuiescent: assertQuiescent,
        })).toThrow("activation lock must contain exactly");

      writeFileSync(
        join(paths.locks, "example-web.lock"),
        `${canonicalJson({
          schemaVersion: 1,
          pluginId: "example-web",
          acquiredAt: "2026-07-24T12:00:00.000Z",
          pid: process.pid,
          ...currentProcessStartIdentity(),
        })}\n`,
        { mode: 0o600 },
      );
      expect(() =>
        installPortableProviderPluginPackage(source, {
          storeRoot,
          approval: approval(source),
          expectedCurrentBundleSha256: installed.active.bundleSha256,
          assertActivatable: allowActivation,
          assertCurrentQuiescent: assertQuiescent,
        })).toThrow("activation is already locked");
    });
  });

  test("repairs an exact dead-owner activation lock before installing", () => {
    withRoot((root) => {
      const source = createPackage(
        root,
        "source",
        "1.0.0",
        "export default { version: 1 };\n",
      );
      const storeRoot = join(root, "store");
      const paths = portableProviderPluginStorePaths(storeRoot);
      mkdirSync(paths.root, { recursive: true, mode: 0o700 });
      for (const directory of [
        paths.artifacts,
        paths.trust,
        paths.active,
        paths.locks,
      ]) {
        mkdirSync(directory, { mode: 0o700 });
      }
      writeFileSync(
        join(paths.locks, "example-web.lock"),
        `${canonicalJson({
          schemaVersion: 1,
          pluginId: "example-web",
          acquiredAt: "2026-07-24T12:00:00.000Z",
          pid: 999_999_999,
          bootId: "0".repeat(64),
          processStartId: "0".repeat(64),
        })}\n`,
        { mode: 0o600 },
      );
      const installed = installPortableProviderPluginPackage(source, {
        storeRoot,
        approval: approval(source),
        expectedCurrentBundleSha256: null,
        assertActivatable: allowActivation,
        assertCurrentQuiescent: assertQuiescent,
      });
      expect(installed.active.status).toBe("enabled");
      expect(existsSync(join(paths.locks, "example-web.lock"))).toBeFalse();
    });
  });
});
