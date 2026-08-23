import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

const predecessorDefaultInventorySha256 =
  "8faea4bfd80c8f4a6a6ebdd453a1ce7ac4018f98989b20fc62429c77120ab658";
const predecessorLegacyInventorySha256 = [
  "3a93d4561bafcf7aff2d11fe4557c910480f64ca7ca1c118f4687df0b60788c3",
  "8dfab9b00519b25f51408563f4d3e72fc5be1b5ea6e27eca19550d6ea1f21e41",
  "9e638e1bf728130f46d6fd4e5421ffc21f6dc11e864634c15f8a231c4df5e0d0",
  "e02128e3f1fd906dc8ef37d370eb60aec316fee00208d3486b0ad6870d58f620",
  "c0246bf5ae8df9d632176216ed4a00879233e8b421d2adfc7c5b77902de54f7b",
  "74d1f8fbdcb05a000b21aafe5c74462224354b4544322751757e8e597f61c1b7",
  "968c3fa6845549731db7df26d31a098d0d1d2df47ae9d86042531191d5f5dfd2",
  "690d083413be239249da53f38be004a9ffdb2cd31a862a92f749c688a74261b3",
  "9707875cde9b23a8600d8d86dbc13df634585d458f6071b63a9da961f7620c73",
  "a4c7ccb37d286c55ff83b17614fbecd31f9f34d921d5487b92624a91af0f7f95",
  "175b20407f193d0fb413f651e7b92db4acf3e4794fd76f5247e699a38fde9b24",
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
  if ((row[0] === "provider-api" && row[1] === "gmail")
    || (row[0] === "linked-device" && row[1] === "beeper")) {
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
        rows: 308,
        sha256: predecessorDefaultInventorySha256,
        currentOnlyRows: 7,
        currentOnlySha256: "ee4f714b977e75d55f85d41582267eb61b5eed6eb60ed1272739541aa3191c1a",
        legacyRows: [
          308,
          308,
          308,
          308,
          308,
          308,
          308,
          175,
          161,
          161,
          161,
          23,
          23,
          23,
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
