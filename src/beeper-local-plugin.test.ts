import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import beeperManifest from "./assets/adapters/beeper/wrench-web-adapter.json";
import archivedBeeperManifestV20 from "./assets/adapters/beeper/wrench-web-adapter.v2.0.0.json";
import archivedBeeperManifestV21 from "./assets/adapters/beeper/wrench-web-adapter.v2.1.0.json";
import archivedBeeperManifestV22 from "./assets/adapters/beeper/wrench-web-adapter.v2.2.0.json";
import { canonicalJson } from "./canonical-json";
import { reviewedBuiltInContractIdentity } from "./provider-plugin-contract-identity";
import { providerPluginRegistry } from "./provider-plugins";
import {
  BEEPER_CLI_COMMAND_COVERAGE,
  BEEPER_CLI_COMMAND_LIST_SHA256,
  BEEPER_CLI_PIN,
  BEEPER_CLI_V062_CLASSIFICATION_SHA256,
  BEEPER_CLI_V062_PUBLIC_MANUAL_SEMANTIC_PROFILE_SHA256,
  BEEPER_CLI_V062_SEMANTIC_PROFILES_SHA256,
  BEEPER_CLI_V062_SOURCE_ONLY_COMPLETE_SEMANTIC_PROFILE_SHA256,
  BEEPER_CLI_V062_SURFACE_CONTRACT,
  BEEPER_CLI_V062_UPSTREAM_SURFACE_SHA256,
  BEEPER_CLI_V062_WHOLE_SURFACE_SHA256,
  BEEPER_DESKTOP_API_PIN,
  BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS,
  BEEPER_LOCAL_OPERATION_INPUT_TYPES,
  BEEPER_LOCAL_OPERATION_NAMES,
  BEEPER_LOCAL_OPERATIONS,
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
    expect(plugin?.version).toBe("2.3.0");
    expect(beeperManifest.schemaVersion).toBe(6);
    expect(beeperManifest.version).toBe("2.3.0");
    expect([
      archivedBeeperManifestV20.version,
      archivedBeeperManifestV21.version,
      archivedBeeperManifestV22.version,
    ]).toEqual(["2.0.0", "2.1.0", "2.2.0"]);
    const archivedHashes = Object.fromEntries(["2.0.0", "2.1.0", "2.2.0"].map(
      (version) => [version, createHash("sha256").update(readFileSync(
        join(
          import.meta.dir,
          "assets",
          "adapters",
          "beeper",
          `wrench-web-adapter.v${version}.json`,
        ),
      )).digest("hex")],
    ));
    expect(archivedHashes).toEqual({
      "2.0.0": "917c54d5f4ee0ef144acaca12a1db40de14e45d4daf5603b67fa6888cb486229",
      "2.1.0": "286e74520548e06c0b0fcd9bf98d96fe5d85863023c9051d7ad3e9936564e99f",
      "2.2.0": "243fcf3e841507ef944d994ff222ba8dfa0287a06094c0b278a29e4fca3e7ec3",
    });
    const canonicalDefinitionByCoordinate = new Map<string, string>();
    for (const manifest of [
      archivedBeeperManifestV20,
      archivedBeeperManifestV21,
      archivedBeeperManifestV22,
      beeperManifest,
    ]) {
      for (const definition of Object.values(manifest.operations)) {
        const coordinate = [
          definition.localCli.surface,
          `${definition.localCli.action}@${String(definition.localCli.contractVersion)}`,
        ].join("/");
        const canonicalDefinition = canonicalJson(definition);
        const prior = canonicalDefinitionByCoordinate.get(coordinate);
        if (prior === undefined) {
          canonicalDefinitionByCoordinate.set(coordinate, canonicalDefinition);
        } else {
          expect(canonicalDefinition, coordinate).toBe(prior);
        }
      }
    }
    expect(Object.keys(beeperManifest.operations).sort()).toEqual(
      [...BEEPER_LOCAL_OPERATION_NAMES].sort(),
    );
    const selectedCoordinates = Object.fromEntries(Object.entries(
      beeperManifest.operations,
    ).map(([operation, definition]) => [
      operation,
      definition.localCli.contractVersion,
    ]));
    expect(selectedCoordinates).toEqual(BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS);
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
    for (const [operation, contractVersion] of Object.entries(
      BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS,
    )) {
      expect(providerPluginRegistry.resolveOperation(
        "local-cli",
        "beeper",
        operation,
        contractVersion,
      ), `${operation}@${String(contractVersion)}`).toBeDefined();
    }
    const versionOne = binding.operations.filter((operation) =>
      operation.contractVersion === 1);
    const versionTwo = binding.operations.filter((operation) =>
      operation.contractVersion === 2);
    const versionThree = binding.operations.filter((operation) =>
      operation.contractVersion === 3);
    expect(versionOne.map((operation) => operation.name).sort()).toEqual(
      [...BEEPER_LOCAL_OPERATION_NAMES].sort(),
    );
    expect(versionTwo.map((operation) => operation.name).sort()).toEqual([
      "accounts.list",
      "bridges.list",
      "contacts.list",
      "conversations.read",
      "messaging.content.search",
      "messaging.read",
      "messaging.search",
    ]);
    expect(versionThree.map((operation) => operation.name)).toEqual(["messaging.read"]);
    expect(binding.operations).toHaveLength(40);
    for (const operation of binding.operations) {
      expect(operation.historicalContractVersions).toBeUndefined();
    }
    expect(binding.operations.find((operation) =>
      operation.name === "messaging.list" && operation.contractVersion === 1)?.omni)
      .toMatchObject({ materializerId: "beeper-messaging-list", materializerVersion: 2 });
    const readOmniByContractVersion = new Map(
      binding.operations
        .filter((operation) => operation.name === "messaging.read")
        .map((operation) => [operation.contractVersion, operation.omni] as const),
    );
    expect([...readOmniByContractVersion].map(([contractVersion, omni]) => ({
      contractVersion,
      materializerId: omni?.state === "supported" ? omni.materializerId : undefined,
      materializerVersion: omni?.state === "supported"
        ? omni.materializerVersion
        : undefined,
    }))).toEqual([
      { contractVersion: 1, materializerId: "beeper-messaging-read", materializerVersion: 2 },
      { contractVersion: 2, materializerId: "beeper-messaging-read", materializerVersion: 2 },
      { contractVersion: 3, materializerId: "beeper-messaging-read", materializerVersion: 5 },
    ]);
    const readOmniV1 = readOmniByContractVersion.get(1);
    const readOmniV2 = readOmniByContractVersion.get(2);
    const readOmniV3 = readOmniByContractVersion.get(3);
    if (
      readOmniV1?.state !== "supported"
      || readOmniV2?.state !== "supported"
      || readOmniV3?.state !== "supported"
    ) throw new Error("Beeper read contracts must install exact Omni materializers");
    expect(readOmniV1.materialize).not.toBe(readOmniV2.materialize);
    expect(readOmniV2.materialize).not.toBe(readOmniV3.materialize);
    expect(readOmniV1.materialize).not.toBe(readOmniV3.materialize);
    expect(binding.operations.filter((operation) => operation.risk === "R1")).toHaveLength(22);
    expect(binding.operations.every((operation) => operation.state === "observed")).toBeTrue();
    for (const operationName of [
      "accounts.list",
      "messaging.search",
      "conversations.read",
      "messaging.read",
    ] as const) {
      expect(beeperManifest.operations[operationName].localCli.contractVersion)
        .toBe(operationName === "messaging.read" ? 3 : 2);
      const cli = versionOne.find((operation) => operation.name === operationName);
      const direct = versionTwo.find((operation) => operation.name === operationName);
      expect(direct?.input).toEqual(cli?.input);
      expect(cli?.implementation).toContain("official Beeper CLI 0.6.2");
      expect(direct?.implementation).toContain("fixed Beeper Desktop loopback read");
      expect(direct?.implementation).toContain("no CLI or transport fallback");
      if (operationName === "messaging.read") {
        const directOmni = direct?.omni;
        const cliOmni = cli?.omni;
        expect(directOmni).toMatchObject({
          materializerId: "beeper-messaging-read",
          materializerVersion: 2,
        });
        if (directOmni?.state !== "supported" || cliOmni?.state !== "supported") {
          throw new Error("Beeper message read routes must install exact Omni materializers");
        }
        expect(directOmni.materialize).not.toBe(cliOmni.materialize);
      } else {
        expect(direct?.omni).toEqual(cli?.omni);
      }
    }
    const directMessageRead = versionTwo.find((operation) =>
      operation.name === "messaging.read");
    const senderMessageRead = versionThree.find((operation) =>
      operation.name === "messaging.read");
    expect(directMessageRead?.input.properties.sender).toBeUndefined();
    expect(senderMessageRead?.input.properties.sender).toBeDefined();
    expect(beeperManifest.operations["messaging.read"].input.properties.before_cursor?.description)
      .toContain("provider cursor returned by a prior page");
    expect(beeperManifest.operations["messaging.read"].input.properties.after_cursor?.description)
      .toContain("provider cursor returned by a prior page");
    expect(beeperManifest.operations["messaging.read"].input.properties.after_cursor?.description)
      .toBe(beeperManifest.operations["messaging.read"].input.properties.before_cursor?.description);
    expect(senderMessageRead?.implementation).toContain("fixed Beeper Desktop loopback read");
    expect(senderMessageRead?.implementation).toContain("no CLI or transport fallback");
    const cliMessageSearch = versionOne.find((operation) =>
      operation.name === "messaging.content.search");
    const directMessageSearch = versionTwo.find((operation) =>
      operation.name === "messaging.content.search");
    expect(beeperManifest.operations["messaging.content.search"].localCli.contractVersion)
      .toBe(2);
    expect(cliMessageSearch?.input.properties.before_cursor).toBeUndefined();
    expect(cliMessageSearch?.input.properties.after_cursor).toBeUndefined();
    expect(directMessageSearch?.input.properties.before_cursor).toBeDefined();
    expect(directMessageSearch?.input.properties.after_cursor).toBeDefined();
    expect(directMessageSearch?.implementation)
      .toContain("fixed Beeper Desktop loopback read");
    for (const operationName of ["bridges.list", "contacts.list"] as const) {
      expect(beeperManifest.operations[operationName].localCli.contractVersion).toBe(2);
      const v1 = versionOne.find((operation) => operation.name === operationName);
      const v2 = versionTwo.find((operation) => operation.name === operationName);
      expect(v1?.implementation).toContain("official Beeper CLI 0.6.2");
      expect(v2?.implementation).toContain("official Beeper CLI 0.6.2");
      expect(v2?.implementation).not.toContain("Desktop loopback read");
    }
    expect((versionOne.find((operation) => operation.name === "bridges.list")
      ?.input.properties.provider as { readonly enum?: readonly string[] } | undefined)?.enum)
      .toEqual(["local", "cloud", "self-hosted"]);
    expect((versionTwo.find((operation) => operation.name === "bridges.list")
      ?.input.properties.provider as { readonly enum?: readonly string[] } | undefined)?.enum)
      .toEqual([
        "local", "cloud", "self-hosted", "platform-sdk",
      ]);
    expect(versionOne.find((operation) => operation.name === "contacts.list")
      ?.input.properties.query).toBeUndefined();
    expect(versionTwo.find((operation) => operation.name === "contacts.list")
      ?.input.properties.query).toBeDefined();
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
    const adapterSha256 = createHash("sha256")
      .update(readFileSync(
        join(import.meta.dir, "assets", "adapters", "beeper", "wrench-web-adapter.json"),
      ))
      .digest("hex");
    const derivedContractIdentity = createHash("sha256")
      .update(JSON.stringify({
        format: "wrench.reviewed-built-in-contract-identity",
        schemaVersion: 1,
        pluginId: "beeper-linked-device",
        pluginVersion: "2.3.0",
        adapterId: "beeper-local",
        adapterVersion: "2.3.0",
        adapterSha256,
        localCliSurfaceSha256: BEEPER_CLI_V062_WHOLE_SURFACE_SHA256,
        implementationClosureSha256: baseline.hash,
      }))
      .digest("hex");
    expect(reviewedBuiltInContractIdentity(
      "beeper-linked-device",
      "2.3.0",
    ).implementationSha256).toBe(derivedContractIdentity);
    expect(derivedContractIdentity).not.toBe(BEEPER_CLI_V062_WHOLE_SURFACE_SHA256);
  });

  test("route-scopes the exact 2.0 writer identity to only 29 unchanged @1 contracts", () => {
    const binding = providerPluginRegistry.requireRoute("local-cli", "beeper");
    const predecessorChanged = new Set([
      "bridges.list",
      "contacts.list",
      "messaging.read",
    ]);
    const unchanged = BEEPER_LOCAL_OPERATION_NAMES.filter((operation) =>
      !predecessorChanged.has(operation));
    expect(unchanged).toHaveLength(29);
    const directV2 = new Set([
      "accounts.list",
      "messaging.search",
      "conversations.read",
      "messaging.read",
      "messaging.content.search",
    ]);
    for (const operation of binding.operations) {
      const legacy = providerPluginRegistry.legacyContractImplementationHashes(
        binding,
        operation.name,
        operation.contractVersion,
      ).map((value) => value.toString("hex"));
      const expected = operation.contractVersion === 1
        ? [
            "e6d49d29ece94d3c9eb1817ea194699bbe56ecb1170e3691e0242e16ef2c26eb",
            "89a51cc1e082b15ff89dd4e85e48e218653ca4bf7e49b5bbc824e5381bad86e1",
            "1f5ed0abd4eaaef92e0d035452273e8a081f564da827897547b6e65939974a60",
            ...(predecessorChanged.has(operation.name)
              ? []
              : ["6b166b3cd61866e1af17d1d0fd2e63b78500f9e49255a03d89ca11ed6406ec92"]),
          ]
        : operation.contractVersion === 2 && directV2.has(operation.name)
          ? ["e6d49d29ece94d3c9eb1817ea194699bbe56ecb1170e3691e0242e16ef2c26eb"]
          : [];
      expect(legacy, `${operation.name}@${String(operation.contractVersion)}`)
        .toEqual(expected);
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

  test("binds exact v0.6.2 release, source anomaly, SDK, generated, and dynamic provenance", () => {
    const surface = BEEPER_CLI_V062_SURFACE_CONTRACT;
    expect(surface.commands).toHaveLength(102);
    expect(surface.commands.filter((command) => command.publicManual)).toHaveLength(101);
    expect(surface.commands.filter((command) => command.generatedCanonical)).toHaveLength(100);
    expect(surface.additionalEntries.filter((entry) => entry.provenance === "built-in-alias"))
      .toHaveLength(6);
    expect(surface.source).toEqual({
      package: "@beeper/cli",
      packagePath: "packages/cli/package.json",
      packageDeclaredVersion: "0.6.1",
      versionDiscrepancy: expect.stringContaining("executable runtime identity remains authoritative"),
      generatedManualSha256: "18a11300ae7fe321ace0c9c5bbdfd062f114c91add7d64e256b78c2e89e328a9",
      generatedManualIncludesFlagsAndDefaults: false,
      generatedManualEntries: 101,
      generatedCanonicalEntries: 101,
      registeredKeys: 107,
    });
    expect(surface.executable).toMatchObject({
      releaseVersion: "0.6.2",
      releaseDate: "2026-05-18",
      releaseTag: "v0.6.2",
      releaseCommit: "a416af06023449a87312dc11e54643fd9dc94b8c",
      runtimeReportedName: "@beeper/cli",
      runtimeReportedVersion: "0.6.2",
    });
    expect(surface.executable.runtimeReportedVersion)
      .not.toBe(surface.source.packageDeclaredVersion);
    expect(surface.executable.artifacts).toHaveLength(4);
    expect(surface.sdk).toEqual(BEEPER_DESKTOP_API_PIN);
    expect(surface.runtime).toMatchObject({
      providerPluginVersion: "2.3.0",
      adapterVersion: "2.3.0",
      operationContractVersions: BEEPER_LOCAL_OPERATION_CONTRACT_VERSIONS,
      operationInputTypes: BEEPER_LOCAL_OPERATION_INPUT_TYPES,
    });
    expect(Object.keys(surface.runtime.operationContractVersions)).toEqual(
      [...BEEPER_LOCAL_OPERATION_NAMES].sort(),
    );
    expect(Object.entries(surface.runtime.operationContractVersions).filter(([, version]) =>
      version === 2).map(([operation]) => operation)).toEqual([
        "accounts.list", "bridges.list", "contacts.list", "conversations.read",
        "messaging.content.search", "messaging.search",
      ]);
    expect(Object.entries(surface.runtime.operationContractVersions).filter(([, version]) =>
      version === 3).map(([operation]) => operation)).toEqual(["messaging.read"]);
    expect(surface.digests.classificationSha256)
      .toBe(BEEPER_CLI_V062_CLASSIFICATION_SHA256);
    expect(surface.digests.semanticProfilesSha256)
      .toBe(BEEPER_CLI_V062_SEMANTIC_PROFILES_SHA256);
    expect(surface.digests.upstreamSurfaceSha256)
      .toBe(BEEPER_CLI_V062_UPSTREAM_SURFACE_SHA256);
    expect(surface.digests.wholeSurfaceSha256)
      .toBe(BEEPER_CLI_V062_WHOLE_SURFACE_SHA256);
    expect(reviewedBuiltInContractIdentity("beeper-linked-device", "2.3.0").implementationSha256)
      .not.toBe(BEEPER_CLI_V062_WHOLE_SURFACE_SHA256);

    const publicManualSemanticProfiles = Object.fromEntries(surface.commands
      .filter((command) => command.publicManual)
      .map((command) => [command.path.join(" "), command.semanticProfileSha256]));
    expect(Object.keys(publicManualSemanticProfiles)).toHaveLength(101);
    expect(publicManualSemanticProfiles)
      .toEqual(BEEPER_CLI_V062_PUBLIC_MANUAL_SEMANTIC_PROFILE_SHA256);
    expect(surface.commands.find((command) => command.path.join(" ") === "_complete")
      ?.semanticProfileSha256)
      .toBe(BEEPER_CLI_V062_SOURCE_ONLY_COMPLETE_SEMANTIC_PROFILE_SHA256);

    const additional = new Map(surface.additionalEntries.map((entry) => [
      entry.path.join(" "),
      entry,
    ]));
    expect(additional.get("autocomplete")).toMatchObject({
      provenance: "built-in-hidden",
      registered: true,
      publicManual: false,
    });
    expect(surface.commands.find((command) => command.path.join(" ") === "_complete")).toMatchObject({
      provenance: "source-only-private",
      registered: false,
    });
    expect(additional.get("help")).toMatchObject({
      provenance: "built-in-hidden",
      registered: true,
    });
    for (const path of [
      "plugins inspect",
      "plugins install",
      "plugins add",
      "plugins link",
      "plugins reset",
      "plugins uninstall",
      "plugins unlink",
      "plugins remove",
      "plugins update",
      "<dynamic-plugin-command>",
    ]) expect(additional.get(path)?.provenance).toBe("dynamic-plugin");
    expect(additional.get("messages react")?.provenance).toBe("documented-only");
    expect(additional.get("messages unreact")?.provenance).toBe("documented-only");
  });

  test("maps every manual command, flag, and default to an exact semantic disposition", () => {
    const commands = new Map(BEEPER_CLI_V062_SURFACE_CONTRACT.commands.map((command) => [
      command.path.join(" "),
      command,
    ]));
    for (const [path, legacy] of Object.entries(BEEPER_CLI_COMMAND_COVERAGE)) {
      const command = commands.get(path);
      expect(command, path).toBeDefined();
      if (command === undefined) continue;
      expect(command.decision.rationale.length, path).toBeGreaterThan(0);
      if (legacy.state === "supported") {
        expect(command.decision, path).toMatchObject({
          disposition: "supported",
          operation: legacy.operation,
        });
      } else if (path === "accounts add" || path === "accounts remove" || path === "messages delete") {
        expect(command.decision.disposition, path).toBe("R4");
      } else if (path === "accounts use") {
        expect(command.decision, path).toMatchObject({
          disposition: "absorbed",
          replacement: "Explicit account_id",
        });
      } else if (path === "export" || legacy.state === "internal-preflight") {
        expect(command.decision.disposition, path).toBe("internal");
      } else {
        expect(command.decision.disposition, path).toBe("unsupported");
      }
      for (const item of [...command.arguments, ...command.flags]) {
        expect(item.decision.rationale.length, `${path} ${item.name}`).toBeGreaterThan(0);
      }
    }

    const publicDispositionCounts = Object.fromEntries(
      ["supported", "internal", "R4", "absorbed", "unsupported"].map((disposition) => [
        disposition,
        [...commands.values()].filter((command) =>
          command.publicManual && command.decision.disposition === disposition).length,
      ]),
    );
    expect(publicDispositionCounts).toEqual({
      supported: 41,
      internal: 3,
      R4: 3,
      absorbed: 1,
      unsupported: 53,
    });
    expect(commands.get("targets status")?.decision.disposition).toBe("internal");
    expect(commands.get("version")?.decision.disposition).toBe("internal");
    expect(commands.get("export")?.decision.disposition).toBe("internal");
    expect(commands.get("status")?.decision.disposition).toBe("unsupported");

    const messages = commands.get("messages list")!;
    expect(messages.flags.map((flag) => flag.name)).toEqual([
      "--after-cursor", "--asc", "--before-cursor", "--chat", "--ids",
      "--limit", "--pick", "--sender",
    ]);
    expect(messages.flags.find((flag) => flag.name === "--asc")).toMatchObject({
      valueType: "boolean",
      default: { kind: "literal", value: false },
      decision: { disposition: "absorbed" },
    });
    expect(messages.flags.find((flag) => flag.name === "--pick")?.valueType).toBe("number");
    expect(messages.flags.find((flag) => flag.name === "--sender")?.decision)
      .toMatchObject({ disposition: "supported", operation: "messaging.read" });
    expect(commands.get("contacts list")?.flags.find((flag) => flag.name === "--query")?.decision)
      .toMatchObject({ disposition: "supported", operation: "contacts.list" });
    expect(commands.get("bridges list")?.flags.find((flag) => flag.name === "--provider"))
      .toMatchObject({ enum: ["local", "cloud", "self-hosted"] });
    expect(commands.get("messages search")?.flags.find((flag) =>
      flag.name === "--exclude-low-priority")).toMatchObject({
        default: { kind: "literal", value: true, authority: "sdk-openapi" },
        decision: { disposition: "supported", rationale: expect.stringContaining("OpenAPI") },
      });
    expect(commands.get("messages search")?.flags.find((flag) =>
      flag.name === "--include-muted")).toMatchObject({
        allowNo: true,
        default: { kind: "literal", value: true, authority: "tagged-source" },
      });
    expect(BEEPER_CLI_V062_SURFACE_CONTRACT.globalFlags.map((flag) => [
      flag.name, flag.aliases,
    ])).toEqual([
      ["--base-url", []], ["--target", ["-t"]], ["--debug", []],
      ["--events", []], ["--full", []], ["--json", []], ["--quiet", ["-q"]],
      ["--read-only", []], ["--timeout", []], ["--yes", ["-y"]],
    ]);
    expect(BEEPER_CLI_V062_SURFACE_CONTRACT.globalFlags.find((flag) =>
      flag.name === "--timeout")?.default).toEqual({ kind: "none" });
    expect(commands.get("accounts add")?.flags.find((flag) => flag.name === "--guided"))
      .toMatchObject({ allowNo: true, default: { kind: "literal", value: true } });
    for (const path of ["send text", "send file", "send sticker", "send voice"]) {
      expect(commands.get(path)?.flags.find((flag) => flag.name === "--wait")?.decision)
        .toMatchObject({ disposition: "replaced", replacement: expect.stringContaining("messaging.delivery.await") });
    }
    expect(commands.get("messages delete")?.decision).toMatchObject({
      disposition: "R4",
      rationale: expect.stringContaining("success/void"),
    });
    const tunnel = commands.get("targets tunnel")!;
    expect(tunnel).toMatchObject({
      provenance: "jit-plugin",
      package: "@beeper/cli-plugin-cloudflare",
      version: "^0.6.0",
      registered: false,
      reviewedEffect: "write",
    });
    expect(tunnel.arguments).toMatchObject([{ name: "name", required: false }]);
    expect(tunnel.flags.map((flag) => [flag.name, flag.valueType, flag.default])).toEqual([
      ["--install", "boolean", { kind: "literal", value: false, authority: "jit-plugin-source" }],
      ["--cloudflared-path", "string", { kind: "none" }],
      ["--retries", "number", { kind: "literal", value: 5, authority: "jit-plugin-source" }],
      ["--url-only", "boolean", { kind: "literal", value: false, authority: "jit-plugin-source" }],
    ]);
    expect(commands.get("media download")?.arguments[0]?.name).toBe("url");
    expect(commands.get("accounts add")?.flags.find((flag) => flag.name === "--guided")?.default)
      .toEqual({ kind: "literal", value: true, authority: "tagged-source" });
    expect(commands.get("api request")?.arguments[0]?.enum).toEqual([
      "GET", "POST", "PUT", "PATCH", "DELETE",
    ]);
    expect(commands.get("config get")?.arguments[0]?.enum).toEqual([
      "baseURL", "auth", "defaultTarget", "defaultAccount",
    ]);
    expect(commands.get("config set")?.arguments[0]?.enum).toEqual([
      "defaultTarget", "defaultAccount",
    ]);
    expect(commands.get("_complete")?.arguments[0]?.enum).toEqual([
      "chat", "account", "contact", "target",
    ]);
    const internalExport = commands.get("export")!;
    expect(internalExport.output).toMatchObject({
      completeness: "internal",
      privateArtifact: true,
      maxBytes: 4 * 1024 * 1024 * 1024,
    });
    expect(Object.fromEntries(internalExport.flags.map((flag) => [
      flag.name, flag.decision,
    ]))).toMatchObject({
      "--force": { disposition: "fixed", fixedValue: false },
      "--no-attachments": { disposition: "fixed", fixedValue: true },
      "--out": { disposition: "fixed", fixedValue: "wrench-owned-private-export-root" },
      "--quiet": { disposition: "fixed", fixedValue: true },
      "--limit-chats": { disposition: "absorbed" },
      "--limit-messages": { disposition: "absorbed" },
      "--max-participants": { disposition: "absorbed" },
    });
  });

  test("separates upstream mutation reporting from reviewed effects and Wrench authority", () => {
    const commands = BEEPER_CLI_V062_SURFACE_CONTRACT.commands;
    for (const command of commands) {
      if (command.upstreamReportedMutates === true) {
        expect(command.reviewedEffect, command.path.join(" ")).not.toBe("read");
      }
      if (
        command.reviewedEffect !== "read"
        && command.decision.disposition === "supported"
        && command.decision.operation !== null
      ) {
        expect(BEEPER_LOCAL_OPERATIONS[command.decision.operation as keyof typeof BEEPER_LOCAL_OPERATIONS].effect)
          .toBe("write");
      }
    }
    const byPath = new Map(commands.map((command) => [command.path.join(" "), command]));
    expect(byPath.get("presence")).toMatchObject({
      upstreamReportedMutates: false,
      reviewedEffect: "write",
      decision: { operation: "presence.set" },
    });
    expect(byPath.get("docs")?.reviewedEffect).toBe("read");
    expect(byPath.get("api post")?.reviewedEffect).toBe("write");
    expect(byPath.get("api request")?.reviewedEffect).toBe("input-dependent");
    expect(byPath.get("media download")?.reviewedEffect).toBe("input-dependent");
    expect(byPath.get("messages export")?.reviewedEffect).toBe("input-dependent");
    const supportedWrites = commands.filter((command) =>
      command.decision.operation !== null
      && BEEPER_LOCAL_OPERATIONS[command.decision.operation as keyof typeof BEEPER_LOCAL_OPERATIONS].effect === "write");
    expect(supportedWrites.filter((command) => command.upstreamReportedMutates)).toHaveLength(26);
    expect(supportedWrites.filter((command) => !command.upstreamReportedMutates)
      .map((command) => command.path.join(" "))).toEqual(["presence"]);
    const exactWrites = [
      "messaging.send", "reactions.set", "messaging.edit", "conversations.start",
      "conversations.archive.set", "conversations.pin.set", "conversations.mute.set",
      "conversations.read-state.set", "conversations.priority.set", "conversations.notify",
      "conversations.title.set", "conversations.description.set", "conversations.avatar.set",
      "conversations.draft.set", "conversations.disappearing.set", "conversations.reminder.set",
      "conversations.focus", "presence.set",
    ] as const;
    const declaredWrites = BEEPER_LOCAL_OPERATION_NAMES.filter((operation) =>
      BEEPER_LOCAL_OPERATIONS[operation].effect === "write");
    const mappedWrites = supportedWrites.map((command) => command.decision.operation!);
    expect(declaredWrites).toHaveLength(18);
    expect(new Set(declaredWrites)).toEqual(new Set(exactWrites));
    expect(new Set(mappedWrites)).toEqual(new Set(declaredWrites));
    for (const operation of declaredWrites) {
      expect(mappedWrites.includes(operation), operation).toBeTrue();
    }
  });

  test("declares exact conditional-input and input-dependent reconciliation laws", () => {
    const byPath = new Map(BEEPER_CLI_V062_SURFACE_CONTRACT.commands.map((command) => [
      command.path.join(" "), command,
    ]));
    expect(byPath.get("chats avatar")?.reconciliation).toMatchObject({
      availability: "input-dependent",
      namespace: "semantic-operation",
      predicate: { op: "not", predicate: { op: "present", field: "avatar" } },
    });
    expect(byPath.get("chats draft")?.reconciliation).toMatchObject({
      availability: "input-dependent",
      namespace: "semantic-operation",
      predicate: { op: "not", predicate: { op: "present", field: "attachment" } },
    });
    for (const path of ["chats mark-read", "chats mark-unread"]) {
      expect(byPath.get(path)?.reconciliation).toMatchObject({
        availability: "input-dependent",
        namespace: "semantic-operation",
        predicate: { op: "not", predicate: { op: "present", field: "message_id" } },
      });
    }
    for (const path of ["chats notify-anyway", "chats focus", "presence"]) {
      expect(byPath.get(path)?.reconciliation.availability).toBe("none");
    }
    expect(byPath.get("chats description")?.conditionalInputs).toMatchObject([{
      namespace: "semantic-operation",
      when: { op: "eq", field: "clear", value: true },
      forbid: ["description"],
    }, {
      when: { op: "eq", field: "clear", value: false },
      require: ["description"],
    }]);
    expect(byPath.get("chats avatar")?.conditionalInputs).toMatchObject([{
      when: { op: "eq", field: "clear", value: true },
      forbid: ["avatar"],
    }, {
      when: { op: "eq", field: "clear", value: false },
      require: ["avatar"],
    }]);
    expect(byPath.get("chats draft")?.conditionalInputs[1]).toMatchObject({
      require: ["text"],
      requireAny: [],
    });
    expect(byPath.get("messages search")?.conditionalInputs[0]?.requireAny).toEqual([
      "query", "account_id", "conversation_id", "chat_type", "after", "before", "media", "sender",
    ]);
  });
});
