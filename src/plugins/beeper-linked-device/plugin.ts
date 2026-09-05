import {
  defineProviderPlugin,
  lazyLocalCliRuntime,
  type LocalCliPluginOperationDefinitionV1,
} from "../../provider-plugin";
import {
  linkedDeviceAuthKinds,
  providerImplementationEntry,
} from "../../provider-plugin-builtins";
import type { InputSchema, OperationInput } from "../../model";
import {
  BEEPER_CLI_PIN,
  BEEPER_DESKTOP_API_PIN,
  BEEPER_LOCAL_OPERATION_NAMES,
  BEEPER_LOCAL_OPERATIONS,
  parseBeeperOperationInputForContract,
  type BeeperLocalOperationContractVersion,
  type BeeperLocalOperationName,
} from "../../providers/beeper-local";
import {
  materializeBeeperMessagingList,
  materializeBeeperMessagingRead,
  materializeBeeperMessagingReadV1,
  materializeBeeperMessagingReadV2,
} from "../../providers/beeper-omni";
import { beeperMessagingDefinition } from "../../providers/beeper-messaging";
import beeperManifest from "../../assets/adapters/beeper/wrench-web-adapter.json";
import cliV2BeeperManifest from "../../assets/adapters/beeper/wrench-web-adapter.v2.3.0.json";
import predecessorBeeperManifest from "../../assets/adapters/beeper/wrench-web-adapter.v2.2.0.json";
import legacyBeeperManifest from "../../assets/adapters/beeper/wrench-web-adapter.v2.0.0.json";

type ManifestOperationProjection = Readonly<{
  input: InputSchema;
  sideEffect: string;
  idempotency: "none" | "local-at-most-once";
  dedupeWindowMs: number;
  localCli: Readonly<{
    surface: string;
    action: string;
    contractVersion: number;
  }>;
}>;

const manifestOperations = beeperManifest.operations as unknown as Readonly<
  Record<BeeperLocalOperationName, ManifestOperationProjection>
>;
const predecessorManifestOperations = predecessorBeeperManifest.operations as unknown as Readonly<
  Record<BeeperLocalOperationName, ManifestOperationProjection>
>;
const cliV2ManifestOperations = cliV2BeeperManifest.operations as unknown as Readonly<
  Record<BeeperLocalOperationName, ManifestOperationProjection>
>;
const legacyManifestOperations = legacyBeeperManifest.operations as unknown as Readonly<
  Record<BeeperLocalOperationName, ManifestOperationProjection>
>;

const booleanDesiredKeys = Object.freeze({
  "reactions.set": "enabled",
  "conversations.archive.set": "enabled",
  "conversations.pin.set": "enabled",
  "conversations.mute.set": "enabled",
} as const satisfies Partial<Record<BeeperLocalOperationName, string>>);

const exactDesiredReadbacks = new Set<BeeperLocalOperationName>([
  "messaging.edit",
  "conversations.read-state.set",
  "conversations.priority.set",
  "conversations.title.set",
  "conversations.description.set",
  "conversations.avatar.set",
  "conversations.draft.set",
  "conversations.disappearing.set",
  "conversations.reminder.set",
]);

const BEEPER_DIRECT_READ_OPERATION_NAMES = Object.freeze([
  "accounts.list",
  "messaging.search",
  "conversations.read",
  "messaging.read",
  "messaging.content.search",
] as const satisfies readonly BeeperLocalOperationName[]);

const BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES = Object.freeze([
  "bridges.list",
  "contacts.list",
] as const satisfies readonly BeeperLocalOperationName[]);

function validateBeeperInput(
  action: BeeperLocalOperationName,
  contractVersion: BeeperLocalOperationContractVersion,
  input: OperationInput,
): readonly string[] {
  try {
    parseBeeperOperationInputForContract(action, contractVersion, input);
    return Object.freeze([]);
  } catch {
    return Object.freeze([
      `${action} input does not match the pinned Beeper ${
        contractVersion === 1
        || contractVersion === 2
          && BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES.includes(
            action as typeof BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES[number],
          )
          ? "CLI"
          : "Desktop direct-read"
      } contract`,
    ]);
  }
}

