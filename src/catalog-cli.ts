import { redactSensitiveText } from "@hraness/kb/clip/persist";
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
} from "@hraness/kb/clip/terminal";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalJson,
  DOM_ACTION_TRANSPORT_DISABLED_MESSAGE,
  isProviderOperation,
  isReviewedTemplateOperation,
  isWebSessionOperation,
  manifestHash,
  sha256,
  type WrenchOperation,
} from "./model";
import {
  getProviderContract,
  providerContractHash,
} from "./provider-contracts";
import type {
  ProviderPluginOperationV1,
  ProviderPluginV1,
} from "./provider-plugin";
import type {
  listPortableProviderPlugins,
  showPortableProviderPlugin,
} from "./provider-plugin-lifecycle";
import type { ProviderPluginRegistry } from "./provider-plugin-registry";
import { providerPluginRegistry } from "./provider-plugins";
import {
  wrenchStateHome,
  listInstalledManifests,
} from "./storage";
import {
  getWebSessionContract,
  webSessionContractHash,
} from "./web-session-contracts";

export type WrenchCatalogCommand =
  | {
      readonly command: "capabilities";
      readonly adapterId?: string;
      readonly json: boolean;
    }
  | { readonly command: "plugin-list"; readonly json: boolean }
  | {
      readonly command: "plugin-show";
      readonly id: string;
      readonly json: boolean;
    };

export type WrenchCatalogOutput = {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
};

const PROVIDER_PLUGIN_TRUST_NOTICE =
  "Provider source plugins are trusted in-process code.";
const PORTABLE_PROVIDER_PLUGIN_TRUST_NOTICE =
  "Portable plugins run as explicitly trusted child-process code; process isolation is not a hostile-code sandbox.";
const PROVIDER_PLUGIN_INSTALLATION_NOTICE =
  "Adapter manifests remain non-executable data selectors; portable executable packages use the separate plugin trust store.";

function safe(value: string): string {
  return sanitizeTerminalLine(redactSensitiveText(value));
}

function safeJson(value: unknown): string {
  return `${JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "string"
      ? sanitizeTerminalText(redactSensitiveText(candidate))
      : candidate, 2)}\n`;
}

function print(
  output: WrenchCatalogOutput,
  value: unknown,
  json: boolean,
): void {
  output.stdout(
    json
      ? safeJson(value)
      : `${safe(
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2),
        )}\n`,
  );
}

function providerPluginTrustBoundary(): Record<string, unknown> {
  return {
    sourceExecution: "trusted-in-process",
    portableExecution: "trusted-child-process",
    sandboxed: false,
    installedExecutablePlugins: true,
    sourceRegistry: "static-source",
    portableRegistry: "private-content-addressed",
    notice: PROVIDER_PLUGIN_TRUST_NOTICE,
    portableNotice: PORTABLE_PROVIDER_PLUGIN_TRUST_NOTICE,
    installationNotice: PROVIDER_PLUGIN_INSTALLATION_NOTICE,
    installedCapabilitiesCommand: "wrench capabilities [adapter]",
  };
}

function providerPluginSummary(
  plugin: ProviderPluginV1,
): Record<string, unknown> {
  const operations: ProviderPluginOperationV1[] = [];
  for (const binding of plugin.bindings) operations.push(...binding.operations);
  return {
    apiVersion: plugin.apiVersion,
    id: plugin.id,
    version: plugin.version,
    displayName: plugin.displayName,
    sourceKind: plugin.sourceKind,
    bindingCount: plugin.bindings.length,
    operationCount: operations.length,
    contractCount: operations.reduce(
      (count, operation) => count + operation.contractVersions.length,
      0,
    ),
    transports: [
      ...new Set(plugin.bindings.map((binding) => binding.transport)),
    ].sort(),
    surfaces: [
      ...new Set(plugin.bindings.map((binding) => binding.surfaceId)),
    ].sort(),
  };
}

