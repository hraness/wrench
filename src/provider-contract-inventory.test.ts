import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

const predecessorDefaultInventorySha256 =
  "e4f04d2a873aa6b3a70db673f30d8d87955f0df63a9075e5866bd85067d9c4c8";
const predecessorLegacyInventorySha256 = [
  "5be8b3ff9da1e8100f838a44ababc00b77692a65701f8a138d1d83754c232f75",
  "92cae606544b38bed97795688970386f1ea2bbd7cc2c8cd6e1d159c3b27f4c83",
  "da65716a2a006be474c9f4a760c058070dc7a5331008d2ccce4e2e8c5c46fc4f",
  "84c0d4097966ad4d2b6d1e56fe6d0c1cbd393ac77b2194c5b774452b9f9ddbc1",
  "76f16b52415d7c6d4b6b20b61bcd36240db25c790ceb2b42faa8fd5cdaef1cbb",
  "3d24e682510065c5212a6548d3da1ee5c1f5b44d35da20abdc3ab5f9c99127c2",
  "8054163089bf9f02751394f72d8dbd1e53ec11f96f0f4dc3b7013bc26386eee9",
  "808156a720dc6e5055f9eeb37a65fb157e68c20aac668ac684b54e294cfedf63",
  "bcfdd3087c9732ce1f4011117186a6dbc3c7d185db66093e3f584aa884141819",
  "72a2269c3780a6a5171dbc4ee09823e7ddbdd212cb5d4e0f221d47373ab7f3c4",
  "954015a0e5c00dfa8dd51972fec2aa0dd884cf1346d74dcc9abe4b69d8bfd88b",
  "572edee59ca1acae13d68bd545dc14dcf1ee7d5819fa1e5e340f8d35ec1ea0a1",
  "24d0497433ba37860c749b66552e6f02e23a4f2935e84d801875eff20fd544c0",
  "22a3314de80e521127d24f028274592a6c14038c9df0d498043e1b6db5f27d9a",
  "5df01769a47b42db0079844e82e2cf2eae5b1910c72828ffa11f3eaa4923deac",
  "ced281b781c1f73af8315245a68dfb5ea9fee9f737671e18fe1cd3ee5015ed20",
  "25bb7f467fd40e044764c82de8be108405ec66e275a5c02d0682bd1ee058b4f8",
  "5e0b6f9d4265074dee0b125772f39ac8457bb4b5db703dee1e4457d30828fef0",
];

const moduleUrl = (name: string) => pathToFileURL(
  join(import.meta.dir, name),
).href;

