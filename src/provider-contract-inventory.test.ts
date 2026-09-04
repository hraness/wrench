import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, test } from "bun:test";

const predecessorDefaultInventorySha256 =
  "b880058e5ca81a18f5fc156e2acba18e61a7e4e9e7fcfb7a4155682ee7fbc221";
const predecessorLegacyInventorySha256 = [
  "3b1e1619dcdebafc5260507be7d95e065bdd4bee157695ec423ee06e2ac225e0",
  "89150f597bb4abc3300209d36f3b0fdc0acdc4226fef99bfca5af008302f6ecf",
  "63963bafc15254bb83f9c500a94f9dcfacad03cc245b099cdc5b4f7bd8bfe5b5",
  "1cffc83e83962086b80e51f631e442e35ca136ff2e4051b8f3e763bf5d63a0bc",
  "5cf022fc4df3ad3ec4145d13a75bebee8e7b2b87fbd483c2f4d795fe4297880d",
  "a788d627ee201c4a0e873795fdee3ced0a27c6acbbcecf4e30a4fc611840c2c7",
  "38355278accfb36bf01af77ac114f2f4fd44e9bdc0fa1ce80e8ae03ced6ff1e5",
  "a880146bb5007bf9e3362d63fea0aff0d94b453080a4e29c2e970926e8a0da71",
  "c8de39709bc0d945b56dcd70e8ff42d52feb545f38fa13e683869504a89770ed",
  "2fceb7b0e7d9e44fb712d714c84ab839085b4526cbd08a1f5688c215dc24068f",
  "cca4e2e5546aa972d8aff997caa93c502d77c69ea5d2dca7c75d5b06f891cf6d",
  "4327d8c3c07fa8857b6c275a79704e40c5ccd334fa212635116d5791a1e4dac4",
  "ae49b1cb8c914735b7e2141a4d9b2f21158f7c300b0895f955f77ca692aaa5cf",
  "d70a1666c24b6d7407c5fa3b66645e670c9a1165a99dd8524e1e6dd777e2c5f6",
  "9229e0c770017dcb9a2b5dea265caa0560e30dd712653b719778f34a8daf128f",
  "c8dc5992def28e208bf4fe4185d0d0cdc800e4c9dc87c133995a9cddc8bb714c",
  "5349a06bea9f407b56df8181aeaa4d657b4084ad51c4a44cdfd3447f611ab07c",
  "9e09a3d3fa10ccb12f9112d8911e758f61bb65a6b62611585de4fff630d08a12",
  "22279cdc6808087045201d6c29ae7aca7d9c280ce660276236c759846bb64620",
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
          const legacyImplementations = registry.legacyContractImplementationHashes(
            binding,
            operation.name,
            contractVersion,
          );
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
        rows: 323,
        sha256: predecessorDefaultInventorySha256,
        currentOnlyRows: 53,
        currentOnlySha256: "65c204bc77b831ea75cd8514d7d083b128feb5e1fa995075476b4b0d5e4c8656",
        legacyRows: [
          323,
          323,
          323,
          323,
          323,
          323,
          323,
          291,
          291,
          253,
          227,
          186,
          165,
          145,
          145,
          145,
          24,
          24,
          24,
        ],
        legacySha256: predecessorLegacyInventorySha256,
        acceptedLegacy: true,
        rejectedUnknown: true,
      });
    }
  });
});
