import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

const predecessorDefaultInventorySha256 =
  "83d6b42f7e3b239e231bda2bae42598344878a4db68a8eb599e2fb2281f092fc";
const predecessorLegacyInventorySha256 = [
  "a05af2ab437e6be673751772b7c05b760d7e20ec59ea19b9f472abbcd6e0f63b",
  "8c22749bf89775d544889ae42ce82f949fe23b5b4b125726c7979d2a83928f21",
  "9fd678ea50981a097e95e84c0367d26e96731c36e0abb921f59294116a6ffcec",
  "472c1ddcbc24a242a3e7d16cffcab928203d6266f4ad1cd4ac2eb20d7f36b9b3",
  "41762fae84335551671ca1ad0e65ea05fca26b21887a4c6c4d1192d34600855a",
  "8ff7a9394daffc6377335b219976a97e7cbd476178d955f7523a8f77e5e04626",
  "f0a2cb0919313de2b837062ea0075556a628eaa0701532774d7683b99aa68802",
  "960c43b683e98d1a04a43e9bfd4f9d154aee9de79c62623d0db17fe74e9353eb",
  "970e31a5a0ab0f93a267b5859683cabaea58b2a73cfb7bfddf1a132aaa5d8070",
  "dfa6917ce22b65bee2a7faa31db7e33d9a07da6882f8247cf7a0657bde673400",
  "7dd48dd60e8c9b5e2c609409bf33d0e8ebbc62d8c2c500d7ea25c83bbfbbc48e",
  "9fbec27b0fc78e6881092336d5c18501125c9c9cd7c123d8258ac99bb374f217",
  "f9f0feaf7f6bd5a11df12421e7517e44365238ba1508faa707ab24f60bc2558f",
  "ced281b781c1f73af8315245a68dfb5ea9fee9f737671e18fe1cd3ee5015ed20",
  "25bb7f467fd40e044764c82de8be108405ec66e275a5c02d0682bd1ee058b4f8",
  "5e0b6f9d4265074dee0b125772f39ac8457bb4b5db703dee1e4457d30828fef0",
];

const moduleUrl = (name: string) => pathToFileURL(
  join(import.meta.dir, name),
).href;