function reconciliationFor(
  action: BeeperLocalOperationName,
): LocalCliPluginOperationDefinitionV1["reconciliation"] {
  if (action === "messaging.send" || action === "conversations.start") {
    return Object.freeze({ kind: "provider-accepted-target-presence" as const });
  }
  const booleanKey = booleanDesiredKeys[action as keyof typeof booleanDesiredKeys];
  if (booleanKey !== undefined) {
    return Object.freeze({
      kind: "boolean-desired-state" as const,
      desiredState: (input: OperationInput): boolean => {
        const value = input[booleanKey];
        if (typeof value !== "boolean") {
          throw new Error(`${action} reconciliation requires one boolean desired state`);
        }
        return value;
      },
    });
  }
  if (exactDesiredReadbacks.has(action)) {
    return Object.freeze({
      kind: "boolean-desired-state" as const,
      desiredState: (): boolean => true,
    });
  }
  return undefined;
}

function omniFor(
  action: BeeperLocalOperationName,
  contractVersion: BeeperLocalOperationContractVersion,
): LocalCliPluginOperationDefinitionV1["omni"] {
  if (action === "messaging.list") {
    return Object.freeze({
      state: "supported" as const,
      schemaVersion: 1 as const,
      materializerId: "beeper-messaging-list",
      materializerVersion: 2,
      materialize: materializeBeeperMessagingList,
    });
  }
  if (action === "messaging.read") {
    return Object.freeze({
      state: "supported" as const,
      schemaVersion: 1 as const,
      materializerId: "beeper-messaging-read",
      materializerVersion: contractVersion === 3 ? 5 : 2,
      materialize: contractVersion === 3
        ? materializeBeeperMessagingRead
        : contractVersion === 2
          ? materializeBeeperMessagingReadV2
          : materializeBeeperMessagingReadV1,
    });
  }
  return undefined;
}

function operationDefinition(
  action: BeeperLocalOperationName,
  contractVersion: BeeperLocalOperationContractVersion,
): LocalCliPluginOperationDefinitionV1 {
  const manifestOperation = contractVersion === 1
    ? legacyManifestOperations[action]
    : contractVersion === 2
      && BEEPER_DIRECT_READ_OPERATION_NAMES.includes(
        action as typeof BEEPER_DIRECT_READ_OPERATION_NAMES[number],
      )
      ? predecessorManifestOperations[action]
      : contractVersion === 2
        && BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES.includes(
          action as typeof BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES[number],
        )
        ? cliV2ManifestOperations[action]
        : manifestOperations[action];
  if (
    manifestOperation.localCli.surface !== "beeper"
    || manifestOperation.localCli.action !== action
    || manifestOperation.localCli.contractVersion !== contractVersion
  ) {
    throw new Error(
      `Beeper manifest contract drifted for ${action}@${String(contractVersion)}`,
    );
  }
  const policy = BEEPER_LOCAL_OPERATIONS[action];
  const reconciliation = reconciliationFor(action);
  const omni = omniFor(action, contractVersion);
  return Object.freeze({
    name: action,
    contractVersion,
    risk: policy.risk,
    input: manifestOperation.input,
    sideEffect: manifestOperation.sideEffect,
    idempotency: manifestOperation.idempotency,
    dedupeWindowMs: manifestOperation.dedupeWindowMs,
    state: "observed" as const,
    dispatch: policy.effect === "read"
      ? "none" as const
      : action === "presence.set" ? "bounded-items" as const : "single" as const,
    implementation: contractVersion === 1
      || contractVersion === 2
        && BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES.includes(
          action as typeof BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES[number],
        )
      ? `official Beeper CLI ${BEEPER_CLI_PIN.version} over ${BEEPER_DESKTOP_API_PIN.package}@${BEEPER_DESKTOP_API_PIN.version}+${BEEPER_DESKTOP_API_PIN.commit} ${action} with exact input, target, realm, output, and dispatch binding`
      : `official ${BEEPER_DESKTOP_API_PIN.package}@${BEEPER_DESKTOP_API_PIN.version}+${BEEPER_DESKTOP_API_PIN.commit} fixed Beeper Desktop loopback read for ${action} with exact input, target, realm, bounded output, and no CLI or transport fallback`,
    planDispatches: (input: OperationInput) => {
      const parsed = parseBeeperOperationInputForContract(
        action,
        contractVersion,
        input,
      );
      if (policy.effect === "read") return Object.freeze([]);
      const count = action === "presence.set"
        && "durationSeconds" in parsed
        && parsed.durationSeconds !== null
        ? 2
        : 1;
      return Object.freeze(Array.from({ length: count }, (_unused, index) =>
        Object.freeze({
          id: count === 1 ? action : `${action}[${index + 1}]`,
          description: action === "presence.set" && index === 1
            ? "Send the separately journaled paused indication after the confirmed bounded delay"
            : policy.reason,
        })));
    },
    validateInput: (input: OperationInput) =>
      validateBeeperInput(action, contractVersion, input),
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(omni === undefined ? {} : { omni }),
  } satisfies LocalCliPluginOperationDefinitionV1);
}

