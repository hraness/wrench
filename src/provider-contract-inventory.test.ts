import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

const predecessorDefaultInventorySha256 =
  "9a122f221a78f13461d39613edf24fd4ff5c7e8417697a20244a4abc5d9692f4";
const predecessorLegacyInventorySha256 = [
  "56b3c5a04a779f3296d116553cda5131de6a7b9d0a1c8be940ced272ee1c13ea",
  "6e7e85e46058ba3e5accd77cd72c4f2dc096a4ce0a4739b84738f0aeba70910d",
  "00043989bf01cd091e047b37f1cd93a5a5fbc3580d24901f7d4739bad2f82e9c",
  "856e4e4c944aa79ae5dbacb748b774478961d0e0d2c11f983155183d53c90c28",
  "a80f67a25a66525902069d58463fb741b13a1e96036b0aee8966519d2dae1f37",
  "46f0ce3b81f50058f542efbe8e84a3c3842c6bda2fc7a610e2a314ad0f3eca80",
  "18b599bdb7691f096e351b2105d10a3ff82ff43f430f5b68f8db22716b717850",
  "16b4110baec0154d421c8a125ac7aab1a6291e59b5b9f84280c383fd05e90688",
  "aba5332a8ed9023eb6c13dfeec8e10320d77a425414ebc3985926d0426e2b7be",
  "c04ff1a21d0654f6b0a457b489ac283576f31d5ade2b4669477b7418c32c40ef",
  "9042345e1a39033a0dcafa8afd1646801487d18c5a14af39f23b9e2bed500abc",
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
        legacyRows: [
          307,
          307,
          307,
          307,
          307,
          307,
          307,
          174,
          160,
          160,
          160,
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
