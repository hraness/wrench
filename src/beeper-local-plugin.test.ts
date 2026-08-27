import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import beeperManifest from "./assets/adapters/beeper/wrench-web-adapter.json";
import { providerPluginRegistry } from "./provider-plugins";
import {
  BEEPER_CLI_COMMAND_COVERAGE,
  BEEPER_CLI_COMMAND_LIST_SHA256,
  BEEPER_CLI_PIN,
  BEEPER_LOCAL_OPERATION_NAMES,
} from "./providers/beeper-local";

const moduleUrl = (name: string): string => pathToFileURL(
  join(import.meta.dir, name),
).href;

async function beeperClosureProbe(
  alterRuntime: boolean,
): Promise<Readonly<{ derived: boolean; hash: string }>> {
  const program = `
import { readFileSync } from "node:fs";
const [{ createProviderPluginRegistry }, { beeperLinkedDevicePlugin }] = await Promise.all([
  import(${JSON.stringify(moduleUrl("provider-plugin-registry.ts"))}),
  import(${JSON.stringify(moduleUrl("plugins/beeper-linked-device/plugin.ts"))}),
]);
const runtimePath = ${JSON.stringify(join(import.meta.dir, "providers", "beeper-local-runtime.ts"))};
let derived = false;
const registry = createProviderPluginRegistry([beeperLinkedDevicePlugin], {
  readDependencySource: (path) => {
    const bytes = readFileSync(path);
    if (!${JSON.stringify(alterRuntime)} || path !== runtimePath) return bytes;
    derived = true;
    return Buffer.concat([bytes, Buffer.from("\\n// derived-closure identity probe\\n", "utf8")]);
  },
});
const binding = registry.requireRoute("local-cli", "beeper");
process.stdout.write(JSON.stringify({
  derived,
  hash: registry.implementationClosureHash(binding),
}));
`;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", program],
    cwd: join(import.meta.dir, ".."),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Beeper closure probe failed: ${stderr}`);
  }
  return JSON.parse(stdout) as Readonly<{ derived: boolean; hash: string }>;
}

describe("Beeper pinned local-CLI provider plugin", () => {
  test("registers the complete bounded semantic surface on one exact CLI identity", () => {
    const plugin = providerPluginRegistry.get("beeper-linked-device");
    const binding = providerPluginRegistry.requireRoute("local-cli", "beeper");
    expect(plugin?.displayName).toBe("Beeper Pinned Local CLI");
    expect(plugin?.version).toBe("2.0.0");
    expect(beeperManifest.schemaVersion).toBe(6);
    expect(beeperManifest.version).toBe("2.0.0");
    expect(Object.keys(beeperManifest.operations).sort()).toEqual(
      [...BEEPER_LOCAL_OPERATION_NAMES].sort(),
    );
    expect(binding.transport).toBe("local-cli");
    if (binding.transport !== "local-cli") throw new Error("Beeper installed the wrong transport");
    expect(binding.authKinds).toEqual(["linked-device-store"]);
    expect(binding.tool).toMatchObject({
      id: BEEPER_CLI_PIN.id,
      version: "0.6.2",
      versionScheme: "semver",
      releaseCommit: BEEPER_CLI_PIN.commit,
      releaseManifestSha256: BEEPER_CLI_PIN.releaseManifestSha256,
      releaseManifestUrl: BEEPER_CLI_PIN.releaseManifestUrl,
    });
    expect(binding.tool.artifacts).toHaveLength(4);
    expect(binding.operations.map((operation) => operation.name).sort()).toEqual(
      [...BEEPER_LOCAL_OPERATION_NAMES].sort(),
    );
    expect(binding.operations.filter((operation) => operation.risk === "R1")).toHaveLength(14);
    expect(binding.operations.every((operation) => operation.state === "observed")).toBeTrue();
    for (const operationName of [
      "conversations.avatar.set",
      "conversations.draft.set",
      "conversations.read-state.set",
    ]) {
      expect(binding.operations.find((operation) => operation.name === operationName)?.reconciliation)
        .toMatchObject({ kind: "boolean-desired-state" });
    }
    expect(plugin?.implementationSources.map((source) => source.label))
      .toEqual(["plugin.ts"]);
    expect(beeperManifest.operations["messaging.send"].description)
      .toContain("network delivery is not asserted");
    expect(beeperManifest.operations["messaging.send"].input.properties.file?.maxBytes)
      .toBe(500 * 1024 * 1024);
    expect(beeperManifest.operations["conversations.draft.set"].input.properties.attachment?.maxBytes)
      .toBe(500 * 1024 * 1024);
    expect(beeperManifest.operations["conversations.focus"].input.properties.attachment?.maxBytes)
      .toBe(500 * 1024 * 1024);
    expect(binding.subject.matches(`beeper:local:${"a".repeat(64)}`)).toBeTrue();
    expect(binding.subject.matches("beeper:mxid:reversible")).toBeFalse();
  });

  test("derives and hash-binds an undeclared transitive runtime dependency", async () => {
    const [baseline, changed] = await Promise.all([
      beeperClosureProbe(false),
      beeperClosureProbe(true),
    ]);

    expect(baseline.derived).toBeFalse();
    expect(changed.derived).toBeTrue();
    expect(changed.hash).not.toBe(baseline.hash);
  });

  test("never treats legacy linked-device writers as local-CLI readers", () => {
    const binding = providerPluginRegistry.requireRoute("local-cli", "beeper");
    for (const operation of binding.operations) {
      for (const contractVersion of operation.contractVersions) {
        expect(providerPluginRegistry.legacyContractImplementationHashes(
          binding,
          operation.name,
          contractVersion,
        )).toEqual([]);
      }
    }
  });

  test("accounts for the exact pinned 101-command manifest without raw planning", () => {
    const coverage = Object.entries(BEEPER_CLI_COMMAND_COVERAGE);
    expect(coverage).toHaveLength(101);
    expect(new Set(coverage.map(([command]) => command)).size).toBe(101);
    expect(createHash("sha256")
      .update(JSON.stringify(coverage.map(([command]) => command)))
      .digest("hex")).toBe(BEEPER_CLI_COMMAND_LIST_SHA256);
    expect(BEEPER_CLI_COMMAND_COVERAGE["targets status"]).toEqual({
      state: "internal-preflight",
      purpose: "desktop-target-realm-proof",
    });
    expect(BEEPER_CLI_COMMAND_COVERAGE.version).toEqual({
      state: "internal-preflight",
      purpose: "pinned-tool-version-proof",
    });
    const unavailableReasons = new Set(coverage.flatMap(([, value]) =>
      value.state === "unavailable" ? [value.reason] : []));
    expect([...unavailableReasons].sort()).toEqual([
      "account-lifecycle-r4",
      "authentication-and-verification",
      "caller-path-media-or-export",
      "cli-extension-or-configuration",
      "cli-maintenance-or-documentation",
      "destructive-message-deletion-r4",
      "installation-lifecycle",
      "raw-api-or-rpc",
      "target-lifecycle",
      "unbounded-event-stream",
    ]);
  });
});
