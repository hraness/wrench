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
  IMSG_DIRECT_OPERATION_NAMES,
  IMSG_DIRECT_OPERATIONS,
  IMSG_ORIGIN,
  IMSG_REVIEWED_VERSION,
  IMSG_TOOL_PIN,
  parseImsgDirectOperationInput,
  type ImsgDirectOperationName,
} from "../../providers/imessage-direct";
import { imsgDirectMessagingDefinition } from "../../providers/imessage-direct-messaging";
import {
  materializeImsgMessagingList,
  materializeImsgMessagingRead,
} from "../../providers/imessage-direct-omni";
import imsgManifest from "../../assets/adapters/imessage/wrench-web-adapter.json";

type ManifestOperationProjection = Readonly<{
  input: InputSchema;
  sideEffect: string;
  idempotency: "none" | "local-at-most-once";
  dedupeWindowMs: number;
}>;

const manifestOperations = imsgManifest.operations as unknown as Readonly<
  Record<ImsgDirectOperationName, ManifestOperationProjection>
>;

function omniFor(
  action: ImsgDirectOperationName,
): LocalCliPluginOperationDefinitionV1["omni"] {
  if (action === "messaging.list") {
    return Object.freeze({
      state: "supported" as const,
      schemaVersion: 1 as const,
      materializerId: "imessage-direct-messaging-list",
      materializerVersion: 1,
      materialize: materializeImsgMessagingList,
    });
  }
  if (action === "messaging.read") {
    return Object.freeze({
      state: "supported" as const,
      schemaVersion: 1 as const,
      materializerId: "imessage-direct-messaging-read",
      materializerVersion: 1,
      materialize: materializeImsgMessagingRead,
    });
  }
  return undefined;
}

const operations = Object.freeze(IMSG_DIRECT_OPERATION_NAMES.map((action) => {
  const manifestOperation = manifestOperations[action];
  const policy = IMSG_DIRECT_OPERATIONS[action];
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
    dispatch: policy.effect === "read" ? "none" as const : "single" as const,
    implementation:
      `openclaw/imsg ${IMSG_REVIEWED_VERSION} at ${IMSG_TOOL_PIN.upstreamCommit}+reviewed-${IMSG_TOOL_PIN.reviewedPatchCommit} ${action}; fixed RPC stdin, explicit AppleScript+iMessage, SMS fallback disabled, device-default account selection`,
    planDispatches: (input: OperationInput) => {
      parseImsgDirectOperationInput(action, input);
      return policy.effect === "read"
        ? Object.freeze([])
        : Object.freeze([Object.freeze({ id: action, description: policy.reason })]);
    },
    validateInput: (input: OperationInput) => {
      try {
        parseImsgDirectOperationInput(action, input);
        return Object.freeze([]);
      } catch {
        return Object.freeze([
          `${action} input does not match the reviewed direct-iMessage contract`,
        ]);
      }
    },
    ...(action === "messaging.send"
      ? { reconciliation: Object.freeze({ kind: "provider-accepted-target-presence" as const }) }
      : {}),
    ...(omni === undefined ? {} : { omni }),
  } satisfies LocalCliPluginOperationDefinitionV1);
}));

export const imessageDirectPlugin = defineProviderPlugin({
  apiVersion: 1,
  id: "imessage-direct",
  version: "1.0.0",
  displayName: "iMessage Reviewed Direct Transport",
  sourceKind: "built-in",
  implementationSources: Object.freeze([
    ...providerImplementationEntry(import.meta.url),
    Object.freeze({
      label: "vendor/private-transport.patch",
      url: new URL(
        "./vendor/0001-fix-keep-AppleScript-send-payloads-out-of-child-argv.patch",
        import.meta.url,
      ),
    }),
    Object.freeze({
      label: "vendor/exact-chat-lookup.patch",
      url: new URL(
        "./vendor/0002-feat-rpc-add-exact-chat-lookup.patch",
        import.meta.url,
      ),
    }),
    Object.freeze({
      label: "vendor/provenance.json",
      url: new URL("./vendor/provenance.json", import.meta.url),
    }),
  ]),
  bindings: [{
    transport: "local-cli",
    surfaceId: "imessage",
    origin: IMSG_ORIGIN,
    protectedHostnameFamilies: ["apple.com"],
    authKinds: linkedDeviceAuthKinds,
    tool: {
      schemaVersion: 1,
      id: IMSG_TOOL_PIN.id,
      implementation: IMSG_TOOL_PIN.implementation,
      versionScheme: "semver",
      version: IMSG_TOOL_PIN.version,
      releaseCommit: IMSG_TOOL_PIN.upstreamCommit,
      sourceUrl: IMSG_TOOL_PIN.sourceUrl,
      artifacts: IMSG_TOOL_PIN.artifacts,
    },
    operations,
    subject: {
      format: "imessage:device-default:<sha256-messages-store-coordinate>",
      matches: (value) => /^imessage:device-default:[a-f0-9]{64}$/u.test(value),
    },
    messaging: imsgDirectMessagingDefinition,
    runtime: lazyLocalCliRuntime(async () => {
      const runtime = await import("../../providers/imessage-direct-runtime");
      return {
        inspect: runtime.inspectImsgDirectRuntime,
        probe: runtime.probeImsgDirectSubject,
        execute: (_manifest, recipe, input, auth, options) =>
          runtime.executeImsgDirectOperation(recipe, input, auth, options),
        reconcile: runtime.reconcileImsgDirectOperation,
      };
    }),
  }],
});

export default imessageDirectPlugin;
