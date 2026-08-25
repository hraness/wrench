import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

const predecessorDefaultInventorySha256 =
  "fcbdcd3d695cf3bc7c193d60c56ca138596943bb200e6a7c3a8980b599182e24";
const predecessorLegacyInventorySha256 = [
  "262fb072dd209c64177f5c8c379e9d84bc29bb231891dc198058c150cd5f776c",
  "58d9cc498492c4959e964a9b7d3955f28f832607478e809b9f42e402ca5258c6",
  "650d771c0aad9425a3e2160ed091d0c2532f87192542521d19c7638bc3da3b34",
  "582b7270e83d660f012cda9558ca9f41fa805fc604aed8664b2332dd4eb57349",
  "aa417d0145de77a23689af2c5553f824a3e62911063e06f5fa135108d0714c96",
  "c92c8db1756ee969231ebb741365b04f5d2a1f5bb0cfbfc39698a3350cefecb1",
  "76803d77e4499b9ccbb8de9566b4a268a21f8b78bd74e942c1402dbd26c384df",
  "6658d53bb5890c3dea9c7e2c6985876fb04c2c5e286b5fed0b49fce4523a4fe8",
  "816053f54ce88d4c08f605903f414d096630ed386feca8bb5c87d8c60f0cb1fc",
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
function isCurrentOnlyRow(row) {
  return (row[0] === "provider-api" && row[1] === "gmail")
    || (row[0] === "linked-device" && row[1] === "beeper")
    || (row[0] === "web-session-api" && row[1] === "github");
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
          const legacyImplementations = registry.legacyContractImplementationHashes(binding);
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
        } else {
          const contract = webContracts.getWebSessionContract({
            site: binding.surfaceId,
            action: operation.name,
            contractVersion,
            timeoutMs: 60_000,
            maxOutputBytes: 2 * 1024 * 1024,
          }, registry);
          const includePredecessorInventory = appendCurrentRow([binding.transport, binding.surfaceId, operation.name, contractVersion,
            webContracts.webSessionContractHash(contract, registry)]);
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
        rows: 317,
        sha256: predecessorDefaultInventorySha256,
        currentOnlyRows: 9,
        currentOnlySha256: "adc3292c16a1280f286637cc4e837378924a86d3440ffd1200b7a0dbec041265",
        legacyRows: [
          317,
          317,
          317,
          317,
          317,
          317,
          317,
          226,
          226,
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