function providerPluginView(plugin: ProviderPluginV1): Record<string, unknown> {
  return {
    apiVersion: plugin.apiVersion,
    id: plugin.id,
    version: plugin.version,
    displayName: plugin.displayName,
    sourceKind: plugin.sourceKind,
    implementationSources: plugin.implementationSources.map(
      (source) => source.label,
    ),
    bindings: plugin.bindings.map((binding) => ({
      transport: binding.transport,
      surfaceId: binding.surfaceId,
      origin: binding.origin,
      ...(binding.transport === "provider-api"
        ? { runtimeOrigins: binding.runtimeOrigins }
        : {}),
      manifestOrigins: binding.manifestOrigins,
      protectedHostnameFamilies: binding.protectedHostnameFamilies,
      authKinds: binding.authKinds,
      subject: {
        format: binding.subject.format,
        hasCurrentSubjectProbe: binding.subject.probe !== undefined,
      },
      linkedDeviceLifecycle:
        binding.transport === "linked-device"
        && binding.linkedDeviceLifecycle !== undefined,
      operations: binding.operations.map((operation) => ({
        name: operation.name,
        contractVersions: operation.contractVersions,
        risk: operation.risk,
        state: operation.state,
        validatesSubjectInput: operation.validateSubjectInput !== undefined,
        reconciliation: operation.reconciliation?.kind ?? null,
        omni: operation.omni === undefined
          ? null
          : operation.omni.state === "supported"
            ? {
                state: "supported",
                schemaVersion: operation.omni.schemaVersion,
                materializerId: operation.omni.materializerId,
                materializerVersion: operation.omni.materializerVersion,
              }
            : {
                state: "unsupported",
                reason: operation.omni.reason,
              },
      })),
    })),
  };
}

function renderProviderPluginListText(
  plugins: readonly ProviderPluginV1[],
): string {
  const lines = [
    `Wrench trusted provider source plugins (${plugins.length})`,
    PROVIDER_PLUGIN_TRUST_NOTICE,
    PROVIDER_PLUGIN_INSTALLATION_NOTICE,
  ];
  for (const plugin of plugins) {
    const operationCount = plugin.bindings.reduce(
      (count, binding) => count + binding.operations.length,
      0,
    );
    lines.push(
      `- ${plugin.id} ${plugin.version} (${plugin.displayName}; ${plugin.sourceKind}; ${plugin.bindings.length} binding${plugin.bindings.length === 1 ? "" : "s"}; ${operationCount} operation${operationCount === 1 ? "" : "s"})`,
    );
  }
  lines.push(
    "Run 'wrench plugin show <id>' for routes and implementation ownership.",
    "Run 'wrench capabilities [adapter]' for installed data manifests.",
  );
  return `${lines.join("\n")}\n`;
}

function renderProviderPluginText(plugin: ProviderPluginV1): string {
  const lines = [
    "Wrench provider source plugin",
    `${plugin.displayName} (${plugin.id})`,
    `  API/version: ${plugin.apiVersion}/${plugin.version}`,
    `  Source: ${plugin.sourceKind}; trusted in-process; not sandboxed`,
    "  Implementation sources:",
    ...plugin.implementationSources.map((source) => `    - ${source.label}`),
    "  Bindings:",
  ];
  for (const binding of plugin.bindings) {
    const runtimeOriginLine = binding.transport === "provider-api"
      ? [`      Credential-bearing runtime origins: ${binding.runtimeOrigins.join(", ")}`]
      : [];
    lines.push(
      `    - ${binding.transport}/${binding.surfaceId}`,
      `      Origin: ${binding.origin}`,
      ...runtimeOriginLine,
      `      Manifest origins: ${binding.manifestOrigins.join(", ")}`,
      `      Protected host families: ${binding.protectedHostnameFamilies.join(", ")}`,
      `      Auth: ${binding.authKinds.join(", ")}`,
      `      Subject: ${binding.subject.format}; current-subject probe ${binding.subject.probe === undefined ? "not declared" : "declared"}`,
      `      Operations: ${binding.operations.flatMap((operation) =>
        operation.contractVersions.map(
          (version) => `${operation.name}@${version}`,
        )).join("; ")}`,
    );
  }
  lines.push(
    PROVIDER_PLUGIN_INSTALLATION_NOTICE,
    "Run 'wrench capabilities [adapter]' to inspect installed data manifests.",
  );
  return `${lines.join("\n")}\n`;
}

