import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { runCapabilities } from "./catalog-cli";
import { parseRuntimeManifest } from "./model";
import { providerPluginRegistry } from "./provider-plugins";
import { installManifest } from "./storage";

test("catalogs the installed local CLI capability with its exact contract and tool pin", () => {
  const root = mkdtempSync(join(tmpdir(), "wrench-local-cli-catalog-"));
  chmodSync(root, 0o700);
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const environment = { WRENCH_STATE_HOME: join(root, "state"), HOME: root };
    const parsed = parseRuntimeManifest(JSON.parse(readFileSync(join(
      import.meta.dir,
      "assets/adapters/beeper/wrench-web-adapter.json",
    ), "utf8")) as unknown, providerPluginRegistry);
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    installManifest(parsed.value, {
      force: false,
      environment,
      registry: providerPluginRegistry,
    });
    const exitCode = runCapabilities(
      { command: "capabilities", adapterId: "beeper-local", json: true },
      environment,
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
      },
      providerPluginRegistry,
    );
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const view = JSON.parse(stdout.join("")) as {
      readonly ok: boolean;
      readonly adapters: readonly {
        readonly id: string;
        readonly operations: readonly Record<string, unknown>[];
      }[];
    };
    expect(view.ok).toBeTrue();
    expect(view.adapters).toHaveLength(1);
    expect(view.adapters[0]?.id).toBe("beeper-local");
    const operation = view.adapters[0]?.operations.find((entry) =>
      entry.id === "messaging.send");
    expect(operation).toMatchObject({
      transport: "local-cli",
      surface: "beeper",
      localCliAction: "messaging.send",
      localCliContractVersion: 1,
      state: "observed",
      localCliTool: {
        schemaVersion: 1,
        id: "beeper-cli",
        versionScheme: "semver",
      },
    });
    expect(operation?.localCliContractHash).toMatch(/^[a-f0-9]{64}$/u);
    const tool = operation?.localCliTool as {
      readonly artifacts?: readonly unknown[];
    } | undefined;
    expect(tool?.artifacts).toHaveLength(4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
