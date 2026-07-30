import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverSourceProviderPluginIds,
  generateProviderPluginCatalog,
  renderProviderPluginCatalog,
} from "./generate-provider-plugin-catalog";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "wrench-provider-plugins-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("provider plugin source catalog", () => {
  test("discovers only canonical plugin directories in deterministic order", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "AGENTS.md"), "# Contents\n\n# Guidelines\n");
    for (const id of ["zebra-web", "alpha-web"]) {
      mkdirSync(join(root, id));
      writeFileSync(join(root, id, "plugin.ts"), "export default {};\n");
    }

    expect(discoverSourceProviderPluginIds(root)).toEqual(["alpha-web", "zebra-web"]);
  });

  test("renders stable static imports without evaluating plugin code", () => {
    const root = join("/workspace", "src", "plugins");
    const outputPath = join("/workspace", "src", "provider-plugins.generated.ts");
    expect(renderProviderPluginCatalog(["alpha-web"], { pluginRoot: root, outputPath })).toContain(
      'import sourceProviderPlugin0 from "./plugins/alpha-web/plugin";',
    );
    expect(renderProviderPluginCatalog(["alpha-web"], { pluginRoot: root, outputPath })).toContain(
      "sourceProviderPlugin0,",
    );
  });

  test("check mode rejects drift and accepts the exact generated catalog", () => {
    const root = temporaryDirectory();
    const pluginRoot = join(root, "plugins");
    const outputPath = join(root, "provider-plugins.generated.ts");
    mkdirSync(pluginRoot);
    writeFileSync(join(pluginRoot, "AGENTS.md"), "# Contents\n\n# Guidelines\n");
    mkdirSync(join(pluginRoot, "example-web"));
    writeFileSync(join(pluginRoot, "example-web", "plugin.ts"), "export default {};\n");

    expect(() =>
      generateProviderPluginCatalog({ pluginRoot, outputPath, check: true }))
      .toThrow("catalog is stale");
    expect(generateProviderPluginCatalog({ pluginRoot, outputPath, check: false })).toEqual({
      pluginIds: ["example-web"],
      changed: true,
    });
    expect(generateProviderPluginCatalog({ pluginRoot, outputPath, check: true })).toEqual({
      pluginIds: ["example-web"],
      changed: false,
    });
  });

  test("rejects unsafe entries, symlinked plugins, and missing entrypoints", () => {
    const unsafeRoot = temporaryDirectory();
    writeFileSync(join(unsafeRoot, "unexpected.txt"), "no\n");
    expect(() => discoverSourceProviderPluginIds(unsafeRoot)).toThrow("unsafe entry");

    const symlinkRoot = temporaryDirectory();
    const target = temporaryDirectory();
    writeFileSync(join(target, "plugin.ts"), "export default {};\n");
    symlinkSync(target, join(symlinkRoot, "linked-web"));
    expect(() => discoverSourceProviderPluginIds(symlinkRoot)).toThrow("non-symlink directory");

    const missingRoot = temporaryDirectory();
    mkdirSync(join(missingRoot, "empty-web"));
    expect(() => discoverSourceProviderPluginIds(missingRoot)).toThrow("entrypoint is missing");
  });
});