function renderPortableProviderPluginListText(
  plugins: ReturnType<typeof listPortableProviderPlugins>,
): string {
  const lines = [
    `Wrench installed portable provider plugins (${plugins.length})`,
    PORTABLE_PROVIDER_PLUGIN_TRUST_NOTICE,
  ];
  for (const plugin of plugins) {
    lines.push(
      `- ${plugin.id} ${plugin.version} (${plugin.displayName}; ${plugin.activation}; bundle ${plugin.bundleSha256.slice(0, 16)}…; ${plugin.bindings} binding${plugin.bindings === 1 ? "" : "s"}; ${plugin.operations} operation${plugin.operations === 1 ? "" : "s"})`,
    );
  }
  lines.push(
    "Run 'wrench plugin doctor' to reverify every active package and trust record.",
  );
  return `${lines.join("\n")}\n`;
}

function renderPortableProviderPluginText(
  plugin: NonNullable<ReturnType<typeof showPortableProviderPlugin>>,
): string {
  return [
    "Wrench portable provider plugin",
    `${plugin.summary.displayName} (${plugin.summary.id})`,
    `  Version: ${plugin.summary.version}`,
    `  Activation: ${plugin.summary.activation}`,
    `  Bundle: ${plugin.summary.bundleSha256}`,
    `  Manifest: ${plugin.summary.manifestSha256}`,
    "  Execution: explicitly trusted child process; not a hostile-code sandbox",
    `  Provenance: ${JSON.stringify(plugin.trust.provenance)}`,
    `  Capabilities: ${JSON.stringify(plugin.summary.capabilities)}`,
    `  Bindings: ${plugin.manifest.bindings.map((binding) =>
      `${binding.transport}/${binding.surfaceId}`).join(", ")}`,
    "",
  ].join("\n");
}

function installedOperationTransport(
  operation: WrenchOperation,
): "provider-api" | "web-session-api" | "reviewed-template-api" {
  if (isProviderOperation(operation)) return "provider-api";
  if (isWebSessionOperation(operation)) return "web-session-api";
  if (isReviewedTemplateOperation(operation)) return "reviewed-template-api";
  throw new Error(DOM_ACTION_TRANSPORT_DISABLED_MESSAGE);
}

function reviewedTemplateHash(
  recipe: Extract<WrenchOperation, { readonly reviewedTemplate: unknown }>["reviewedTemplate"],
): string {
  return sha256(canonicalJson(recipe));
}

function listRuntimeManifests(
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): ReturnType<typeof listInstalledManifests> {
  const stored = listInstalledManifests(environment, registry);
  const storedIds = new Set(stored.map((entry) => entry.id));
  const owned = registry.listOwnedManifests();
  const collision = owned.find((manifest) => storedIds.has(manifest.id));
  if (collision !== undefined) {
    throw new Error(
      `adapter ${collision.id} collides with an enabled portable provider plugin`,
    );
  }
  return Object.freeze([
    ...stored,
    ...owned.map((manifest) => Object.freeze({
      id: manifest.id,
      result: Object.freeze({ ok: true as const, value: manifest }),
    })),
  ].sort((left, right) => left.id.localeCompare(right.id)));
}