const inventoryProgram = `
import { createHash } from "node:crypto";
const [{ createProviderPluginRegistry }, { generatedProviderPlugins }, providerContracts, webContracts] = await Promise.all([
  import(${JSON.stringify(moduleUrl("provider-plugin-registry.ts"))}),
  import(${JSON.stringify(moduleUrl("provider-plugins.generated.ts"))}),
  import(${JSON.stringify(moduleUrl("provider-contracts.ts"))}),
  import(${JSON.stringify(moduleUrl("web-session-contracts.ts"))}),
]);
const registry = createProviderPluginRegistry(generatedProviderPlugins);
const rows = [];
const currentOnlyRows = [];
const legacyRows = [];
let acceptedLegacy = true;
let rejectedUnknown = true;
function stableJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const record = value;
  return "{" + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ":" + stableJson(record[key])).join(",") + "}";
}
function predecessorWebContract(contract) {
  if (contract.site !== "facebook-marketplace"
    || contract.operation !== "feeds.read"
    || (contract.contractVersion !== 1 && contract.contractVersion !== 2)) return contract;
  const project = (value) => {
    if (value === "wrench-issued authenticated cursor returned by a complete prior Marketplace page; one chain supports at most 48 provider pages") {
      return "oh-issued authenticated cursor returned by a complete prior Marketplace page; one chain supports at most 48 provider pages";
    }
    if (Array.isArray(value)) return value.map(project);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, project(entry)]));
  };
  return project(contract);
}
function legacyHash(contract, implementationHash, web) {
  return createHash("sha256")
    .update(stableJson(web ? predecessorWebContract(contract) : contract))
    .update("\\0")
    .update(implementationHash)
    .digest("hex");
}
function appendCurrentRow(row) {
  if (row[0] === "provider-api" && row[1] === "gmail") {
    currentOnlyRows.push(row);
    return;
  }
  rows.push(row);
}
for (const plugin of registry.list()) {
  for (const binding of plugin.bindings) {
    for (const operation of binding.operations) {
        for (const contractVersion of operation.contractVersions) {
          const legacyImplementations = registry.legacyContractImplementationHashes(binding);
          if (binding.transport === "provider-api") {
          const contract = providerContracts.getProviderContract({
            provider: binding.surfaceId,
            action: operation.name,
            contractVersion,
            timeoutMs: 30_000,
            maxOutputBytes: 1024 * 1024,
          }, registry);
          appendCurrentRow([binding.transport, binding.surfaceId, operation.name, contractVersion,
            providerContracts.providerContractHash(contract, registry)]);
          legacyImplementations.forEach((implementationHash, index) => {
            const hash = legacyHash(contract, implementationHash, false);
            legacyRows[index] ??= [];
            legacyRows[index].push([binding.transport, binding.surfaceId, operation.name, contractVersion, hash]);
            acceptedLegacy &&= providerContracts.isCompatibleProviderContractHash(contract, hash, registry);
          });
          rejectedUnknown &&= !providerContracts.isCompatibleProviderContractHash(
            contract, "f".repeat(64), registry,
          );
        } else {
          const contract = webContracts.getWebSessionContract({
            site: binding.surfaceId,
            action: operation.name,
            contractVersion,
            timeoutMs: 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
          }, registry);
          appendCurrentRow([binding.transport, binding.surfaceId, operation.name, contractVersion,
            webContracts.webSessionContractHash(contract, registry)]);
          legacyImplementations.forEach((implementationHash, index) => {
            const hash = legacyHash(contract, implementationHash, true);
            legacyRows[index] ??= [];
            legacyRows[index].push([binding.transport, binding.surfaceId, operation.name, contractVersion, hash]);
            acceptedLegacy &&= webContracts.isCompatibleWebSessionContractHash(contract, hash, registry);
          });
          rejectedUnknown &&= !webContracts.isCompatibleWebSessionContractHash(
            contract, "f".repeat(64), registry,
          );
        }
      }
    }
  }
}
const predecessorRouteOrder = [
  ["linked-device", "whatsapp"],
  ["provider-api", "linkedin"],
  ["provider-api", "x"],
  ["web-session-api", "bluesky"],
  ["web-session-api", "facebook-group"],
  ["web-session-api", "facebook-marketplace"],
  ["web-session-api", "facebook-page"],
  ["web-session-api", "facebook"],
  ["web-session-api", "hacker-news"],
  ["web-session-api", "instagram"],
  ["web-session-api", "linkedin"],
  ["web-session-api", "reddit"],
  ["web-session-api", "substack"],
  ["web-session-api", "threads"],
  ["web-session-api", "tiktok"],
  ["web-session-api", "x"],
  ["web-session-api", "youtube"],
].map(([transport, surfaceId]) => transport + "\\0" + surfaceId);
const routeRank = new Map(predecessorRouteOrder.map((route, index) => [route, index]));
rows.sort((left, right) => {
  const leftRank = routeRank.get(left[0] + "\\0" + left[1]);
  const rightRank = routeRank.get(right[0] + "\\0" + right[1]);
  if (leftRank === undefined || rightRank === undefined) {
    throw new Error("provider contract inventory contains an unreviewed route");
  }
  return leftRank - rightRank;
});
for (const legacy of legacyRows) {
  legacy.sort((left, right) => {
    const leftRank = routeRank.get(left[0] + "\\0" + left[1]);
    const rightRank = routeRank.get(right[0] + "\\0" + right[1]);
    if (leftRank === undefined || rightRank === undefined) {
      throw new Error("provider contract legacy inventory contains an unreviewed route");
    }
    return leftRank - rightRank;
  });
}
currentOnlyRows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
process.stdout.write(JSON.stringify({
  rows: rows.length,
  sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  currentOnlyRows: currentOnlyRows.length,
  currentOnlySha256:
    createHash("sha256").update(JSON.stringify(currentOnlyRows)).digest("hex"),
  legacyRows: legacyRows.map((legacy) => legacy.length),
  legacySha256: legacyRows.map((legacy) =>
    createHash("sha256").update(JSON.stringify(legacy)).digest("hex")
  ),
  acceptedLegacy,
  rejectedUnknown,
}));
`;

function inventoryForNodeEnv(nodeEnv: string | undefined): unknown {
  const environment = { ...process.env };
  if (nodeEnv === undefined) delete environment.NODE_ENV;
  else environment.NODE_ENV = nodeEnv;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", inventoryProgram],
    cwd: join(import.meta.dir, ".."),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `contract inventory child failed for NODE_ENV=${nodeEnv ?? "<unset>"}: ${result.stderr.toString()}`,
    );
  }
  return JSON.parse(result.stdout.toString());
}

describe("durable provider contract inventory", () => {
  test("preserves every predecessor writer identity across execution modes", () => {
    for (const nodeEnv of [
      undefined,
      "test",
      "production",
      "development",
      "staging",
    ] as const) {
      expect(inventoryForNodeEnv(nodeEnv)).toEqual({
        rows: 307,
        sha256: predecessorDefaultInventorySha256,
        currentOnlyRows: 4,
        currentOnlySha256: "b68a0e0f8f9be77f46d4ae7a5aa3a75de2ee6e420e8dc588247390bd1600553c",
        legacyRows: [307, 307, 307, 307, 307, 307, 307, 174, 44, 23, 23, 23, 23, 23, 23, 23],
        legacySha256: predecessorLegacyInventorySha256,
        acceptedLegacy: true,
        rejectedUnknown: true,
      });
    }
  });
});