const operations = Object.freeze([
  ...BEEPER_LOCAL_OPERATION_NAMES.map((action) =>
    operationDefinition(action, 1)),
  ...BEEPER_DIRECT_READ_OPERATION_NAMES.map((action) =>
    operationDefinition(action, 2)),
  ...BEEPER_CLI_CONTRACT_V2_OPERATION_NAMES.map((action) =>
    operationDefinition(action, 2)),
  operationDefinition("messaging.read", 3),
  operationDefinition("contacts.list", 3),
]);

export const beeperLinkedDevicePlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "beeper-linked-device",
  version: "2.4.0",
  displayName: "Beeper Pinned Local CLI",
  sourceKind: "built-in",
  implementationSources: providerImplementationEntry(import.meta.url),
  bindings: [{
    transport: "local-cli",
    surfaceId: "beeper",
    origin: "https://www.beeper.com",
    protectedHostnameFamilies: ["beeper.com"],
    authKinds: linkedDeviceAuthKinds,
    tool: {
      schemaVersion: 1,
      id: BEEPER_CLI_PIN.id,
      implementation: BEEPER_CLI_PIN.implementation,
      versionScheme: "semver",
      version: BEEPER_CLI_PIN.version,
      releaseCommit: BEEPER_CLI_PIN.commit,
      releaseManifestSha256: BEEPER_CLI_PIN.releaseManifestSha256,
      releaseManifestUrl: BEEPER_CLI_PIN.releaseManifestUrl,
      sourceUrl: BEEPER_CLI_PIN.sourceUrl,
      artifacts: BEEPER_CLI_PIN.artifacts,
    },
    operations,
    subject: {
      format: "beeper:local:<sha256-account-and-desktop-target-coordinate>",
      matches: (value) => /^beeper:local:[a-f0-9]{64}$/u.test(value),
    },
    messaging: beeperMessagingDefinition,
    runtime: lazyLocalCliRuntime(async () => {
      const runtime = await import("../../providers/beeper-local-runtime");
      return {
        inspect: runtime.inspectBeeperLocalRuntime,
        probe: runtime.probeBeeperLocalSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeBeeperLocalOperation(recipe, input, auth, options),
        executeMessagingPart: (operation, input, auth, attempt) => {
          if (operation !== "messaging.send") {
            throw new Error("Beeper direct messaging runtime accepts only messaging.send");
          }
          return runtime.executeBeeperDirectMessagingPart(input, auth, {
            beforeExternalBegin: attempt.beforeExternalBegin,
            operationDeadline: attempt.operationDeadline,
            signal: attempt.signal,
            environment: attempt.environment,
          });
        },
        reconcile: runtime.reconcileBeeperLocalOperation,
      };
    }),
  }],
});

export default beeperLinkedDevicePlugin;