function capabilitySummary(
  environment: Readonly<Record<string, string | undefined>>,
  registry: ProviderPluginRegistry,
): readonly unknown[] {
  return listRuntimeManifests(environment, registry).map(({ id, result }) =>
    result.ok
      ? {
          id,
          version: result.value.version,
          displayName: result.value.displayName,
          surfaceId: result.value.surfaceId ?? null,
          origins: result.value.origins,
          manifestHash: manifestHash(result.value),
          operations: Object.entries(result.value.operations).map(
            ([operationId, operation]) => {
              const provider = isProviderOperation(operation)
                ? getProviderContract(operation.provider, registry)
                : null;
              const webSession = isWebSessionOperation(operation)
                ? getWebSessionContract(operation.webSession, registry)
                : null;
              const reviewedTemplate = isReviewedTemplateOperation(operation)
                ? operation.reviewedTemplate
                : null;
              return {
                id: operationId,
                description: operation.description,
                risk: operation.risk,
                sideEffect: operation.sideEffect,
                idempotency: operation.idempotency,
                dedupeWindowMs: operation.dedupeWindowMs,
                transport: installedOperationTransport(operation),
                input: operation.input,
                ...(provider === null
                  ? {}
                  : {
                      provider: provider.provider,
                      providerAction: provider.operation,
                      providerContractVersion: provider.contractVersion,
                      providerContractHash: providerContractHash(
                        provider,
                        registry,
                      ),
                      requiredScopeSets: provider.requiredScopeSets,
                      coverage: provider.coverage,
                      implementation: provider.implementation,
                    }),
                ...(webSession === null
                  ? {}
                  : {
                      site: webSession.site,
                      webSessionAction: webSession.operation,
                      webSessionContractVersion: webSession.contractVersion,
                      webSessionContractHash: webSessionContractHash(
                        webSession,
                        registry,
                      ),
                      state: webSession.state,
                      implementation: webSession.implementation,
                    }),
                ...(reviewedTemplate === null
                  ? {}
                  : {
                      state: reviewedTemplate.state,
                      reviewedTemplateContractVersion:
                        reviewedTemplate.contractVersion,
                      reviewedTemplateContractHash:
                        reviewedTemplateHash(reviewedTemplate),
                      ...(reviewedTemplate.state === "capture-required"
                        ? { instructions: reviewedTemplate.instructions }
                        : {
                            reviewedAt: reviewedTemplate.reviewedAt,
                            evidenceSha256: reviewedTemplate.evidenceSha256,
                            origin: reviewedTemplate.template.origin,
                          }),
                    }),
              };
            },
          ),
        }
      : { id, invalid: true, issues: result.issues });
}

export function runCapabilities(
  command: Extract<WrenchCatalogCommand, { readonly command: "capabilities" }>,
  environment: Readonly<Record<string, string | undefined>>,
  output: WrenchCatalogOutput,
  registry: ProviderPluginRegistry,
): number {
  const values = capabilitySummary(environment, registry);
  const selected = command.adapterId === undefined
    ? values
    : values.filter((entry) =>
        typeof entry === "object"
        && entry !== null
        && (entry as { readonly id?: unknown }).id === command.adapterId);
  const found = selected.length > 0 || command.adapterId === undefined;
  print(output, command.json ? { ok: found, adapters: selected } : selected, command.json);
  return found ? 0 : 3;
}

