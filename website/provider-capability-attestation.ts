import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { generatedProviderPlugins } from "../src/provider-plugins.generated";
import type {
  ProviderPluginBindingV1,
  ProviderPluginContractStateV1,
  ProviderPluginTransport,
  ProviderPluginV1,
} from "../src/provider-plugin";
import type { OperationRisk } from "../src/model";

export const CURRENT_ADAPTER_MANIFEST_FILES = Object.freeze([
  "wrench-adapter.json",
  "wrench-web-adapter.json",
] as const);

export type CurrentAdapterManifestFile = (typeof CURRENT_ADAPTER_MANIFEST_FILES)[number];

export type ProviderCapabilityCompleteness = ProviderPluginContractStateV1;

export type ProviderCapabilityAttestationRow = Readonly<{
  adapterId: string;
  adapterVersion: string;
  completeness: ProviderCapabilityCompleteness;
  contractVersion: number;
  displayName: string;
  kind: "official-api" | "authenticated-web" | "local-cli";
  limit: string;
  operation: string;
  pluginId: string;
  risk: OperationRisk;
  surfaceId: string;
  transport: ProviderPluginTransport;
}>;

export type ProviderCapabilityAttestation = Readonly<{
  adapterCount: number;
  captureRequiredCount: number;
  observedCount: number;
  operationCount: number;
  rows: readonly ProviderCapabilityAttestationRow[];
}>;

const OFFICIAL_ADAPTER_FILE = "wrench-adapter.json" as const;
const operationRisks = Object.freeze(["R1", "R2", "R3", "R4"] as const);
const completenessStates = Object.freeze(["observed", "capture-required"] as const);

function unknownRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function isOperationRisk(value: unknown): value is OperationRisk {
  return typeof value === "string" && (operationRisks as readonly string[]).includes(value);
}

function adapterKind(
  fileName: CurrentAdapterManifestFile,
  transport: ProviderPluginTransport,
): ProviderCapabilityAttestationRow["kind"] {
  if (transport === "local-cli") return "local-cli";
  return fileName === OFFICIAL_ADAPTER_FILE ? "official-api" : "authenticated-web";
}

type AdapterSelectorTransport = "provider-api" | "session-api" | "local-cli";

function transportMatchesAdapter(
  transport: ProviderPluginTransport,
  selectorTransport: AdapterSelectorTransport,
): boolean {
  return selectorTransport === "provider-api"
    ? transport === "provider-api"
    : selectorTransport === "local-cli"
      ? transport === "local-cli"
      : transport === "web-session-api" || transport === "linked-device";
}

function parseCurrentAdapterOperation(
  value: unknown,
  label: string,
  fileName: CurrentAdapterManifestFile,
): Readonly<{
  contractVersion: number;
  description: string;
  risk: OperationRisk;
  selectorTransport: AdapterSelectorTransport;
}> {
  const operation = unknownRecord(value, label);
  const description = requiredString(operation.description, `${label}.description`);
  if (!isOperationRisk(operation.risk)) {
    throw new TypeError(`${label}.risk must be a reviewed operation risk.`);
  }
  const provider = operation.provider;
  const webSession = operation.webSession;
  const localCli = operation.localCli;
  if (fileName === OFFICIAL_ADAPTER_FILE) {
    if (webSession !== undefined || localCli !== undefined) {
      throw new TypeError(`${label} is an official adapter operation and cannot declare webSession or localCli.`);
    }
    const recipe = unknownRecord(provider, `${label}.provider`);
    return Object.freeze({
      contractVersion: requiredSafeInteger(recipe.contractVersion, `${label}.provider.contractVersion`),
      description,
      risk: operation.risk,
      selectorTransport: "provider-api",
    });
  }
  if (provider !== undefined) {
    throw new TypeError(`${label} is an authenticated-web adapter operation and cannot declare provider.`);
  }
  if ((webSession === undefined) === (localCli === undefined)) {
    throw new TypeError(`${label} must declare exactly one webSession or localCli selector.`);
  }
  const recipeName = localCli === undefined ? "webSession" : "localCli";
  const recipe = unknownRecord(
    localCli === undefined ? webSession : localCli,
    `${label}.${recipeName}`,
  );
  return Object.freeze({
    contractVersion: requiredSafeInteger(
      recipe.contractVersion,
      `${label}.${recipeName}.contractVersion`,
    ),
    description,
    risk: operation.risk,
    selectorTransport: localCli === undefined ? "session-api" : "local-cli",
  });
}

