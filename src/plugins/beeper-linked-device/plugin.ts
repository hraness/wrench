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
  parseBeeperOperationInput,
  type BeeperLocalOperationName,
} from "../../providers/beeper-local";
import {
  materializeBeeperMessagingList,
  materializeBeeperMessagingRead,
} from "../../providers/beeper-omni";
import beeperManifest from "../../assets/adapters/beeper/wrench-web-adapter.json";

type ManifestOperationProjection = Readonly<{
  input: InputSchema;
  sideEffect: string;
  idempotency: "none" | "local-at-most-once";
  dedupeWindowMs: number;
}>;

const manifestOperations = beeperManifest.operations as unknown as Readonly<
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
  "conversations.priority.set",
  "conversations.title.set",
  "conversations.description.set",
  "conversations.avatar.set",
  "conversations.draft.set",
  "conversations.disappearing.set",
  "conversations.read-state.set",
  "conversations.reminder.set",
]);

function validateBeeperInput(
  action: BeeperLocalOperationName,
  input: OperationInput,
): readonly string[] {
  try {
    parseBeeperOperationInput(action, input);
    return Object.freeze([]);
  } catch {
    return Object.freeze([`${action} input does not match the pinned Beeper CLI contract`]);
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
      materializerVersion: 2,
      materialize: materializeBeeperMessagingRead,
    });
  }
  return undefined;
}

const operations = Object.freeze(BEEPER_LOCAL_OPERATION_NAMES.map((action) => {
  const manifestOperation = manifestOperations[action];
  const policy = BEEPER_LOCAL_OPERATIONS[action];
  const reconciliation = reconciliationFor(action);
  const omni = omniFor(action);
  return Object.freeze({
    name: action,
    contractVersion: 1,
    risk: policy.risk,
    input: manifestOperation.input,
    sideEffect: manifestOperation.sideEffect,
    idempotency: manifestOperation.idempotency,
    dedupeWindowMs: manifestOperation.dedupeWindowMs,
    state: "observed" as const,
    dispatch: policy.effect === "read"
      ? "none" as const
      : action === "presence.set" ? "bounded-items" as const : "single" as const,
    implementation:
      `official Beeper CLI ${BEEPER_CLI_PIN.version} over ${BEEPER_DESKTOP_API_PIN.package}@${BEEPER_DESKTOP_API_PIN.version}+${BEEPER_DESKTOP_API_PIN.commit} ${action} with exact input, target, realm, output, and dispatch binding`,
    planDispatches: (input: OperationInput) => {
      const parsed = parseBeeperOperationInput(action, input);
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
    validateInput: (input: OperationInput) => validateBeeperInput(action, input),
    ...(reconciliation === undefined ? {} : { reconciliation }),
    ...(omni === undefined ? {} : { omni }),
  } satisfies LocalCliPluginOperationDefinitionV1);
}));

export const beeperLinkedDevicePlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "beeper-linked-device",
  version: "2.0.0",
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
    runtime: lazyLocalCliRuntime(async () => {
      const runtime = await import("../../providers/beeper-local-runtime");
      return {
        inspect: runtime.inspectBeeperLocalRuntime,
        probe: runtime.probeBeeperLocalSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeBeeperLocalOperation(recipe, input, auth, options),
        reconcile: runtime.reconcileBeeperLocalOperation,
      };
    }),
  }],
});

export default beeperLinkedDevicePlugin;