export async function runPluginList(
  command: Extract<WrenchCatalogCommand, { readonly command: "plugin-list" }>,
  environment: Readonly<Record<string, string | undefined>>,
  output: WrenchCatalogOutput,
  registry: ProviderPluginRegistry,
): Promise<number> {
  const { listPortableProviderPlugins } =
    await import("./provider-plugin-lifecycle");
  const sourcePlugins = registry.list();
  const portablePlugins = listPortableProviderPlugins(environment);
  const sourceIds = new Set(sourcePlugins.map((plugin) => plugin.id));
  const collision = portablePlugins.find((plugin) => sourceIds.has(plugin.id));
  if (collision !== undefined) {
    throw new Error(
      `portable plugin ${collision.id} conflicts with a trusted source plugin ID`,
    );
  }
  if (command.json) {
    output.stdout(safeJson({
      ok: true,
      kind: "provider-plugin-list",
      trustBoundary: providerPluginTrustBoundary(),
      plugins: [
        ...sourcePlugins.map((plugin) => ({
          ...providerPluginSummary(plugin),
          execution: "trusted-in-process",
          activation: "source",
        })),
        ...portablePlugins,
      ],
    }));
  } else {
    output.stdout(
      sanitizeTerminalText(
        redactSensitiveText(
          `${renderProviderPluginListText(sourcePlugins)}\n`
          + renderPortableProviderPluginListText(portablePlugins),
        ),
      ),
    );
  }
  return 0;
}

export async function runPluginShow(
  command: Extract<WrenchCatalogCommand, { readonly command: "plugin-show" }>,
  environment: Readonly<Record<string, string | undefined>>,
  output: WrenchCatalogOutput,
  registry: ProviderPluginRegistry,
): Promise<number> {
  const { showPortableProviderPlugin } =
    await import("./provider-plugin-lifecycle");
  const sourcePlugin = registry.get(command.id);
  const portablePlugin = showPortableProviderPlugin(command.id, environment);
  if (sourcePlugin !== undefined && portablePlugin !== null) {
    throw new Error(
      `portable plugin ${command.id} conflicts with a trusted source plugin ID`,
    );
  }
  if (sourcePlugin === undefined && portablePlugin === null) {
    if (command.json) {
      output.stdout(safeJson({
        ok: false,
        kind: "provider-plugin",
        requestedId: command.id,
        trustBoundary: providerPluginTrustBoundary(),
        plugin: null,
      }));
    } else {
      output.stdout(
        `Wrench provider plugin ${safe(command.id)} was not found.\n`
        + "Run 'wrench plugin list' to inspect source and portable plugins.\n",
      );
    }
    return 3;
  }
  if (command.json) {
    output.stdout(safeJson({
      ok: true,
      kind: "provider-plugin",
      trustBoundary: providerPluginTrustBoundary(),
      plugin: sourcePlugin === undefined
        ? portablePlugin
        : providerPluginView(sourcePlugin),
    }));
  } else {
    output.stdout(
      sanitizeTerminalText(
        redactSensitiveText(
          sourcePlugin === undefined
            ? renderPortableProviderPluginText(
                portablePlugin
                  ?? (() => {
                    throw new Error("portable plugin disappeared");
                  })(),
              )
            : renderProviderPluginText(sourcePlugin),
        ),
      ),
    );
  }
  return 0;
}

export async function runWrenchCatalogCommand(
  command: WrenchCatalogCommand,
  environment: Readonly<Record<string, string | undefined>>,
  output: WrenchCatalogOutput,
): Promise<number> {
  try {
    if (command.command === "capabilities") {
      let registry = providerPluginRegistry;
      const storeRoot = join(wrenchStateHome(environment), "provider-plugins");
      if (existsSync(storeRoot)) {
        const { listInstalledPortableProviderPlugins } =
          await import("./provider-plugin-store");
        const installed = listInstalledPortableProviderPlugins(storeRoot);
        if (installed.length > 0) {
          const { createPortableProviderPluginCatalog } =
            await import("./provider-plugin-portable-catalog");
          registry = createPortableProviderPluginCatalog(
            providerPluginRegistry,
            environment,
          ).registry;
        }
      }
      return runCapabilities(command, environment, output, registry);
    }
    if (command.command === "plugin-list") {
      return await runPluginList(
        command,
        environment,
        output,
        providerPluginRegistry,
      );
    }
    return await runPluginShow(
      command,
      environment,
      output,
      providerPluginRegistry,
    );
  } catch (error) {
    output.stderr(
      `wrench: ${safe(error instanceof Error ? error.message : String(error))}\n`,
    );
    return 3;
  }
}