export function parseCurrentAdapterManifest(
  value: unknown,
  fileName: CurrentAdapterManifestFile,
  relativePath: string,
): Readonly<{
  displayName: string;
  id: string;
  operations: Readonly<Record<string, Readonly<{
    contractVersion: number;
    description: string;
    risk: OperationRisk;
  }>>>;
  selectorTransport: AdapterSelectorTransport;
  surfaceId: string;
  version: string;
}> {
  const manifest = unknownRecord(value, relativePath);
  const operationsValue = unknownRecord(manifest.operations, `${relativePath}.operations`);
  const operations: Record<string, Readonly<{
    contractVersion: number;
    description: string;
    risk: OperationRisk;
  }>> = {};
  const selectorTransports = new Set<AdapterSelectorTransport>();
  for (const [operationName, operation] of Object.entries(operationsValue)) {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(operationName)) {
      throw new TypeError(`${relativePath}.operations.${operationName} is not a dotted semantic operation.`);
    }
    const parsedOperation = parseCurrentAdapterOperation(
      operation,
      `${relativePath}.operations.${operationName}`,
      fileName,
    );
    selectorTransports.add(parsedOperation.selectorTransport);
    operations[operationName] = Object.freeze({
      contractVersion: parsedOperation.contractVersion,
      description: parsedOperation.description,
      risk: parsedOperation.risk,
    });
  }
  if (Object.keys(operations).length < 1) {
    throw new TypeError(`${relativePath} must declare at least one operation.`);
  }
  if (selectorTransports.size !== 1) {
    throw new TypeError(`${relativePath} cannot mix provider, session, and local CLI selectors.`);
  }
  return Object.freeze({
    displayName: requiredString(manifest.displayName, `${relativePath}.displayName`),
    id: requiredString(manifest.id, `${relativePath}.id`),
    operations: Object.freeze(operations),
    selectorTransport: [...selectorTransports][0]!,
    surfaceId: requiredString(manifest.surfaceId, `${relativePath}.surfaceId`),
    version: requiredString(manifest.version, `${relativePath}.version`),
  });
}