const inventoryProgram = `
import { createHash } from "node:crypto";
const [{ createProviderPluginRegistry }, { generatedProviderPlugins }, providerContracts, webContracts, localContracts] = await Promise.all([
  import(${JSON.stringify(moduleUrl("provider-plugin-registry.ts"))}),
  import(${JSON.stringify(moduleUrl("provider-plugins.generated.ts"))}),
  import(${JSON.stringify(moduleUrl("provider-contracts.ts"))}),
  import(${JSON.stringify(moduleUrl("web-session-contracts.ts"))}),
  import(${JSON.stringify(moduleUrl("local-cli-contracts.ts"))}),
]);
const registry = createProviderPluginRegistry(generatedProviderPlugins);
const rows = [];
const currentOnlyRows = [];
const legacyRows = [];
const predecessorRedditWriter = "646a29b320373f50ccdf9ae8b8b60d5147428f0f899a226480c2c5b009294d8a";
const predecessorRedditReaders = [
  "64a4c1e78ce8565a50613f63ff605f0f57f488617ef31386b5ddce5e3db885c9",
  "058987e5eac61505ca53f80d8494fb5505e697e0313e6e197a198649be7c3a3c",
  "05173089ec6d555845fa5fb7b08a70bd0bf810a18882c9ecdd784a437db791c5",
  "dea85e9a5bc2a134ce48769655c2e4df89d68a876012b4af3e08f40526d02512",
  "64a4c1e78ce8565a50613f63ff605f0f57f488617ef31386b5ddce5e3db885c9",
  "058987e5eac61505ca53f80d8494fb5505e697e0313e6e197a198649be7c3a3c",
  "05173089ec6d555845fa5fb7b08a70bd0bf810a18882c9ecdd784a437db791c5",
  "16e4e48609c12d5ffdaf47e622764e06cc9b3381c6b8ceb2c9f773fa9d99bdd9",
  "91cc3364ab1ccba66bd2e099f64fcccc187fde94145a8bf1eaa14f0f5533f6d7",
];
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
function isCurrentOnlyRow(row) {
  return (row[0] === "provider-api" && row[1] === "gmail")
    || (row[0] === "local-cli" && row[1] === "beeper")
    || (row[0] === "local-cli" && row[1] === "imessage")
    || (row[0] === "web-session-api" && row[1] === "clasificados")
    || (row[0] === "web-session-api" && row[1] === "github")
    || (row[0] === "web-session-api" && row[1] === "reddit" && row[2].startsWith("flair."))
    || (row[0] === "web-session-api" && row[1] === "twitch");
}
function appendCurrentRow(row) {
  if (isCurrentOnlyRow(row)) {
    // Routes introduced after the predecessor inventory keep their own
    // reader aliases without rewriting that historical baseline.
    currentOnlyRows.push(row);
    return false;
  }
  rows.push(row);
  return true;
}
for (const plugin of registry.list()) {
  for (const binding of plugin.bindings) {
    for (const operation of binding.operations) {
        for (const contractVersion of operation.contractVersions) {
          const registeredLegacyImplementations = registry.legacyContractImplementationHashes(
            binding,
            operation.name,
            contractVersion,
          );
          const isPredecessorReddit = binding.surfaceId === "reddit" && !operation.name.startsWith("flair.");
          const legacyImplementations = isPredecessorReddit
            ? predecessorRedditReaders.map((hash) => Buffer.from(hash, "hex"))
            : registeredLegacyImplementations;
          if (binding.transport === "provider-api") {
          const contract = providerContracts.getProviderContract({
            provider: binding.surfaceId,
            action: operation.name,
            contractVersion,
            timeoutMs: 30_000,
            maxOutputBytes: 1024 * 1024,
          }, registry);
          const includePredecessorInventory = appendCurrentRow([binding.transport, binding.surfaceId, operation.name, contractVersion,
            providerContracts.providerContractHash(contract, registry)]);
          if (includePredecessorInventory) {
            legacyImplementations.forEach((implementationHash, index) => {
              const hash = legacyHash(contract, implementationHash, false);
              legacyRows[index] ??= [];
              legacyRows[index].push([binding.transport, binding.surfaceId, operation.name, contractVersion, hash]);
              acceptedLegacy &&= providerContracts.isCompatibleProviderContractHash(contract, hash, registry);
            });
          }
          rejectedUnknown &&= !providerContracts.isCompatibleProviderContractHash(
            contract, "f".repeat(64), registry,
          );
        } else if (binding.transport === "local-cli") {
          const contract = localContracts.getLocalCliContract({
            surface: binding.surfaceId,
            action: operation.name,
            contractVersion,
            timeoutMs: 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
          }, registry);
          const includePredecessorInventory = appendCurrentRow([
            binding.transport,
            binding.surfaceId,
            operation.name,
            contractVersion,
            localContracts.localCliContractHash(contract, registry),
            contract.tool,
          ]);
          if (includePredecessorInventory) {
            throw new Error("local CLI route unexpectedly entered predecessor inventory");
          }
          rejectedUnknown &&= !localContracts.isCompatibleLocalCliContractHash(
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
          const currentHash = isPredecessorReddit
            ? legacyHash(contract, Buffer.from(predecessorRedditWriter, "hex"), true)
            : webContracts.webSessionContractHash(contract, registry);
          acceptedLegacy &&= webContracts.isCompatibleWebSessionContractHash(contract, currentHash, registry);
          const includePredecessorInventory = appendCurrentRow([binding.transport, binding.surfaceId, operation.name, contractVersion,
            currentHash]);
          if (includePredecessorInventory) {
            legacyImplementations.forEach((implementationHash, index) => {
              const hash = legacyHash(contract, implementationHash, true);
              legacyRows[index] ??= [];
              legacyRows[index].push([binding.transport, binding.surfaceId, operation.name, contractVersion, hash]);
              acceptedLegacy &&= webContracts.isCompatibleWebSessionContractHash(contract, hash, registry);
            });
          }
          rejectedUnknown &&= !webContracts.isCompatibleWebSessionContractHash(
            contract, "f".repeat(64), registry,
          );
        }
      }
    }
  }
}
const predecessorRouteOrder = [
  ["linked-device", "beeper"],
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

async function inventoryForNodeEnv(nodeEnv: string | undefined): Promise<unknown> {
  const environment = { ...process.env };
  if (nodeEnv === undefined) delete environment.NODE_ENV;
  else environment.NODE_ENV = nodeEnv;
  const result = Bun.spawn({
    cmd: [process.execPath, "-e", inventoryProgram],
    cwd: join(import.meta.dir, ".."),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    result.exited,
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `contract inventory child failed for NODE_ENV=${nodeEnv ?? "<unset>"}: ${stderr}`,
    );
  }
  return JSON.parse(stdout);
}

describe("durable provider contract inventory", () => {
  test("preserves every predecessor writer identity across execution modes", async () => {
    const inventories = await Promise.all([
      undefined,
      "test",
      "production",
      "development",
      "staging",
    ].map((nodeEnv) => inventoryForNodeEnv(nodeEnv)));
    for (const inventory of inventories) {
      expect(inventory).toEqual({
        rows: 322,
        sha256: predecessorDefaultInventorySha256,
        currentOnlyRows: 57,
        currentOnlySha256: "03ed31e5bf7d7aaa27c1b1712987bbfe34ce9352d471ceddffb8adbb90931fe3",
        legacyRows: [
          322,
          322,
          322,
          322,
          322,
          322,
          322,
          290,
          290,
          252,
          226,
          185,
          164,
          144,
          144,
          23,
          23,
          23,
        ],
        legacySha256: predecessorLegacyInventorySha256,
        acceptedLegacy: true,
        rejectedUnknown: true,
      });
    }
  });
});