function matchingPluginBinding(
  plugins: readonly ProviderPluginV1[],
  surfaceId: string,
  selectorTransport: AdapterSelectorTransport,
  adapterId: string,
): { readonly binding: ProviderPluginBindingV1; readonly plugin: ProviderPluginV1 } {
  const matches: Array<{ readonly binding: ProviderPluginBindingV1; readonly plugin: ProviderPluginV1 }> = [];
  for (const plugin of plugins) {
    for (const binding of plugin.bindings) {
      if (
        binding.surfaceId === surfaceId
        && transportMatchesAdapter(binding.transport, selectorTransport)
      ) {
        matches.push({ binding, plugin });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `bundled adapter ${adapterId} must match exactly one src/plugins binding for ${surfaceId}; found ${matches.length}`,
    );
  }
  return matches[0]!;
}

function matchingPluginOperation(
  binding: ProviderPluginBindingV1,
  pluginId: string,
  operationName: string,
  contractVersion: number,
  adapterId: string,
): (typeof binding.operations)[number] {
  const matches = binding.operations.filter((operation) =>
    operation.name === operationName && operation.contractVersion === contractVersion);
  if (matches.length !== 1) {
    throw new Error(
      `adapter ${adapterId} operation ${operationName}@${contractVersion} must match exactly one ${pluginId} contract; found ${matches.length}`,
    );
  }
  return matches[0]!;
}

function compareAttestationRows(
  left: ProviderCapabilityAttestationRow,
  right: ProviderCapabilityAttestationRow,
): number {
  return left.adapterId.localeCompare(right.adapterId)
    || left.operation.localeCompare(right.operation);
}

export function escapeAttestationHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function loadProviderCapabilityAttestation(
  repositoryRoot: string,
  plugins: readonly ProviderPluginV1[] = generatedProviderPlugins,
): Promise<ProviderCapabilityAttestation> {
  const adaptersRoot = join(repositoryRoot, "src/assets/adapters");
  const adapterDirectories = (await readdir(adaptersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const rows: ProviderCapabilityAttestationRow[] = [];
  const adapterIds = new Set<string>();

  for (const directory of adapterDirectories) {
    for (const fileName of CURRENT_ADAPTER_MANIFEST_FILES) {
      const relativePath = `src/assets/adapters/${directory}/${fileName}`;
      const absolutePath = join(repositoryRoot, relativePath);
      const file = Bun.file(absolutePath);
      if (!await file.exists()) continue;
      const manifest = parseCurrentAdapterManifest(await file.json(), fileName, relativePath);
      if (adapterIds.has(manifest.id)) {
        throw new Error(`bundled adapter ${manifest.id} is declared more than once.`);
      }
      adapterIds.add(manifest.id);
      const { binding, plugin } = matchingPluginBinding(
        plugins,
        manifest.surfaceId,
        manifest.selectorTransport,
        manifest.id,
      );
      const adapterOperations = Object.keys(manifest.operations).sort((left, right) =>
        left.localeCompare(right));
      const pluginOperationNames = [...new Set(binding.operations.map((operation) => operation.name))]
        .sort((left, right) => left.localeCompare(right));
      if (
        adapterOperations.length !== pluginOperationNames.length
        || adapterOperations.some((operation, index) => operation !== pluginOperationNames[index])
      ) {
        throw new Error(
          `bundled adapter ${manifest.id} operations drifted from plugin ${plugin.id} surface ${manifest.surfaceId}`,
        );
      }
      for (const operationName of adapterOperations) {
        const adapterOperation = manifest.operations[operationName];
        if (adapterOperation === undefined) {
          throw new Error(`bundled adapter ${manifest.id} lost operation ${operationName}`);
        }
        const pluginOperation = matchingPluginOperation(
          binding,
          plugin.id,
          operationName,
          adapterOperation.contractVersion,
          manifest.id,
        );
        if (pluginOperation.risk !== adapterOperation.risk) {
          throw new Error(
            `adapter ${manifest.id} operation ${operationName} risk ${adapterOperation.risk} drifted from plugin ${plugin.id} risk ${pluginOperation.risk}`,
          );
        }
        if (
          pluginOperation.state !== "observed"
          && pluginOperation.state !== "capture-required"
        ) {
          throw new Error(`plugin ${plugin.id} operation ${operationName} has an unattested completeness state`);
        }
        rows.push(Object.freeze({
          adapterId: manifest.id,
          adapterVersion: manifest.version,
          completeness: pluginOperation.state,
          contractVersion: adapterOperation.contractVersion,
          displayName: manifest.displayName,
          kind: adapterKind(fileName, binding.transport),
          limit: adapterOperation.description,
          operation: operationName,
          pluginId: plugin.id,
          risk: adapterOperation.risk,
          surfaceId: manifest.surfaceId,
          transport: binding.transport,
        }));
      }
    }
  }

  if (rows.length < 1) {
    throw new Error("provider capability attestation found no current bundled adapter operations.");
  }

  const pluginBindingKeys = new Set<string>();
  for (const plugin of plugins) {
    for (const binding of plugin.bindings) {
      pluginBindingKeys.add(`${plugin.id}:${binding.surfaceId}:${binding.transport}`);
    }
  }
  const attestedBindingKeys = new Set(rows.map((row) => `${row.pluginId}:${row.surfaceId}:${row.transport}`));
  for (const key of pluginBindingKeys) {
    if (!attestedBindingKeys.has(key)) {
      throw new Error(`plugin binding ${key} has no current bundled public adapter manifest.`);
    }
  }

  rows.sort(compareAttestationRows);
  const frozenRows = Object.freeze(rows);
  return Object.freeze({
    adapterCount: adapterIds.size,
    captureRequiredCount: frozenRows.filter((row) => row.completeness === "capture-required").length,
    observedCount: frozenRows.filter((row) => row.completeness === "observed").length,
    operationCount: frozenRows.length,
    rows: frozenRows,
  });
}

export function renderProviderCapabilityAttestationTable(
  attestation: ProviderCapabilityAttestation,
): string {
  const body = attestation.rows.map((row) => {
    const provider = `${escapeAttestationHtml(row.displayName)} <code>${escapeAttestationHtml(row.adapterId)}</code>`;
    return [
      "<tr>",
      `<th scope="row">${provider}</th>`,
      `<td><code>${escapeAttestationHtml(row.operation)}</code></td>`,
      `<td><code>${escapeAttestationHtml(row.completeness)}</code></td>`,
      `<td>${escapeAttestationHtml(row.limit)}</td>`,
      "</tr>",
    ].join("");
  });
  return [
    "<table>",
    "<thead><tr>",
    '<th scope="col">Provider</th>',
    '<th scope="col">Operation</th>',
    '<th scope="col">Completeness</th>',
    '<th scope="col">Limit</th>',
    "</tr></thead>",
    `<tbody>${body.join("")}</tbody>`,
    "</table>",
  ].join("");
}

export function isProviderCapabilityCompleteness(
  value: string,
): value is ProviderCapabilityCompleteness {
  return (completenessStates as readonly string[]).includes(value);
}

export async function readCurrentAdapterManifestFiles(
  repositoryRoot: string,
): Promise<readonly Readonly<{
  fileName: CurrentAdapterManifestFile;
  relativePath: string;
  value: unknown;
}>[]> {
  const adaptersRoot = join(repositoryRoot, "src/assets/adapters");
  const adapterDirectories = (await readdir(adaptersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const files: Array<Readonly<{
    fileName: CurrentAdapterManifestFile;
    relativePath: string;
    value: unknown;
  }>> = [];
  for (const directory of adapterDirectories) {
    for (const fileName of CURRENT_ADAPTER_MANIFEST_FILES) {
      const relativePath = `src/assets/adapters/${directory}/${fileName}`;
      try {
        files.push(Object.freeze({
          fileName,
          relativePath,
          value: JSON.parse(await readFile(join(repositoryRoot, relativePath), "utf8")) as unknown,
        }));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
  }
  return Object.freeze(files);
}
